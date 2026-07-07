import { join } from 'node:path';
import type { EnvDeps } from './types.js';

// Env-file handling and launch preflight (PLAN.md §7). Two files feed a launch:
//   host    ~/.config/agentic-coding/env   (all projects: CLAUDE_CODE_OAUTH_TOKEN,
//                                            optional OPENAI_API_KEY)
//   project ./.env                          (GH_TOKEN, deploy tokens, requiredEnv)
// Each existing file is passed to docker as a `--env-file`; a missing one is
// simply skipped. We also parse them ourselves for the merged view preflight and
// `agent doctor` read (project overrides host). Values are never printed.

export function hostEnvPath(home: string): string {
  return join(home, '.config', 'agentic-coding', 'env');
}

export function projectEnvPath(cwd: string): string {
  return join(cwd, '.env');
}

// Parse an env file with EXACTLY docker's `--env-file` semantics (these files
// are handed verbatim to docker, which hard-errors — exit 125 — on lines it
// rejects, so the merged view must not be more lenient than docker). Verified
// against docker CLI 29.0.0:
//   - each line is left-trimmed; then blank lines and `#` comments are skipped
//   - split at the first `=`; the name is everything before it (verbatim), the
//     value everything after it (verbatim — no trimming, quotes kept)
//   - a name containing whitespace is an ERROR ("variable contains whitespaces"
//     — this is what `export KEY=...` hits)
//   - an empty name (`=value`) is an ERROR ("no variable name")
//   - a bare name with no `=` passes the variable through from the client env
//     (it sets nothing from the file itself)
// Lines docker would reject are collected in `invalid` so the preflight can
// fail with the file + offending key instead of docker's opaque exit 125.
export interface ParsedEnvContent {
  vars: Record<string, string>;
  invalid: string[];
}

export function parseEnvContent(text: string): ParsedEnvContent {
  const vars: Record<string, string> = {};
  const invalid: string[] = [];
  // Docker strips a UTF-8 BOM at the start of the file.
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/^[ \t]+/, '');
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    const name = eq === -1 ? line : line.slice(0, eq);
    if (name === '') {
      invalid.push(`no variable name on line "${line}"`);
      continue;
    }
    if (/[ \t]/.test(name)) {
      const hint = name.startsWith('export')
        ? " — drop the 'export ' prefix (docker env files are KEY=VALUE only)"
        : '';
      invalid.push(
        `variable "${name}" contains whitespace, which docker --env-file rejects${hint}`,
      );
      continue;
    }
    if (eq !== -1) {
      vars[name] = line.slice(eq + 1);
    }
    // Bare valid name: docker passes it through from the client env; the file
    // itself sets nothing, so the merged view records nothing.
  }
  return { vars, invalid };
}

export interface EnvFile {
  label: string;
  path: string;
  scope: 'host' | 'project';
  exists: boolean;
  vars: Record<string, string>;
  // Lines docker's --env-file parser would reject (see parseEnvContent).
  invalid: string[];
}

function readEnvFile(
  deps: EnvDeps,
  path: string,
  scope: EnvFile['scope'],
  label: string,
): EnvFile {
  const text = deps.readTextFile(path);
  const parsed =
    text === undefined ? { vars: {}, invalid: [] } : parseEnvContent(text);
  return {
    label,
    path,
    scope,
    exists: text !== undefined,
    vars: parsed.vars,
    invalid: parsed.invalid,
  };
}

// Always returns [host, project] in that order so the merge below lets project
// override host and the doctor listing reads host-first.
export function loadEnvFiles(deps: EnvDeps): EnvFile[] {
  return [
    readEnvFile(
      deps,
      hostEnvPath(deps.home),
      'host',
      '~/.config/agentic-coding/env',
    ),
    readEnvFile(deps, projectEnvPath(deps.cwd), 'project', './.env'),
  ];
}

// Project overrides host: files arrive [host, project], so a plain left-to-right
// assign wins for project.
export function mergeEnv(files: EnvFile[]): Record<string, string> {
  return Object.assign({}, ...files.map((f) => f.vars)) as Record<
    string,
    string
  >;
}

// One `--env-file <path>` per existing file, in host-then-project order so
// docker layers project over host (later --env-file wins).
export function envFileArgs(files: EnvFile[]): string[] {
  return files.filter((f) => f.exists).flatMap((f) => ['--env-file', f.path]);
}

// A non-empty string counts as present, matching news's `grep '^KEY=.\+'`.
export function envPresent(merged: Record<string, string>, key: string): boolean {
  const value = merged[key];
  return typeof value === 'string' && value.length > 0;
}

export interface EnvRequirement {
  key: string;
  // Human label of the file the key belongs in (named in every failure, §7).
  file: string;
}

// GH_TOKEN is required for ALL launches (including shell): the container clones
// and pushes over HTTPS with it. It lives in the project ./.env (§7 table).
export const GH_TOKEN_REQUIREMENT: EnvRequirement = {
  key: 'GH_TOKEN',
  file: './.env',
};

// GH_TOKEN plus any config.requiredEnv keys — all project-scoped per §7.
export function launchRequirements(requiredEnv: string[]): EnvRequirement[] {
  return [
    GH_TOKEN_REQUIREMENT,
    ...requiredEnv.map((key) => ({ key, file: './.env' })),
  ];
}

// One message per line docker would reject, naming the file — so a user who
// wrote `export GH_TOKEN=...` fails at preflight with a fix, not at `docker
// run` with an opaque exit 125.
export function envFileErrors(files: EnvFile[]): string[] {
  return files.flatMap((f) => f.invalid.map((msg) => `${f.label}: ${msg}`));
}

// One message per unmet requirement, naming the key AND its file (§7).
export function preflightErrors(
  merged: Record<string, string>,
  requirements: EnvRequirement[],
): string[] {
  const errors: string[] = [];
  for (const { key, file } of requirements) {
    if (!envPresent(merged, key)) {
      errors.push(`${key} is not set — add it to ${file}`);
    }
  }
  return errors;
}

export function redactedKeys(merged: Record<string, string>): string[] {
  return Object.keys(merged).sort();
}

// Lines for `agent doctor`'s Environment section: each file's found/missing
// state, the merged key names (values redacted), and a verdict per requirement.
export function environmentLines(
  files: EnvFile[],
  merged: Record<string, string>,
  requirements: EnvRequirement[],
): string[] {
  const lines = files.map(
    (f) =>
      `${f.scope.padEnd(7)} ${f.label} — ${f.exists ? 'found' : 'missing'}`,
  );
  for (const message of envFileErrors(files)) {
    lines.push(`INVALID        ${message}`);
  }
  const keys = redactedKeys(merged);
  lines.push(
    `keys           ${keys.length > 0 ? keys.join(', ') : '(none)'} (values redacted)`,
  );
  for (const { key, file } of requirements) {
    lines.push(
      `${key.padEnd(14)} ${
        envPresent(merged, key) ? 'present' : `MISSING — add to ${file}`
      }`,
    );
  }
  return lines;
}
