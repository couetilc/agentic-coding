import { describe, expect, it } from 'vitest';
import {
  buildRunArgs,
  chownCacheArgs,
  makeTimer,
  runLaunch,
  volumeCreateArgs,
} from '../src/launch.js';
import type { RunSpec } from '../src/launch.js';
import type {
  CliDeps,
  ExecOptions,
  ExecResult,
} from '../src/types.js';

const VALID_CONFIG = {
  schemaVersion: 1,
  project: 'couetil-com',
  repo: 'couetilc/couetil.com',
  defaultBranch: 'main',
  ports: { astro: 4321 },
  agents: {
    claude: { model: 'claude-fable-5', effort: 'xhigh' },
    codex: { model: 'gpt-5.5', effort: 'xhigh' },
  },
  requiredEnv: [],
  caches: ['uv'],
};

// --- buildRunArgs golden (full parity with news's docker_args) -------------

describe('buildRunArgs', () => {
  it('assembles a full claude launch argv (golden)', () => {
    const spec: RunSpec = {
      containerName: 'agentic-couetil-com-claude-0105-030709-ab12',
      labels: [
        'agentic-coding.project=couetil-com',
        'agentic-coding.version=1.2.3',
      ],
      cacheMounts: [
        { volume: 'agentic-npm-cache', path: '/home/node/.npm' },
        { volume: 'agentic-couetil-com-uv', path: '/home/node/.cache/uv' },
      ],
      envFileArgs: [
        '--env-file',
        '/home/me/.config/agentic-coding/env',
        '--env-file',
        '/proj/.env',
      ],
      agentKind: 'claude',
      repo: 'couetilc/couetil.com',
      defaultBranch: 'main',
      gitUserName: 'Connor Couetil',
      gitUserEmail: 'connor@couetil.com',
      colorterm: 'truecolor',
      isTTY: true,
      timingEnv: [],
      agentEnv: [
        '-e',
        'CLAUDE_MODEL=claude-fable-5',
        '-e',
        'CLAUDE_EFFORT=xhigh',
      ],
      ports: [{ name: 'astro', container: 4321, host: 50000 }],
      image: 'agentic-coding-base:1.2.3',
      cmd: [
        'claude',
        '--dangerously-skip-permissions',
        '--model',
        'claude-fable-5',
        '--effort',
        'xhigh',
      ],
    };

    expect(buildRunArgs(spec)).toEqual([
      'run',
      '-it',
      '--name',
      'agentic-couetil-com-claude-0105-030709-ab12',
      '--label',
      'agentic-coding.project=couetil-com',
      '--label',
      'agentic-coding.version=1.2.3',
      '-v',
      'agentic-npm-cache:/home/node/.npm',
      '-v',
      'agentic-couetil-com-uv:/home/node/.cache/uv',
      '--env-file',
      '/home/me/.config/agentic-coding/env',
      '--env-file',
      '/proj/.env',
      '-e',
      'AGENT_KIND=claude',
      '-e',
      'REPO=couetilc/couetil.com',
      '-e',
      'DEFAULT_BRANCH=main',
      '-e',
      'GIT_USER_NAME=Connor Couetil',
      '-e',
      'GIT_USER_EMAIL=connor@couetil.com',
      '-e',
      'TERM=xterm-256color',
      '-e',
      'COLORTERM=truecolor',
      '-e',
      'CLAUDE_MODEL=claude-fable-5',
      '-e',
      'CLAUDE_EFFORT=xhigh',
      '-e',
      'DEV_HOST_ASTRO=127.0.0.1:50000',
      '-p',
      '127.0.0.1:50000:4321',
      'agentic-coding-base:1.2.3',
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'claude-fable-5',
      '--effort',
      'xhigh',
    ]);
  });

  it('has no --rm anywhere (containers are kept)', () => {
    const spec: RunSpec = {
      containerName: 'n',
      labels: [],
      cacheMounts: [],
      envFileArgs: [],
      agentKind: 'shell',
      repo: 'o/r',
      defaultBranch: 'main',
      gitUserName: 'A',
      gitUserEmail: 'a@b',
      colorterm: '',
      isTTY: true,
      timingEnv: [],
      agentEnv: [],
      ports: [],
      image: 'img',
      cmd: ['bash'],
    };
    expect(buildRunArgs(spec)).not.toContain('--rm');
  });

  it('requests a TTY (-it) only when isTTY, else -i (scriptable headless run)', () => {
    const base: RunSpec = {
      containerName: 'n',
      labels: [],
      cacheMounts: [],
      envFileArgs: [],
      agentKind: 'shell',
      repo: 'o/r',
      defaultBranch: 'main',
      gitUserName: 'A',
      gitUserEmail: 'a@b',
      colorterm: '',
      isTTY: true,
      timingEnv: [],
      agentEnv: [],
      ports: [],
      image: 'img',
      cmd: ['true'],
    };
    // Interactive terminal: identical to news's behavior (-it).
    const tty = buildRunArgs({ ...base, isTTY: true });
    expect(tty[1]).toBe('-it');
    // No terminal (piped/scripted): -i only, so docker doesn't reject with
    // "the input device is not a TTY".
    const headless = buildRunArgs({ ...base, isTTY: false });
    expect(headless[1]).toBe('-i');
    expect(headless).not.toContain('-it');
  });
});

