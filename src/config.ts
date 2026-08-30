import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentConfig,
  AgentSettings,
  AgentsConfig,
  ConfigDeps,
} from './types.js';

// The newest schemaVersion this CLI understands. A config declaring a higher
// version is refused with an "upgrade the CLI" message (PLAN.md §1).
export const SUPPORTED_SCHEMA_VERSION = 1;

// Default age horizon (days) for the launch-time retention sweep (issue #5):
// this project's stopped containers and superseded image tags older than this
// are removed. Overridable per project via `retentionDays`; 0 disables.
export const DEFAULT_RETENTION_DAYS = 30;

const CONFIG_REL = '.agent/config.js';

// Docker artifact names (project, cache names) must be safe slugs; `repo` must
// be `owner/name` for the HTTPS clone URL.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO = /^[^/\s]+\/[^/\s]+$/;

// Thrown for every validation/load failure. Carries a message that names the
// offending field and how to fix it, so `agent doctor` can surface it verbatim.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function configPath(cwd: string): string {
  return join(cwd, '.agent', 'config.js');
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function loadConfig(deps: ConfigDeps): Promise<AgentConfig> {
  const path = configPath(deps.cwd);
  if (!deps.fileExists(path)) {
    throw new ConfigError(
      `no ${CONFIG_REL} found in ${deps.cwd} — run \`agent init\` to scaffold one`,
    );
  }

  let mod: unknown;
  try {
    mod = await deps.importModule(pathToFileURL(path).href);
  } catch (cause) {
    throw new ConfigError(`failed to load ${CONFIG_REL}: ${errorMessage(cause)}`);
  }

  const raw = (mod as { default?: unknown }).default;
  if (raw === undefined) {
    throw new ConfigError(`${CONFIG_REL} must \`export default\` a config object`);
  }
  return validateConfig(raw);
}

function validateConfig(raw: unknown): AgentConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${CONFIG_REL} default export must be an object`);
  }
  const c = raw as Record<string, unknown>;

  return {
    schemaVersion: validateSchemaVersion(c.schemaVersion),
    project: requireSlug(
      c.project,
      'project',
      'it names the docker image, containers, and volumes',
    ),
    repo: requireRepo(c.repo),
    defaultBranch: requireNonEmptyString(
      c.defaultBranch,
      'defaultBranch',
      'e.g. `main` — the branch the auto-push hook skips',
    ),
    ports: validatePorts(c.ports),
    agents: validateAgents(c.agents),
    requiredEnv: validateStringArray(c.requiredEnv, 'requiredEnv'),
    caches: validateCaches(c.caches),
    retentionDays: validateRetentionDays(c.retentionDays),
  };
}

function validateRetentionDays(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_RETENTION_DAYS;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `retentionDays must be a non-negative integer number of days (0 disables the launch-time sweep), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateSchemaVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(
      `schemaVersion must be an integer — set \`schemaVersion: ${SUPPORTED_SCHEMA_VERSION}\``,
    );
  }
  if (value < 1) {
    throw new ConfigError(
      `schemaVersion must be >= 1 — set \`schemaVersion: ${SUPPORTED_SCHEMA_VERSION}\``,
    );
  }
  if (value > SUPPORTED_SCHEMA_VERSION) {
    throw new ConfigError(
      `schemaVersion ${value} is newer than this CLI supports (max ${SUPPORTED_SCHEMA_VERSION}) — upgrade the CLI: \`npm install -g @couetilc/agentic-coding\``,
    );
  }
  return value;
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  hint: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${field} must be a non-empty string — ${hint}`);
  }
  return value;
}

function requireSlug(value: unknown, field: string, hint: string): string {
  const s = requireNonEmptyString(
    value,
    field,
    `a lowercase slug (letters, digits, hyphens); ${hint}`,
  );
  if (!SLUG.test(s)) {
    throw new ConfigError(
      `${field} "${s}" is not a valid slug — use lowercase letters, digits, and hyphens (${hint})`,
    );
  }
  return s;
}

function requireRepo(value: unknown): string {
  const s = requireNonEmptyString(
    value,
    'repo',
    'the clone target as `owner/name` (e.g. `couetilc/couetil.com`)',
  );
  if (!REPO.test(s)) {
    throw new ConfigError(
      `repo "${s}" must be \`owner/name\` (e.g. \`couetilc/couetil.com\`)`,
    );
  }
  return s;
}

