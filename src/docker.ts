import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { errorMessage, imageName } from './config.js';
import type {
  AgentConfig,
  DockerDeps,
  ExecFn,
  ExecOptions,
  ExecResult,
} from './types.js';

// Two-stage local image build (PLAN.md §5). The base is versioned so a package
// upgrade (new tag) naturally rebuilds; the optional overlay layers a project's
// root/system deps on top. All docker invocations run through the exec seam.

// realExec rejects when the binary cannot be spawned (ENOENT: docker not
// installed / not on PATH). Convert that into a typed, actionable error so
// doctor renders it as a status line and launch/clean print one line and exit 1
// instead of crashing with an unhandled-rejection stack trace.
export class DockerUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `docker is not available (${errorMessage(cause)}) — install Docker and make sure it is on your PATH (https://docs.docker.com/get-started/get-docker/)`,
    );
    this.name = 'DockerUnavailableError';
  }
}

// Every docker invocation goes through here (build/inspect/ps/rm/run).
export async function dockerExec(
  exec: ExecFn,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  try {
    return await exec('docker', args, options);
  } catch (cause) {
    throw new DockerUnavailableError(cause);
  }
}

// The npm package's own docker/ directory, resolved relative to THIS module so
// it works from dist/ in an npx install. Injected into DockerDeps as
// `packageDockerDir` so tests can point it anywhere.
export function packageDockerDir(): string {
  return fileURLToPath(new URL('../docker', import.meta.url));
}

export function baseTag(version: string): string {
  return `agentic-coding-base:${version}`;
}

// The overlay tag carries a content hash of the build context (issue #8 P2):
// an unchanged .agent/ resolves to a tag that already exists, so the
// per-launch `docker build` (context send + cache walk, even when fully
// cached) collapses to one `docker image inspect`. Edits change the hash →
// a new tag → a rebuild, preserving the pick-up-edits contract exactly. The
// engine version stays in the tag so engine upgrades rebuild too. Without a
// hash (context unreadable) the bare versioned tag keeps the always-build
// behavior.
export function overlayTag(
  project: string,
  version: string,
  contextHash?: string,
): string {
  return `${imageName(project)}:${version}${
    contextHash === undefined ? '' : `-${contextHash}`
  }`;
}

// Deterministic content hash of a directory tree: sorted relative paths +
// file bytes (never mtimes, so it is stable across clones). File symlinks
// hash their target's content via readFileSync-follows; anything unreadable
// (broken/dir symlink, missing dir) returns undefined and the caller falls
// back to always-build — a hashing failure must never wrongly SKIP a build.
export function hashDirectory(dir: string): string | undefined {
  try {
    const files: string[] = [];
    const walk = (rel: string): void => {
      const entries = readdirSync(rel === '' ? dir : join(dir, rel), {
        withFileTypes: true,
      }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(relPath);
        } else {
          files.push(relPath);
        }
      }
    };
    walk('');
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(file);
      hash.update('\0');
      hash.update(readFileSync(join(dir, file)));
      hash.update('\0');
    }
    return hash.digest('hex').slice(0, 12);
  } catch {
    return undefined;
  }
}

export function overlayDockerfilePath(cwd: string): string {
  return join(cwd, '.agent', 'Dockerfile');
}

export function overlayContextDir(cwd: string): string {
  return join(cwd, '.agent');
}

export function hasOverlay(deps: DockerDeps): boolean {
  return deps.fileExists(overlayDockerfilePath(deps.cwd));
}

// --- Pure argv builders (golden-tested) -----------------------------------

export function inspectArgs(tag: string): string[] {
  return ['image', 'inspect', tag];
}

// Every image this tool builds carries this label so its artifacts stay
// enumerable/filterable (retention can still match pre-label images by their
// deterministic repo names).
export const MANAGED_LABEL = 'agentic-coding.managed=1';

// `--pull --no-cache` is added only for `agent clean`, which deliberately
// rebuilds from scratch so the baked CLIs don't freeze at first-build latest.
export function buildArgs(
  context: string,
  tag: string,
  fresh = false,
): string[] {
  return [
    'build',
    ...(fresh ? ['--pull', '--no-cache'] : []),
    '--label',
    MANAGED_LABEL,
    '-t',
    tag,
    context,
  ];
}