// --- chownCacheArgs golden (the fresh-volume ownership fix) -----------------

describe('chownCacheArgs', () => {
  it('assembles the root chown pre-step argv (golden)', () => {
    expect(
      chownCacheArgs(
        [
          { volume: 'agentic-npm-cache', path: '/home/node/.npm' },
          { volume: 'agentic-couetil-com-uv', path: '/home/node/.cache/uv' },
        ],
        'agentic-coding-base:1.2.3',
      ),
    ).toEqual([
      'run',
      '--rm',
      '-u',
      '0',
      '-v',
      'agentic-npm-cache:/home/node/.npm',
      '-v',
      'agentic-couetil-com-uv:/home/node/.cache/uv',
      '--entrypoint',
      'chown',
      'agentic-coding-base:1.2.3',
      'node:node',
      '/home/node/.npm',
      '/home/node/.cache/uv',
    ]);
  });

  it('is non-recursive (no -R flag anywhere)', () => {
    // A recursive chown over a warm multi-GB cache would stall every launch;
    // only the mountpoint dir itself needs fixing.
    expect(
      chownCacheArgs([{ volume: 'v', path: '/p' }], 'img'),
    ).not.toContain('-R');
  });
});

// --- volumeCreateArgs (labeled cache volumes) --------------------------------

describe('volumeCreateArgs', () => {
  it('labels a project-scoped volume with managed + project', () => {
    expect(volumeCreateArgs('agentic-couetil-com-uv', 'couetil-com')).toEqual([
      'volume',
      'create',
      '--label',
      'agentic-coding.managed=1',
      '--label',
      'agentic-coding.project=couetil-com',
      'agentic-couetil-com-uv',
    ]);
  });

  it('labels the shared npm cache with managed only (it belongs to no project)', () => {
    expect(volumeCreateArgs('agentic-npm-cache', 'couetil-com')).toEqual([
      'volume',
      'create',
      '--label',
      'agentic-coding.managed=1',
      'agentic-npm-cache',
    ]);
  });
});

// --- runLaunch orchestration (exec stubbed) --------------------------------

const CONFIG_PATH = '/proj/.agent/config.js';
const DOCKERFILE = '/proj/.agent/Dockerfile';

interface Call {
  command: string;
  args: string[];
  options?: ExecOptions;
}

