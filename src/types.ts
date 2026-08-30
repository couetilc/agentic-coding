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

// Free-port picking seam (src/ports.ts). `tryListen` binds a throwaway TCP
// server on 127.0.0.1:<port> and resolves true if it was free, false if
// occupied; `randomInt` yields a uniform integer in [min, max]. Injecting both
// lets tests simulate occupied ports without touching real sockets (PLAN.md §9).
export interface PortDeps {
  tryListen: (port: number) => Promise<boolean>;
  randomInt: (min: number, max: number) => number;
}

// Everything env-file handling (src/env.ts) reads from the outside world.
export interface EnvDeps {
  cwd: string;
  home: string;
  readTextFile: (path: string) => string | undefined;
}

// Everything the scaffolder (src/scaffold.ts) touches. `packageTemplatesDir` is
// the npm package's own `templates/` directory (resolved relative to the module
// so it works from `dist/` in an npx install). The write seams (write/mkdirp/
// makeExecutable) keep every fs mutation injectable, so scaffold logic is fully
// exercisable and tests can point it at a tmp dir (PLAN.md §9).
export interface ScaffoldDeps {
  cwd: string;
  exec: ExecFn;
  // This CLI's own version — the shim major pin is derived from it (§3).
  version: string;
  packageTemplatesDir: string;
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string | undefined;
  writeTextFile: (path: string, content: string) => void;
  makeExecutable: (path: string) => void;
  mkdirp: (path: string) => void;
  out: (text: string) => void;
  err: (text: string) => void;
}

// Everything image build/status/clean (src/docker.ts) touches. `packageDockerDir`
// is the npm package's own `docker/` directory (resolved relative to the module
// so it works from `dist/` in an npx install).
export interface DockerDeps {
  exec: ExecFn;
  fileExists: (path: string) => boolean;
  cwd: string;
  packageDockerDir: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

// What an agent's auth resolution sees: the merged env-file view (project
// overrides host), the host process env (e.g. CODEX_HOME), the home dir, and a
// file reader (codex reads ~/.codex/auth.json). Kept separate from the launch so
// each agent's credential policy is unit-testable in isolation.
export interface AgentAuthDeps {
  merged: Record<string, string>;
  env: Record<string, string | undefined>;
  home: string;
  readTextFile: (path: string) => string | undefined;
}

// The result of an agent's credential check. `dockerArgs` are extra `-e` args to
// splice into `docker run` (e.g. codex's bare `-e CODEX_AUTH_B64`); `childEnv`
// carries the matching values into the docker CLIENT process env so a secret
// never lands on the argv (never shows in `ps`), exactly as news does. A
// discriminated union so a failure always carries an `error` message (no
// undefined-message branch to guard at the call site).
export type AgentAuth =
  | { ok: true; dockerArgs: string[]; childEnv: Record<string, string> }
  | {
      ok: false;
      error: string;
      dockerArgs: string[];
      childEnv: Record<string, string>;
    };

// The per-agent contract (src/agents/*.ts). `buildCommand` assembles the CMD run
// in-container; `modelEnv` injects `-e <AGENT>_MODEL/_EFFORT` so the entrypoint
// seeds config from these values rather than hardcoding them; `resolveAuth`
// checks credentials through the merged env-file view + fs seam.
export interface AgentModule {
  kind: 'claude' | 'codex';
  buildCommand: (settings: AgentSettings, args: string[]) => string[];
  modelEnv: (settings: AgentSettings) => string[];
  resolveAuth: (deps: AgentAuthDeps) => AgentAuth;
}

// Everything the CLI touches outside itself. Injected so `cli.ts` never reads a
// global directly and stays fully exercisable in unit tests. It is a superset of
// the narrower per-module deps above (EnvDeps/DockerDeps/PortDeps/ScaffoldDeps),
// so cli.ts can hand the same object to each module.
export interface CliDeps extends ConfigDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  version: string;
  // Host home dir (for the ~/.config/agentic-coding/env file and codex auth).
  home: string;
  // Whether stdout is a TTY. `docker run` gets `-t` only when true, so scripted
  // (non-terminal) launches like `agent claude -p ...` / `agent shell -- cmd`
  // don't hit "the input device is not a TTY" (PLAN.md §10.3 deviation).
  isTTY: boolean;
  // Wall clock, injected so container-name timestamps are deterministic in tests.
  now: () => Date;
  // Random container-name suffix (collision-proofing beyond the seconds-
  // resolution stamp), injected so names are deterministic in tests.
  nameSuffix: () => string;
  // Read a file's UTF-8 text, or undefined if it does not exist.
  readTextFile: (path: string) => string | undefined;
  // Write a file's UTF-8 text (scaffolder); create a directory and parents;
  // mark a file executable. Injected fs-mutation seams for `agent init`.
  writeTextFile: (path: string, content: string) => void;
  makeExecutable: (path: string) => void;
  mkdirp: (path: string) => void;
  // The npm package's own docker/ and templates/ directories (build context and
  // scaffold sources), resolved module-relative so they work from dist/.
  packageDockerDir: string;
  packageTemplatesDir: string;
  port: PortDeps;
  out: (text: string) => void;
  err: (text: string) => void;
  exec: ExecFn;
}
