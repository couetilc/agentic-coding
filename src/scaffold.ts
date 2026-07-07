import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { errorMessage } from './config.js';
import type { ScaffoldDeps } from './types.js';

// `agent init` — scaffold/upgrade a project's committed `.agent/` directory
// (PLAN.md §3, §6). Everything is DERIVED from git, never prompted. Idempotent:
// engine-owned files are regenerated every run; user-owned files (config.js,
// init.sh) are written once and never overwritten. Every fs mutation and git
// read goes through an injectable seam so the logic is fully unit-testable and
// tests can point it at a tmp dir.

// Thrown for every derivation/scaffold failure; the message names the problem
// and the fix so `agent init` can surface it verbatim.
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

// The npm package's own templates/ directory, resolved relative to THIS module
// so it works from dist/ in an npx install (mirrors docker.ts packageDockerDir).
export function packageTemplatesDir(): string {
  return fileURLToPath(new URL('../templates', import.meta.url));
}

// --- Pure derivations (unit-tested directly) -------------------------------

// Normalize a git remote URL to `owner/name`. Handles the three forms git
// emits: scp-like SSH (`git@github.com:owner/name.git`), URLs
// (`https://github.com/owner/name(.git)`), and `ssh://git@github.com/owner/name`.
// Returns undefined for anything without a parseable `owner/name` tail.
export function normalizeRemote(raw: string): string | undefined {
  // Strip trailing slashes, then a trailing `.git`.
  const url = raw.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  if (url === '') {
    return undefined;
  }

  // scp-like: user@host:path (no scheme). The colon separates host from path.
  const scp = /^[^/@]+@[^/:]+:(.+)$/.exec(url);
  // URL: scheme://[user@]host/path
  const uri = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?[^/]+\/(.+)$/i.exec(url);
  const path = scp?.[1] ?? uri?.[1];
  if (path === undefined) {
    return undefined;
  }

  // Keep the last two non-empty segments as owner/name.
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) {
    return undefined;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

// Slugify a repo name into a docker-safe project slug: lowercase, every run of
// non-alphanumeric chars → a single hyphen, no leading/trailing hyphens
// (e.g. `couetil.com` → `couetil-com`, `My_Repo` → `my-repo`).
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The major from a semver string (`0.1.0` → `0`), for the shim's `@^<major>`
// pin. Derived from THIS CLI's version at init time, so the pin tracks the
// engine that scaffolded it ("shims pin the major", §1).
export function majorVersion(version: string): string {
  return version.split('.')[0];
}

// Dead-simple `{{TOKEN}}` substitution. Unknown tokens are left intact (a
// template typo then shows up verbatim in the output and a golden test catches
// it).
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in vars ? vars[key] : whole,
  );
}

// --- git-driven derivation -------------------------------------------------

// Run a read-only git command, returning its trimmed stdout — or undefined if
// the command failed OR produced no output (folding both "no useful value"
// cases into one so callers branch on `undefined` alone).
async function gitOut(
  deps: ScaffoldDeps,
  args: string[],
): Promise<string | undefined> {
  const result = await deps.exec('git', args, {
    cwd: deps.cwd,
    stdio: 'pipe',
  });
  if (result.code !== 0) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value === '' ? undefined : value;
}

// Refuse outside a git repo with an actionable error (init derives everything
// from git, so there is nothing to do otherwise).
async function ensureGitRepo(deps: ScaffoldDeps): Promise<void> {
  const inside = await gitOut(deps, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    throw new ScaffoldError(
      `not a git repository (${deps.cwd}) — run \`agent init\` from a project repo root (\`git init\` first if this is a new repo)`,
    );
  }
}

export interface Derived {
  repo: string;
  project: string;
  defaultBranch: string;
}

async function deriveRepo(deps: ScaffoldDeps): Promise<string> {
  const url = await gitOut(deps, ['remote', 'get-url', 'origin']);
  if (url === undefined) {
    throw new ScaffoldError(
      'no `origin` remote — add one first, e.g. `git remote add origin git@github.com:<owner>/<name>.git`, then re-run `agent init`',
    );
  }
  const repo = normalizeRemote(url);
  if (repo === undefined) {
    throw new ScaffoldError(
      `could not parse \`owner/name\` from the origin remote "${url}" — it must be a GitHub SSH or HTTPS URL`,
    );
  }
  return repo;
}