function validatePorts(value: unknown): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      'ports must be an object mapping name → container port, e.g. `{ astro: 4321 }`',
    );
  }
  const result: Record<string, number> = {};
  for (const [name, port] of Object.entries(value as Record<string, unknown>)) {
    if (!SLUG.test(name)) {
      throw new ConfigError(
        `ports key "${name}" must be a slug — it becomes the $DEV_HOST_<NAME> env var`,
      );
    }
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new ConfigError(
        `ports.${name} must be an integer between 1 and 65535 (the in-container port), got ${JSON.stringify(port)}`,
      );
    }
    result[name] = port;
  }
  return result;
}

function validateAgents(value: unknown): AgentsConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      'agents must be an object with `claude` and `codex` settings',
    );
  }
  const a = value as Record<string, unknown>;
  return {
    claude: validateAgentSettings(a.claude, 'claude'),
    codex: validateAgentSettings(a.codex, 'codex'),
  };
}

function validateAgentSettings(value: unknown, name: string): AgentSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `agents.${name} must be an object with \`model\` and \`effort\``,
    );
  }
  const s = value as Record<string, unknown>;
  return {
    model: requireNonEmptyString(
      s.model,
      `agents.${name}.model`,
      'e.g. `claude-fable-5`',
    ),
    effort: requireNonEmptyString(
      s.effort,
      `agents.${name}.effort`,
      'e.g. `xhigh`',
    ),
  };
}

function validateStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`${field} must be an array of strings`);
  }
  value.forEach((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new ConfigError(`${field}[${i}] must be a non-empty string`);
    }
  });
  return value as string[];
}

function validateCaches(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      'caches must be an array of cache names (slugs), e.g. `["uv"]`',
    );
  }
  return value.map((item, i) =>
    requireSlug(item, `caches[${i}]`, 'it names a docker cache volume'),
  );
}

// --- Derivations (PLAN.md §4) ---------------------------------------------

export function imageName(project: string): string {
  return `agentic-${project}`;
}

// `agentic-<project>-<agent>-<MMDD-HHMMSS>-<suffix>`. The zero-padded local
// timestamp makes a reverse lexical sort of names newest-first, matching news
// behavior. The random suffix makes the name collision-proof: containers are
// kept after exit, so the stamp alone collides across two same-second launches
// or a kept container from the same date a year earlier (docker then refuses
// the run with an opaque "Conflict" error, #6).
export function containerName(
  project: string,
  agent: string,
  now: Date,
  suffix: string,
): string {
  return `agentic-${project}-${agent}-${formatStamp(now)}-${suffix}`;
}

// Real suffix generator wired into CliDeps.nameSuffix (injected so names stay
// deterministic in tests). Four hex chars — collisions would need two launches
// of the same agent in the same second to also draw the same 1-in-65536 value.
export function randomNameSuffix(): string {
  return randomBytes(2).toString('hex');
}

function formatStamp(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
}

export function labels(project: string, version: string): string[] {
  return [
    `agentic-coding.project=${project}`,
    `agentic-coding.version=${version}`,
  ];
}

// The npm cache is shared across projects to keep installs fast (PLAN.md §4);
// every other cache is project-scoped.
export function cacheVolumeName(project: string, cache: string): string {
  return cache === 'npm' ? 'agentic-npm-cache' : `agentic-${project}-${cache}`;
}

export function cacheVolumeNames(config: AgentConfig): string[] {
  return ['npm', ...config.caches].map((c) =>
    cacheVolumeName(config.project, c),
  );
}

// Where each named cache volume mounts inside the container. `npm` keeps node's
// conventional cache dir; `uv` uses XDG's `~/.cache/uv` (uv's default); anything
// else lands at `~/.cache/<name>`. The base image pre-creates `~/.cache` owned by
// `node` so a fresh volume never ends up root-owned. Documented here as the one
// place the mapping lives (PLAN.md §5, launch item 4).
const CACHE_MOUNT_PATHS: Record<string, string> = {
  npm: '/home/node/.npm',
  uv: '/home/node/.cache/uv',
};

export function cacheMountPath(cache: string): string {
  return CACHE_MOUNT_PATHS[cache] ?? `/home/node/.cache/${cache}`;
}

export interface CacheMount {
  volume: string;
  path: string;
}

// The shared npm cache is always mounted first; each config cache follows,
// project-scoped, at its conventional container path.
export function cacheMounts(config: AgentConfig): CacheMount[] {
  return ['npm', ...config.caches].map((c) => ({
    volume: cacheVolumeName(config.project, c),
    path: cacheMountPath(c),
  }));
}