function makeDeps(over: Partial<CliDeps> = {}): {
  deps: CliDeps;
  calls: Call[];
  err: () => string;
} {
  const calls: Call[] = [];
  const errBuf: string[] = [];
  const exec = async (
    command: string,
    args: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> => {
    calls.push({ command, args, options });
    // git config user.name/user.email → a set identity; docker → success.
    if (command === 'git' && args[1] === 'user.name') {
      return { code: 0, stdout: 'Connor Couetil\n', stderr: '' };
    }
    if (command === 'git' && args[1] === 'user.email') {
      return { code: 0, stdout: 'connor@couetil.com\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps: CliDeps = {
    argv: ['claude'],
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    cwd: '/proj',
    version: '1.2.3',
    home: '/home/me',
    isTTY: true,
    now: () => new Date(2026, 0, 5, 3, 7, 9),
    nameSuffix: () => 'ab12',
    packageDockerDir: '/pkg/docker',
    packageTemplatesDir: '/pkg/templates',
    port: { tryListen: async () => true, randomInt: () => 50000 },
    out: () => {},
    err: (t) => errBuf.push(t),
    writeTextFile: () => {},
    makeExecutable: () => {},
    mkdirp: () => {},
    // Config present; no overlay Dockerfile by default.
    fileExists: (p) => p === CONFIG_PATH,
    readTextFile: (path) =>
      path === '/proj/.env'
        ? 'GH_TOKEN=gh'
        : path === '/home/me/.config/agentic-coding/env'
          ? 'CLAUDE_CODE_OAUTH_TOKEN=oauth'
          : undefined,
    importModule: async () => ({ default: VALID_CONFIG }),
    exec,
    ...over,
  };
  return { deps, calls, err: () => errBuf.join('') };
}

// The MAIN run (has -it with a tty, -i without); the chown pre-step is also
// `docker run` but distinguished by --rm/-u 0.
function dockerRun(calls: Call[]): Call {
  const call = calls.find(
    (c) =>
      c.command === 'docker' &&
      c.args[0] === 'run' &&
      (c.args[1] === '-it' || c.args[1] === '-i'),
  );
  if (call === undefined) {
    throw new Error('no docker run call recorded');
  }
  return call;
}

function chownPreStep(calls: Call[]): Call {
  const call = calls.find(
    (c) => c.command === 'docker' && c.args[0] === 'run' && c.args[1] === '--rm',
  );
  if (call === undefined) {
    throw new Error('no chown pre-step call recorded');
  }
  return call;
}

describe('runLaunch', () => {
  it('runs a full claude launch and returns the container exit code', async () => {
    const { deps, calls } = makeDeps();
    expect(await runLaunch(deps)).toBe(0);
    const run = dockerRun(calls);
    // A representative slice of the parity contract.
    expect(run.args).toContain('-it');
    expect(run.args).toContain('AGENT_KIND=claude');
    expect(run.args).toContain('REPO=couetilc/couetil.com');
    expect(run.args).toContain('DEFAULT_BRANCH=main');
    expect(run.args).toContain('GIT_USER_NAME=Connor Couetil');
    expect(run.args).toContain('agentic-npm-cache:/home/node/.npm');
    expect(run.args).toContain('DEV_HOST_ASTRO=127.0.0.1:50000');
    expect(run.args).toContain('127.0.0.1:50000:4321');
    expect(run.args).toContain('CLAUDE_MODEL=claude-fable-5');
    // TERM is the literal xterm-256color, never the host's $TERM (which was
    // xterm-256color here anyway — see the dedicated test below).
    expect(run.args).toContain('TERM=xterm-256color');
    expect(run.args).not.toContain('--rm');
    // The name uses the injected clock and suffix.
    expect(run.args).toContain('agentic-couetil-com-claude-0105-030709-ab12');
    // stdio inherited for the interactive run.
    expect(run.options?.stdio).toBe('inherit');

    // The cache-volume chown pre-step ran BEFORE the main run, with the exact
    // chownCacheArgs argv for this config's mounts (npm + uv).
    const prep = chownPreStep(calls);
    expect(prep.args).toEqual(
      chownCacheArgs(
        [
          { volume: 'agentic-npm-cache', path: '/home/node/.npm' },
          { volume: 'agentic-couetil-com-uv', path: '/home/node/.cache/uv' },
        ],
        'agentic-coding-base:1.2.3',
      ),
    );
    expect(calls.indexOf(prep)).toBeLessThan(calls.indexOf(run));
  });

  it('pre-creates labeled cache volumes before the chown pre-step', async () => {
    const { deps, calls } = makeDeps();
    expect(await runLaunch(deps)).toBe(0);
    const creates = calls.filter(
      (c) => c.command === 'docker' && c.args[0] === 'volume',
    );
    expect(creates.map((c) => c.args)).toEqual([
      volumeCreateArgs('agentic-npm-cache', 'couetil-com'),
      volumeCreateArgs('agentic-couetil-com-uv', 'couetil-com'),
    ]);
    const prep = chownPreStep(calls);
    expect(calls.indexOf(creates[1])).toBeLessThan(calls.indexOf(prep));
  });

  it('runs the retention sweep at launch and writes the throttle marker', async () => {
    const writes: Record<string, string> = {};
    const { deps, calls } = makeDeps({
      writeTextFile: (path, content) => {
        writes[path] = content;
      },
    });
    expect(await runLaunch(deps)).toBe(0);
    // The sweep's label-scoped listing ran (empty stdout → nothing to remove).
    expect(
      calls.some(
        (c) =>
          c.command === 'docker' &&
          c.args[0] === 'ps' &&
          c.args.includes('{{.ID}}\t{{.CreatedAt}}\t{{.Status}}'),
      ),
    ).toBe(true);
    expect(Object.keys(writes)).toEqual([
      '/home/me/.config/agentic-coding/sweep-couetil-com.json',
    ]);
  });

  it('skips the sweep entirely when the marker is fresh (throttled)', async () => {
    const markerPath = '/home/me/.config/agentic-coding/sweep-couetil-com.json';
    const nowMs = new Date(2026, 0, 5, 3, 7, 9).getTime();
    const { deps, calls } = makeDeps({
      readTextFile: (path) => {
        if (path === markerPath) {
          return JSON.stringify({ lastSweepAt: nowMs - 1000 });
        }
        if (path === '/proj/.env') return 'GH_TOKEN=gh';
        if (path === '/home/me/.config/agentic-coding/env')
          return 'CLAUDE_CODE_OAUTH_TOKEN=oauth';
        return undefined;
      },
    });
    expect(await runLaunch(deps)).toBe(0);
    expect(calls.some((c) => c.command === 'docker' && c.args[0] === 'ps')).toBe(
      false,
    );
  });

  it('a sweep failure never blocks the launch (marker records the error)', async () => {
    const writes: Record<string, string> = {};
    const { deps } = makeDeps({
      writeTextFile: (path, content) => {
        writes[path] = content;
      },
      exec: async (command, args) => {
        if (command === 'git') {
          return {
            code: 0,
            stdout: args[1] === 'user.name' ? 'A\n' : 'a@b\n',
            stderr: '',
          };
        }
        // Only the sweep's listing explodes; everything else succeeds.
        if (args[0] === 'ps') {
          throw new Error('spawn docker ENOENT');
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runLaunch(deps)).toBe(0);
    expect(
      JSON.parse(
        writes['/home/me/.config/agentic-coding/sweep-couetil-com.json'],
      ).lastError,
    ).toContain('docker is not available');
  });

  it('hardcodes TERM=xterm-256color even when the host TERM differs', async () => {
    // Forwarding e.g. xterm-ghostty breaks terminfo lookup inside the
    // node:24-slim container ('unknown terminal "xterm-ghostty"').
    const { deps, calls } = makeDeps({
      env: { TERM: 'xterm-ghostty', COLORTERM: 'truecolor' },
    });
    expect(await runLaunch(deps)).toBe(0);
    const run = dockerRun(calls);
    expect(run.args).toContain('TERM=xterm-256color');
    expect(run.args).not.toContain('TERM=xterm-ghostty');
  });

  it('shell skips agent credentials but still needs GH_TOKEN; runs the cmd directly', async () => {
    const { deps, calls } = makeDeps({
      argv: ['shell', 'ls', '-la'],
      // No agent creds at all — shell must not care.
      readTextFile: (path) => (path === '/proj/.env' ? 'GH_TOKEN=gh' : undefined),
    });
    expect(await runLaunch(deps)).toBe(0);
    const run = dockerRun(calls);
    expect(run.args).toContain('AGENT_KIND=shell');
    // The command is exec'd directly (entrypoint `exec "$@"`), NOT `bash ls -la`
    // which would treat `ls` as a script file.
    expect(run.args.slice(-2)).toEqual(['ls', '-la']);
    // No CLAUDE_MODEL / auth env for a shell.
    expect(run.args).not.toContain('CLAUDE_MODEL=claude-fable-5');
  });

  it('shell with no command opens an interactive bash', async () => {
    const { deps, calls } = makeDeps({
      argv: ['shell'],
      readTextFile: (path) => (path === '/proj/.env' ? 'GH_TOKEN=gh' : undefined),
    });
    expect(await runLaunch(deps)).toBe(0);
    const run = dockerRun(calls);
    expect(run.args.slice(-1)).toEqual(['bash']);
  });

  it('strips a leading -- separator and runs the tail (scriptable shell -- true)', async () => {
    const { deps, calls } = makeDeps({
      argv: ['shell', '--', 'true'],
      isTTY: false, // scripted: no -t
      readTextFile: (path) => (path === '/proj/.env' ? 'GH_TOKEN=gh' : undefined),
    });
    expect(await runLaunch(deps)).toBe(0);
    const run = dockerRun(calls);
    // -i (no -t) so docker accepts it without a terminal.
    expect(run.args[1]).toBe('-i');
    // CMD is just `true`; the `--` is consumed, not passed to the container.
    expect(run.args.slice(-1)).toEqual(['true']);
    expect(run.args).not.toContain('--');
  });

  it('codex keeps CODEX_AUTH_B64 off the argv but in the docker child env', async () => {
    const { deps, calls } = makeDeps({
      argv: ['codex', '-p', 'do it'],
      readTextFile: (path) => {
        if (path === '/proj/.env') return 'GH_TOKEN=gh';
        if (path === '/home/me/.codex/auth.json') return '{"tok":"secret"}';
        return undefined;
      },
    });
    expect(await runLaunch(deps)).toBe(0);
    const run = dockerRun(calls);
    // Bare -e on argv; the base64 secret is NOT there.
    expect(run.args).toContain('CODEX_AUTH_B64');
    expect(run.args.join(' ')).not.toContain('secret');
    // The value is injected into the docker CLIENT process env instead.
    expect(run.options?.env?.CODEX_AUTH_B64).toBe(
      Buffer.from('{"tok":"secret"}', 'utf8').toString('base64'),
    );
    // -p maps to `codex exec`; the CMD is the argv tail.
    expect(run.args.slice(-8)).toEqual([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5.5',
      '--config',
      'model_reasoning_effort="xhigh"',
      'do it',
    ]);
  });

  it('errors when config is absent (no default export)', async () => {
    const { deps } = makeDeps({ fileExists: () => true, importModule: async () => ({}) });
    // importModule returns no default → ConfigError, printed and 1.
    expect(await runLaunch(deps)).toBe(1);
  });

  it('errors (naming key + file) when GH_TOKEN is missing, before any docker call', async () => {
    const { deps, calls, err } = makeDeps({
      readTextFile: () => undefined, // no env files
    });
    expect(await runLaunch(deps)).toBe(1);
    expect(err()).toContain('GH_TOKEN is not set — add it to ./.env');
    expect(calls.some((c) => c.command === 'docker')).toBe(false);
  });

  it('errors when a required env key is missing', async () => {
    const { deps, err } = makeDeps({
      importModule: async () => ({
        default: { ...VALID_CONFIG, requiredEnv: ['DEPLOY_TOKEN'] },
      }),
      readTextFile: (path) =>
        path === '/proj/.env'
          ? 'GH_TOKEN=gh'
          : path === '/home/me/.config/agentic-coding/env'
            ? 'CLAUDE_CODE_OAUTH_TOKEN=oauth'
            : undefined,
    });
    expect(await runLaunch(deps)).toBe(1);
    expect(err()).toContain('DEPLOY_TOKEN is not set — add it to ./.env');
  });

  it('errors when the agent credential is missing', async () => {
    const { deps, err } = makeDeps({
      // GH_TOKEN present but no CLAUDE_CODE_OAUTH_TOKEN anywhere.
      readTextFile: (path) => (path === '/proj/.env' ? 'GH_TOKEN=gh' : undefined),
    });
    expect(await runLaunch(deps)).toBe(1);
    expect(err()).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('errors when the host git identity is unset', async () => {
    const { deps, err } = makeDeps({
      exec: async (command, args) => {
        if (command === 'git') return { code: 1, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runLaunch(deps)).toBe(1);
    expect(err()).toContain('host git identity is unset');
  });

  it('bails on a base build failure', async () => {
    const { deps } = makeDeps({
      fileExists: (p) => p === CONFIG_PATH, // config present, no overlay
      exec: async (command, args) => {
        if (command === 'git') {
          return {
            code: 0,
            stdout: args[1] === 'user.name' ? 'A\n' : 'a@b\n',
            stderr: '',
          };
        }
        // inspect fails (missing) → build; build fails with code 5.
        if (args[0] === 'image' && args[1] === 'inspect') {
          return { code: 1, stdout: '', stderr: '' };
        }
        if (args[0] === 'build') return { code: 5, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runLaunch(deps)).toBe(5);
  });

  it('bails on an overlay build failure', async () => {
    const { deps } = makeDeps({
      // config + .agent/Dockerfile present → overlay build attempted.
      fileExists: (p) => p === CONFIG_PATH || p === DOCKERFILE,
      exec: async (command, args) => {
        if (command === 'git') {
          return {
            code: 0,
            stdout: args[1] === 'user.name' ? 'A\n' : 'a@b\n',
            stderr: '',
          };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return { code: 0, stdout: '', stderr: '' }; // base present
        }
        if (args[0] === 'build') return { code: 9, stdout: '', stderr: '' }; // overlay build
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runLaunch(deps)).toBe(9);
  });

  it('runs with no named ports (no -p / DEV_HOST args) and defaults COLORTERM', async () => {
    const { deps, calls } = makeDeps({
      env: {}, // no COLORTERM → empty; TERM is always the literal
      importModule: async () => ({ default: { ...VALID_CONFIG, ports: {} } }),
    });
    expect(await runLaunch(deps)).toBe(0);
    const run = dockerRun(calls);
    expect(run.args).not.toContain('-p');
    expect(run.args).toContain('TERM=xterm-256color');
    expect(run.args).toContain('COLORTERM=');
  });

  it('errors before docker when an env file has a line docker would reject', async () => {
    const { deps, calls, err } = makeDeps({
      readTextFile: (path) =>
        // `export ` prefix: our parser skips it (so GH_TOKEN also reads as
        // missing) AND flags the line docker would hard-error on.
        path === '/proj/.env' ? 'export GH_TOKEN=x' : undefined,
    });
    expect(await runLaunch(deps)).toBe(1);
    const text = err();
    expect(text).toContain('./.env: variable "export GH_TOKEN"');
    expect(text).toContain("drop the 'export ' prefix");
    expect(text).toContain('GH_TOKEN is not set — add it to ./.env');
    expect(calls.some((c) => c.command === 'docker')).toBe(false);
  });

  it('fails with the pre-step code and stderr when the cache chown fails', async () => {
    const { deps, err } = makeDeps({
      exec: async (command, args) => {
        if (command === 'git') {
          return {
            code: 0,
            stdout: args[1] === 'user.name' ? 'A\n' : 'a@b\n',
            stderr: '',
          };
        }
        if (args[0] === 'run' && args[1] === '--rm') {
          return { code: 3, stdout: '', stderr: 'boom from docker' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runLaunch(deps)).toBe(3);
    expect(err()).toContain('preparing cache volumes failed (docker exited 3)');
    expect(err()).toContain('boom from docker');
  });

  it('coerces a null pre-step code to 1 (no stderr suffix)', async () => {
    const { deps, err } = makeDeps({
      exec: async (command, args) => {
        if (command === 'git') {
          return {
            code: 0,
            stdout: args[1] === 'user.name' ? 'A\n' : 'a@b\n',
            stderr: '',
          };
        }
        if (args[0] === 'run' && args[1] === '--rm') {
          return { code: null, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runLaunch(deps)).toBe(1);
    expect(err()).toContain('preparing cache volumes failed (docker exited null)');
  });

  it('coerces a null docker run exit code to 1', async () => {
    const { deps } = makeDeps({
      exec: async (command, args) => {
        if (command === 'git') {
          return {
            code: 0,
            stdout: args[1] === 'user.name' ? 'A\n' : 'a@b\n',
            stderr: '',
          };
        }
        // Only the MAIN -it run fails; the chown pre-step succeeds.
        if (args[0] === 'run' && args[1] === '-it') {
          return { code: null, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await runLaunch(deps)).toBe(1);
  });

  it('prints one actionable line and exits 1 when docker cannot be spawned', async () => {
    const { deps, err } = makeDeps({
      exec: async (command, args) => {
        if (command === 'git') {
          return {
            code: 0,
            stdout: args[1] === 'user.name' ? 'A\n' : 'a@b\n',
            stderr: '',
          };
        }
        // realExec rejects on spawn ENOENT when docker isn't installed.
        throw new Error('spawn docker ENOENT');
      },
    });
    expect(await runLaunch(deps)).toBe(1);
    expect(err()).toContain('docker is not available (spawn docker ENOENT)');
    expect(err()).toContain('install Docker');
    // One line, not a stack trace.
    expect(err()).not.toContain('    at ');
  });
});

// --- launch timing (issue #8) -----------------------------------------------

describe('makeTimer', () => {
  it('is disabled and silent without AGENT_TIMING', () => {
    const buf: string[] = [];
    const timer = makeTimer({
      env: {},
      now: () => new Date(1000),
      err: (t) => buf.push(t),
    });
    expect(timer.enabled).toBe(false);
    timer.mark('anything');
    expect(buf).toEqual([]);
  });

  it('prints per-stage deltas from the injected clock', () => {
    const buf: string[] = [];
    const times = [1000, 1400, 1650];
    let i = 0;
    const timer = makeTimer({
      env: { AGENT_TIMING: '1' },
      now: () => new Date(times[Math.min(i++, times.length - 1)]),
      err: (t) => buf.push(t),
    });
    timer.mark('stage one');
    timer.mark('stage two');
    const text = buf.join('');
    expect(text).toMatch(/\[agent-timing\] stage one\s+400 ms\n/);
    expect(text).toMatch(/\[agent-timing\] stage two\s+250 ms\n/);
  });
});

describe('runLaunch — timing (issue #8)', () => {
  it('with AGENT_TIMING set: prints host stage marks and forwards timing env', async () => {
    const { deps, calls, err } = makeDeps({
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', AGENT_TIMING: '1' },
    });
    expect(await runLaunch(deps)).toBe(0);
    const text = err();
    for (const stage of [
      'config + env preflight',
      'host git identity',
      'retention sweep',
      'base image check',
      'overlay image',
      'cache volume prep',
    ]) {
      expect(text).toContain(`[agent-timing] ${stage}`);
    }
    // The container gets AGENT_TIMING plus the host's pre-run wall clock (ms),
    // spliced between COLORTERM and the agent env.
    const run = dockerRun(calls);
    expect(run.args).toContain('AGENT_TIMING=1');
    const t0 = run.args.find((a) => a.startsWith('AGENT_LAUNCH_T0='));
    expect(t0).toBe(`AGENT_LAUNCH_T0=${new Date(2026, 0, 5, 3, 7, 9).getTime()}`);
    expect(run.args.indexOf('AGENT_TIMING=1')).toBeGreaterThan(
      run.args.indexOf('COLORTERM=truecolor'),
    );
    expect(run.args.indexOf('AGENT_TIMING=1')).toBeLessThan(
      run.args.indexOf('CLAUDE_MODEL=claude-fable-5'),
    );
  });

  it('without AGENT_TIMING: no marks on stderr, no timing env on the argv', async () => {
    const { deps, calls, err } = makeDeps();
    expect(await runLaunch(deps)).toBe(0);
    expect(err()).not.toContain('[agent-timing]');
    expect(dockerRun(calls).args.join(' ')).not.toContain('AGENT_TIMING');
    expect(dockerRun(calls).args.join(' ')).not.toContain('AGENT_LAUNCH_T0');
  });
});