// No `--pull` here: BASE is always a local-only tag (see baseTag), never a
// registry image, so `--pull` would make Docker try to resolve it from
// Docker Hub and fail with "pull access denied". `--no-cache` alone is
// enough to force a fresh overlay layer.
export function overlayBuildArgs(
  context: string,
  tag: string,
  base: string,
  fresh = false,
): string[] {
  return [
    'build',
    ...(fresh ? ['--no-cache'] : []),
    '--label',
    MANAGED_LABEL,
    '--build-arg',
    `BASE=${base}`,
    '-t',
    tag,
    context,
  ];
}

// THE label-scoping bug fix (PLAN.md §2): filter on this project's label AND
// status=exited, so cleaning one project never rm's another's kept containers.
export function cleanListArgs(project: string): string[] {
  return [
    'ps',
    '-aq',
    '--filter',
    `label=agentic-coding.project=${project}`,
    '--filter',
    'status=exited',
  ];
}

export function cleanRmArgs(ids: string[]): string[] {
  return ['rm', ...ids];
}

// --- Orchestration --------------------------------------------------------

export async function imagePresent(
  deps: DockerDeps,
  tag: string,
): Promise<boolean> {
  const result = await dockerExec(deps.exec, inspectArgs(tag), {
    stdio: 'pipe',
  });
  return result.code === 0;
}

// Build the base only when its versioned tag is missing (an engine/package
// upgrade changes the tag → rebuild). Prints the first-build vs cached
// distinction like news does.
export async function ensureBaseImage(
  deps: DockerDeps,
  version: string,
): Promise<number> {
  const tag = baseTag(version);
  if (await imagePresent(deps, tag)) {
    deps.err(`Base image ${tag} present (cached).\n`);
    return 0;
  }
  deps.err(
    `Building base image ${tag} for the first time (node/git/gh/gitleaks/claude/codex/uv). One-time cost of a few minutes; later runs reuse the Docker cache.\n`,
  );
  const result = await dockerExec(
    deps.exec,
    buildArgs(deps.packageDockerDir, tag),
    { stdio: 'inherit' },
  );
  return result.code ?? 1;
}

// If a `.agent/Dockerfile` exists, resolve the overlay: the content-hashed
// tag already existing means .agent/ is unchanged since that build → skip
// (issue #8 P2); otherwise build it (edits and engine upgrades land on new
// tags). Without a hash, fall back to building every launch as before.
// `hashContext` is injectable so unit tests never touch the real fs.
export async function ensureOverlayImage(
  deps: DockerDeps,
  config: AgentConfig,
  version: string,
  hashContext: (dir: string) => string | undefined = hashDirectory,
): Promise<{ code: number; image: string }> {
  const base = baseTag(version);
  if (!hasOverlay(deps)) {
    return { code: 0, image: base };
  }
  const hash = hashContext(overlayContextDir(deps.cwd));
  const tag = overlayTag(config.project, version, hash);
  if (hash !== undefined && (await imagePresent(deps, tag))) {
    deps.err(`Overlay image ${tag} present (cached — .agent/ unchanged).\n`);
    return { code: 0, image: tag };
  }
  deps.err(`Building overlay image ${tag} from .agent/Dockerfile...\n`);
  const result = await dockerExec(
    deps.exec,
    overlayBuildArgs(overlayContextDir(deps.cwd), tag, base),
    { stdio: 'inherit' },
  );
  return { code: result.code ?? 1, image: tag };
}