// defaultBranch: origin's HEAD symbolic-ref (`refs/remotes/origin/HEAD` →
// strip the prefix), falling back to the current branch, falling back to main.
async function deriveDefaultBranch(deps: ScaffoldDeps): Promise<string> {
  const head = await gitOut(deps, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (head !== undefined) {
    return head.replace(/^refs\/remotes\/origin\//, '');
  }
  const current = await gitOut(deps, ['symbolic-ref', '--short', 'HEAD']);
  if (current !== undefined) {
    return current;
  }
  return 'main';
}

async function derive(deps: ScaffoldDeps): Promise<Derived> {
  const repo = await deriveRepo(deps);
  const name = repo.split('/')[1];
  return {
    repo,
    project: slugify(name),
    defaultBranch: await deriveDefaultBranch(deps),
  };
}

// --- file writing ----------------------------------------------------------

type Status = 'created' | 'updated' | 'skipped';

interface FileResult {
  label: string;
  status: Status;
  note?: string;
}

// The engine-owned `.agent/package.json`: exactly `{"type":"module"}` so
// `config.js` parses as ESM without Node's MODULE_TYPELESS_PACKAGE_JSON warning,
// regardless of the host project's own module type (§3).
const PACKAGE_JSON = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;

function readTemplate(deps: ScaffoldDeps, ...segments: string[]): string {
  const path = join(deps.packageTemplatesDir, ...segments);
  const text = deps.readTextFile(path);
  if (text === undefined) {
    throw new ScaffoldError(
      `missing packaged template ${path} — the install looks broken; reinstall @couetilc/agentic-coding`,
    );
  }
  return text;
}

// Engine-owned: always (re)written; "created" if new, "updated" if it existed.
function writeEngineFile(
  deps: ScaffoldDeps,
  label: string,
  path: string,
  content: string,
  executable: boolean,
): FileResult {
  const existed = deps.fileExists(path);
  deps.writeTextFile(path, content);
  if (executable) {
    deps.makeExecutable(path);
  }
  return { label, status: existed ? 'updated' : 'created' };
}

// User-owned: written once; left untouched (and reported skipped) on re-run.
function writeUserFile(
  deps: ScaffoldDeps,
  label: string,
  path: string,
  content: string,
  executable: boolean,
): FileResult {
  if (deps.fileExists(path)) {
    return { label, status: 'skipped', note: 'user-owned; left as-is' };
  }
  deps.writeTextFile(path, content);
  if (executable) {
    deps.makeExecutable(path);
  }
  return { label, status: 'created' };
}

const ENVRC_LINE = 'PATH_add ./.agent/bin';

function hasLine(content: string, line: string): boolean {
  return content.split(/\r?\n/).some((l) => l.trim() === line);
}

// Append `text` to an existing file's content with exactly one separating
// newline (no double blank line, and none when the file already ends in one).
function appendLine(existing: string, text: string): string {
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  return `${existing}${sep}${text}\n`;
}

// .envrc: never clobber. Create with the PATH_add line; append it once if the
// file exists without it; skip silently if already present.
function ensureEnvrc(deps: ScaffoldDeps): FileResult {
  const label = '.envrc';
  const path = join(deps.cwd, '.envrc');
  const existing = deps.readTextFile(path);
  if (existing === undefined) {
    deps.writeTextFile(path, `${ENVRC_LINE}\n`);
    return { label, status: 'created' };
  }
  if (hasLine(existing, ENVRC_LINE)) {
    return { label, status: 'skipped', note: 'PATH_add line already present' };
  }
  deps.writeTextFile(path, appendLine(existing, ENVRC_LINE));
  return { label, status: 'updated', note: 'appended PATH_add ./.agent/bin' };
}

// .gitignore: ensure `.env` is ignored. Treat an existing `.env` or `/.env`
// line as present; create or append otherwise.
function ensureGitignore(deps: ScaffoldDeps): FileResult {
  const label = '.gitignore';
  const path = join(deps.cwd, '.gitignore');
  const existing = deps.readTextFile(path);
  if (existing === undefined) {
    deps.writeTextFile(path, '.env\n');
    return { label, status: 'created' };
  }
  const present = existing
    .split(/\r?\n/)
    .some((l) => l.trim() === '.env' || l.trim() === '/.env');
  if (present) {
    return { label, status: 'skipped', note: '.env already ignored' };
  }
  deps.writeTextFile(path, appendLine(existing, '.env'));
  return { label, status: 'updated', note: 'appended .env' };
}

interface ScaffoldSummary {
  derived: Derived;
  files: FileResult[];
  envrc: FileResult;
  gitignore: FileResult;
}

// Write the whole scaffold. `.agent/` and `.agent/bin/` are created first
// (recursive), then each file per its ownership. Nothing outside `.agent/` is
// ever clobbered.
function writeScaffold(deps: ScaffoldDeps, derived: Derived): ScaffoldSummary {
  const agentDir = join(deps.cwd, '.agent');
  const binDir = join(agentDir, 'bin');
  deps.mkdirp(binDir);

  const vars: Record<string, string> = {
    PROJECT: derived.project,
    REPO: derived.repo,
    DEFAULT_BRANCH: derived.defaultBranch,
    MAJOR: majorVersion(deps.version),
  };

  const files: FileResult[] = [
    // USER-OWNED: written once, never overwritten. (A future schemaVersion v2
    // migration would slot in HERE — read the existing config.js, bump + rewrite
    // it with a diff; v1 leaves a valid config untouched, which with config.ts's
    // newer-than-supported refusal satisfies the plan, §3.)
    writeUserFile(
      deps,
      '.agent/config.js',
      join(agentDir, 'config.js'),
      render(readTemplate(deps, 'config.js.tmpl'), vars),
      false,
    ),
    // ENGINE-OWNED: regenerated every run.
    writeEngineFile(
      deps,
      '.agent/package.json',
      join(agentDir, 'package.json'),
      PACKAGE_JSON,
      false,
    ),
    writeEngineFile(
      deps,
      '.agent/README.md',
      join(agentDir, 'README.md'),
      render(readTemplate(deps, 'README.md'), vars),
      false,
    ),
    ...['agent', 'claude', 'codex'].map((name) =>
      writeEngineFile(
        deps,
        `.agent/bin/${name}`,
        join(binDir, name),
        render(readTemplate(deps, 'bin', name), vars),
        true,
      ),
    ),
    // USER-OWNED.
    writeUserFile(
      deps,
      '.agent/init.sh',
      join(agentDir, 'init.sh'),
      readTemplate(deps, 'init.sh.tmpl'),
      true,
    ),
    // ENGINE-OWNED.
    writeEngineFile(
      deps,
      '.agent/env.example',
      join(agentDir, 'env.example'),
      readTemplate(deps, 'env.example.tmpl'),
      false,
    ),
  ];

  return {
    derived,
    files,
    envrc: ensureEnvrc(deps),
    gitignore: ensureGitignore(deps),
  };
}

function printSummary(deps: ScaffoldDeps, summary: ScaffoldSummary): void {
  const { derived } = summary;
  const lines: string[] = [
    `Scaffolded .agent/ for ${derived.project} (${derived.repo}, default branch ${derived.defaultBranch}).`,
    '',
  ];
  for (const f of [...summary.files, summary.envrc, summary.gitignore]) {
    lines.push(
      `  ${f.status.padEnd(8)} ${f.label}${f.note !== undefined ? ` (${f.note})` : ''}`,
    );
  }
  const skipped = summary.files.filter((f) => f.status === 'skipped');
  if (skipped.length > 0) {
    lines.push(
      '',
      `Left ${skipped.map((f) => f.label).join(' and ')} untouched (user-owned).`,
    );
  }
  if (summary.envrc.status !== 'skipped') {
    lines.push(
      '',
      'Run `direnv allow` to put ./.agent/bin on your PATH (direnv optional; the shims are directly invocable).',
    );
  }
  lines.push(
    '',
    'Next: set GH_TOKEN in ./.env (see .agent/env.example) and agent credentials in ~/.config/agentic-coding/env, then run `agent doctor`.',
    '',
  );
  deps.out(lines.join('\n'));
}

// `agent init` entry. Returns 0 on success, 1 on an actionable failure
// (matching run()'s exit-code contract).
export async function runInit(deps: ScaffoldDeps): Promise<number> {
  try {
    await ensureGitRepo(deps);
    const derived = await derive(deps);
    printSummary(deps, writeScaffold(deps, derived));
    return 0;
  } catch (err) {
    deps.err(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}
