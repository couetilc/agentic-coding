import { claudeAgent } from './agents/claude.js';
import { codexAgent } from './agents/codex.js';
import {
  cacheMounts,
  containerName,
  errorMessage,
  labels,
  loadConfig,
} from './config.js';
import type { CacheMount } from './config.js';
import { dockerExec, ensureBaseImage, ensureOverlayImage } from './docker.js';
import {
  envFileArgs,
  envFileErrors,
  launchRequirements,
  loadEnvFiles,
  mergeEnv,
  preflightErrors,
} from './env.js';
import { pickPorts } from './ports.js';
import type { AgentConfig, AgentModule, CliDeps } from './types.js';

// Port of news's agent_launch (PLAN.md §5 "Launch flow"). The full docker-run
// argv is assembled as a pure function (buildRunArgs) so it is golden-testable;
// only the outermost `docker run` actually execs.

const AGENTS: Record<'claude' | 'codex', AgentModule> = {
  claude: claudeAgent,
  codex: codexAgent,
};

interface PortMapping {
  name: string;
  container: number;
  host: number;
}

export interface RunSpec {
  containerName: string;
  labels: string[];
  cacheMounts: CacheMount[];
  envFileArgs: string[];
  agentKind: string;
  repo: string;
  defaultBranch: string;
  gitUserName: string;
  gitUserEmail: string;
  colorterm: string;
  // Attach a pseudo-TTY (`-t`)? Always `-i`; `-t` only for a real terminal.
  // Headless/scripted launches (`agent claude -p ...`, `agent shell -- cmd`)
  // must NOT request a TTY or docker fails "the input device is not a TTY".
  isTTY: boolean;
  // Agent model/effort env + any auth `-e` args (values via childEnv, not argv).
  agentEnv: string[];
  ports: PortMapping[];
  image: string;
  cmd: string[];
}

// The `docker <...>` argv (leading `docker` is the exec command; this returns
// everything after it). No `--rm`: containers are kept so unpushed work is
// salvageable (isolation contract). `-i` keeps stdin open for interactive
// agents; `-t` is added only for a real terminal (deviation from news, §10.3).
export function buildRunArgs(spec: RunSpec): string[] {
  const args = ['run', spec.isTTY ? '-it' : '-i', '--name', spec.containerName];
  for (const label of spec.labels) {
    args.push('--label', label);
  }
  for (const mount of spec.cacheMounts) {
    args.push('-v', `${mount.volume}:${mount.path}`);
  }
  args.push(...spec.envFileArgs);
  args.push('-e', `AGENT_KIND=${spec.agentKind}`);
  args.push('-e', `REPO=${spec.repo}`);
  args.push('-e', `DEFAULT_BRANCH=${spec.defaultBranch}`);
  args.push('-e', `GIT_USER_NAME=${spec.gitUserName}`);
  args.push('-e', `GIT_USER_EMAIL=${spec.gitUserEmail}`);
  // Always the literal xterm-256color, as news did — forwarding the host's
  // $TERM breaks terminfo lookup inside node:24-slim for terminals like
  // ghostty/kitty/wezterm ('unknown terminal "xterm-ghostty"').
  args.push('-e', 'TERM=xterm-256color');
  args.push('-e', `COLORTERM=${spec.colorterm}`);
  args.push(...spec.agentEnv);
  for (const p of spec.ports) {
    args.push('-e', `DEV_HOST_${p.name.toUpperCase()}=127.0.0.1:${p.host}`);
  }
  for (const p of spec.ports) {
    args.push('-p', `127.0.0.1:${p.host}:${p.container}`);
  }
  args.push(spec.image);
  args.push(...spec.cmd);
  return args;
}

// Pre-step run before the main `docker run`: a fresh named volume mounted at a
// path the image doesn't pre-create comes up ROOT-owned (docker creates the
// mountpoint as root), locking the non-root `node` user out of its own cache
// forever (volumes outlive `agent clean`). One throwaway root container chowns
// every cache mountpoint node-writable. NON-recursive on purpose: it only fixes
// the mountpoint dir itself — a recursive chown over a warm multi-GB cache
// would stall every launch.
export function chownCacheArgs(mounts: CacheMount[], image: string): string[] {
  return [
    'run',
    '--rm',
    '-u',
    '0',
    ...mounts.flatMap((m) => ['-v', `${m.volume}:${m.path}`]),
    '--entrypoint',
    'chown',
    image,
    'node:node',
    ...mounts.map((m) => m.path),
  ];
}

// Host git identity — the entrypoint refuses to start without it (§5), so the
// launcher preflights it here for a clearer error before docker run.
async function gitConfigValue(deps: CliDeps, key: string): Promise<string> {
  const result = await deps.exec('git', ['config', key], { stdio: 'pipe' });
  return result.code === 0 ? result.stdout.trim() : '';
}