// Split a `docker ps -q` blob into ids.
function parseIds(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// `agent clean`: remove THIS project's exited containers (label-scoped), then
// rebuild base + overlay from scratch (--pull --no-cache).
export async function clean(
  deps: DockerDeps,
  config: AgentConfig,
  version: string,
  hashContext: (dir: string) => string | undefined = hashDirectory,
): Promise<number> {
  const listed = await dockerExec(deps.exec, cleanListArgs(config.project), {
    stdio: 'pipe',
  });
  const ids = parseIds(listed.stdout);
  if (ids.length > 0) {
    await dockerExec(deps.exec, cleanRmArgs(ids), { stdio: 'inherit' });
  } else {
    deps.out(`no exited containers for ${config.project}\n`);
  }

  deps.err(`Rebuilding base image ${baseTag(version)} (--pull --no-cache)...\n`);
  const baseBuild = await dockerExec(
    deps.exec,
    buildArgs(deps.packageDockerDir, baseTag(version), true),
    { stdio: 'inherit' },
  );
  if ((baseBuild.code ?? 1) !== 0) {
    return baseBuild.code ?? 1;
  }
  if (hasOverlay(deps)) {
    const overlay = await dockerExec(
      deps.exec,
      overlayBuildArgs(
        overlayContextDir(deps.cwd),
        overlayTag(
          config.project,
          version,
          hashContext(overlayContextDir(deps.cwd)),
        ),
        baseTag(version),
        true,
      ),
      { stdio: 'inherit' },
    );
    return overlay.code ?? 1;
  }
  return 0;
}

// --- doctor Disk section ----------------------------------------------------

// Kept containers for this project, with status (which carries the age) and
// on-disk size (`-s`).
export function diskContainersArgs(project: string): string[] {
  return [
    'ps',
    '-as',
    '--filter',
    `label=agentic-coding.project=${project}`,
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Size}}',
  ];
}

// Every locally-kept tag of one of this tool's image repos, with its size.
export function diskImagesArgs(repo: string): string[] {
  return ['images', repo, '--format', '{{.Repository}}:{{.Tag}}\t{{.Size}}'];
}

// `docker system df -v` is the only way to read volume sizes; the template
// narrows the output to just the volumes array, as JSON.
export function diskVolumesArgs(): string[] {
  return ['system', 'df', '-v', '--format', '{{json .Volumes}}'];
}

export function diskContainerLines(stdout: string): string[] {
  const rows = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (rows.length === 0) {
    return ['containers  (none kept)'];
  }
  return rows.map((row) => `container   ${row.split('\t').join(' — ')}`);
}

export function diskImageLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((row) => `image       ${row.split('\t').join(' — ')}`);
}

// Docker reports sizes in decimal units; match that here.
function humanBytes(n: number): string {
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(1)}GB`;
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}MB`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}kB`;
  }
  return `${n}B`;
}

// One line per cache volume this config mounts. The df JSON differs by docker
// version: API structs carry byte counts under UsageData.Size, CLI-formatted
// rows a human string under Size — read whichever is there.
export function diskVolumeLines(stdout: string, names: string[]): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    return ['volumes     (sizes unavailable — run `docker system df -v`)'];
  }
  const rows = parsed as {
    Name?: unknown;
    Size?: unknown;
    UsageData?: { Size?: unknown } | null;
  }[];
  return names.map((name) => {
    const row = rows.find((r) => r.Name === name);
    if (row === undefined) {
      return `volume      ${name} — (not created)`;
    }
    const usage = row.UsageData;
    const size =
      typeof usage === 'object' &&
      usage !== null &&
      typeof usage.Size === 'number'
        ? humanBytes(usage.Size)
        : typeof row.Size === 'string'
          ? row.Size
          : '?';
    return `volume      ${name} — ${size}`;
  });
}

// --- doctor Images section ------------------------------------------------

export async function baseStatusLine(
  deps: DockerDeps,
  version: string,
): Promise<string> {
  const tag = baseTag(version);
  const present = await imagePresent(deps, tag);
  return `base     ${tag} — ${present ? 'present' : 'missing'}`;
}

export async function overlayStatusLine(
  deps: DockerDeps,
  config: AgentConfig,
  version: string,
  hashContext: (dir: string) => string | undefined = hashDirectory,
): Promise<string> {
  if (!hasOverlay(deps)) {
    return 'overlay  (none — .agent/Dockerfile absent; base used directly)';
  }
  const tag = overlayTag(
    config.project,
    version,
    hashContext(overlayContextDir(deps.cwd)),
  );
  const present = await imagePresent(deps, tag);
  return `overlay  ${tag} — ${
    present ? 'present' : 'missing (built on next launch)'
  } (from .agent/Dockerfile)`;
}
