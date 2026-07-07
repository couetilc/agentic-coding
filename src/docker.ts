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

export function overlayTag(project: string, version: string): string {
  return `${imageName(project)}:${version}`;
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
    '-t',
    tag,
    context,
  ];
}

export function overlayBuildArgs(
  context: string,
  tag: string,
  base: string,
  fresh = false,
): string[] {
  return [
    'build',
    ...(fresh ? ['--pull', '--no-cache'] : []),
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

// If a `.agent/Dockerfile` exists, build the overlay (each launch, so edits are
// picked up; docker's layer cache keeps an unchanged rebuild fast) and run it;
// otherwise the base image is used directly.
export async function ensureOverlayImage(
  deps: DockerDeps,
  config: AgentConfig,
  version: string,
): Promise<{ code: number; image: string }> {
  const base = baseTag(version);
  if (!hasOverlay(deps)) {
    return { code: 0, image: base };
  }
  const tag = overlayTag(config.project, version);
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
        overlayTag(config.project, version),
        baseTag(version),
        true,
      ),
      { stdio: 'inherit' },
    );
    return overlay.code ?? 1;
  }
  return 0;
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
): Promise<string> {
  if (!hasOverlay(deps)) {
    return 'overlay  (none — .agent/Dockerfile absent; base used directly)';
  }
  const tag = overlayTag(config.project, version);
  const present = await imagePresent(deps, tag);
  return `overlay  ${tag} — ${
    present ? 'present' : 'missing (built on next launch)'
  } (from .agent/Dockerfile)`;
}