// claude/codex/shell entry. Returns the container's exit code (or 1 on a
// preflight/build failure), mirroring the CLI's run() contract.
export async function runLaunch(deps: CliDeps): Promise<number> {
  const command = deps.argv[0];
  // A leading `--` is the conventional end-of-options separator ("everything
  // after it is for the subcommand"); strip one so `agent shell -- true` and
  // `agent claude -- --flag` pass the tail through cleanly.
  const rawArgs = deps.argv.slice(1);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  let config: AgentConfig;
  try {
    config = await loadConfig(deps);
  } catch (err) {
    deps.err(`error: ${errorMessage(err)}\n`);
    return 1;
  }

  // Env files + preflight run on EVERY launch, shell included (GH_TOKEN clones
  // and pushes; requiredEnv is project policy). Failures name key + file (§7).
  // Lines docker's --env-file parser would reject fail here with a fix, not at
  // docker run with an opaque exit 125.
  const files = loadEnvFiles(deps);
  const merged = mergeEnv(files);
  const envErrors = [
    ...envFileErrors(files),
    ...preflightErrors(merged, launchRequirements(config.requiredEnv)),
  ];
  if (envErrors.length > 0) {
    for (const message of envErrors) {
      deps.err(`error: ${message}\n`);
    }
    return 1;
  }

  // Agent credential preflight (skipped for shell). Produces the model/effort
  // env and any auth `-e` args + child-process env.
  const agent = command === 'shell' ? undefined : AGENTS[command as 'claude' | 'codex'];
  let agentEnv: string[] = [];
  const childEnv: Record<string, string> = {};
  if (agent !== undefined) {
    const auth = agent.resolveAuth({
      merged,
      env: deps.env,
      home: deps.home,
      readTextFile: deps.readTextFile,
    });
    if (!auth.ok) {
      deps.err(`error: ${auth.error}\n`);
      return 1;
    }
    agentEnv = [...agent.modelEnv(config.agents[agent.kind]), ...auth.dockerArgs];
    Object.assign(childEnv, auth.childEnv);
  }

  // Everything below touches the OS (git, docker). A spawn failure — docker or
  // git not installed — rejects through the exec seam; catch it and print one
  // actionable line instead of an unhandled-rejection stack trace.
  try {
    const gitUserName = await gitConfigValue(deps, 'user.name');
    const gitUserEmail = await gitConfigValue(deps, 'user.email');
    if (gitUserName === '' || gitUserEmail === '') {
      deps.err(
        'error: host git identity is unset — run `git config --global user.name "..."` and `git config --global user.email "..."` (the container refuses without an identity)\n',
      );
      return 1;
    }

    // Build base (cached; prints first-build vs cached) then overlay if present.
    const baseCode = await ensureBaseImage(deps, deps.version);
    if (baseCode !== 0) {
      return baseCode;
    }
    const overlay = await ensureOverlayImage(deps, config, deps.version);
    if (overlay.code !== 0) {
      return overlay.code;
    }

    // Make every cache mountpoint node-writable BEFORE the main run: a fresh
    // named volume at a path the image doesn't pre-create would otherwise be
    // root-owned for good (see chownCacheArgs).
    const mounts = cacheMounts(config);
    const prep = await dockerExec(
      deps.exec,
      chownCacheArgs(mounts, overlay.image),
      { stdio: 'pipe' },
    );
    if ((prep.code ?? 1) !== 0) {
      deps.err(
        `error: preparing cache volumes failed (docker exited ${prep.code ?? 'null'})${prep.stderr !== '' ? `: ${prep.stderr.trim()}` : ''}\n`,
      );
      return prep.code ?? 1;
    }

    // One distinct host port per named config port.
    const names = Object.keys(config.ports);
    const hostPorts = await pickPorts(deps.port, names.length);
    const ports: PortMapping[] = names.map((name, i) => ({
      name,
      container: config.ports[name],
      host: hostPorts[i],
    }));

    // shell: run the given command directly (the entrypoint `exec "$@"`s it), or
    // an interactive `bash` when none is given. Running it directly — not
    // `bash <cmd>`, which would treat the command as a script file — is what
    // makes scriptable `agent shell -- true` work (§10.3).
    const cmd = agent
      ? agent.buildCommand(config.agents[agent.kind], args)
      : args.length > 0
        ? args
        : ['bash'];

    const name = containerName(config.project, command, deps.now());
    deps.err(`Starting ${name} (kept after exit; \`agent clean\` to prune)\n`);
    if (ports.length > 0) {
      // The dev server must ALSO bind 0.0.0.0 inside (npm run dev -- --host) or
      // forwarded traffic never reaches a container-loopback listener (news note).
      deps.err('Dev servers, once started inside with --host (bind 0.0.0.0):\n');
      for (const p of ports) {
        deps.err(
          `  ${p.name.padEnd(10)} http://127.0.0.1:${p.host}/    ($DEV_HOST_${p.name.toUpperCase()})\n`,
        );
      }
    }

    const spec: RunSpec = {
      containerName: name,
      labels: labels(config.project, deps.version),
      cacheMounts: mounts,
      envFileArgs: envFileArgs(files),
      agentKind: command,
      repo: config.repo,
      defaultBranch: config.defaultBranch,
      gitUserName,
      gitUserEmail,
      colorterm: deps.env.COLORTERM ?? '',
      isTTY: deps.isTTY,
      agentEnv,
      ports,
      image: overlay.image,
      cmd,
    };

    const result = await dockerExec(deps.exec, buildRunArgs(spec), {
      stdio: 'inherit',
      // Secret auth values (codex CODEX_AUTH_B64) ride in the docker CLIENT
      // process env, off the argv — never in `ps`.
      env: { ...deps.env, ...childEnv },
    });
    return result.code ?? 1;
  } catch (err) {
    deps.err(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}
