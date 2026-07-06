// Config schema for `.agent/config.js` (PLAN.md §4) plus the injectable
// dependency interfaces that keep every OS boundary testable (PLAN.md §9).
// These interfaces are the seams later phases (launch/docker/env) plug into.

export interface AgentSettings {
  model: string;
  effort: string;
}

export interface AgentsConfig {
  claude: AgentSettings;
  codex: AgentSettings;
}

export interface AgentConfig {
  schemaVersion: number;
  project: string;
  repo: string;
  defaultBranch: string;
  ports: Record<string, number>;
  agents: AgentsConfig;
  requiredEnv: string[];
  caches: string[];
}

// --- OS boundary seams -----------------------------------------------------

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  // `inherit` wires the child straight to the parent's tty (interactive
  // `docker run`); `pipe` (default) captures output for programmatic use.
  stdio?: 'pipe' | 'inherit';
}

// The single child_process seam. Later phases run `docker build`/`docker run`
// through this; tests stub it at the boundary.
export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

// Everything `config.ts` needs from the outside world.
export interface ConfigDeps {
  cwd: string;
  fileExists: (path: string) => boolean;
  importModule: (spec: string) => Promise<unknown>;
}

// Everything the CLI touches outside itself. Injected so `cli.ts` never reads a
// global directly and stays fully exercisable in unit tests.
export interface CliDeps extends ConfigDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  version: string;
  out: (text: string) => void;
  err: (text: string) => void;
  exec: ExecFn;
}
