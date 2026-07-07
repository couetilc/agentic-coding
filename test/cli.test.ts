import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isEntry, makeRealDeps, run } from '../src/cli.js';
import type { CliDeps } from '../src/types.js';

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

interface Captured {
  deps: CliDeps;
  out: () => string;
  err: () => string;
}

function makeDeps(over: Partial<CliDeps> = {}): Captured {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const deps: CliDeps = {
    argv: [],
    env: {},
    cwd: '/proj',
    version: '9.9.9',
    home: '/home/me',
    isTTY: false,
    now: () => new Date(2026, 0, 5, 3, 7, 9),
    packageDockerDir: '/pkg/docker',
    packageTemplatesDir: '/pkg/templates',
    port: { tryListen: async () => true, randomInt: () => 50000 },
    out: (t) => outBuf.push(t),
    err: (t) => errBuf.push(t),
    fileExists: () => false,
    readTextFile: () => undefined,
    writeTextFile: () => {},
    makeExecutable: () => {},
    mkdirp: () => {},
    importModule: async () => ({}),
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    ...over,
  };
  return { deps, out: () => outBuf.join(''), err: () => errBuf.join('') };
}

describe('run — dispatch', () => {
  it('prints usage to stdout for --help and exits 0', async () => {
    const c = makeDeps({ argv: ['--help'] });
    expect(await run(c.deps)).toBe(0);
    expect(c.out()).toContain('Usage: agent');
    expect(c.err()).toBe('');
  });

  it('prints usage to stdout for -h and exits 0', async () => {
    const c = makeDeps({ argv: ['-h'] });
    expect(await run(c.deps)).toBe(0);
    expect(c.out()).toContain('Usage: agent');
  });

  it('errors to stderr with usage when no command is given', async () => {
    const c = makeDeps({ argv: [] });
    expect(await run(c.deps)).toBe(1);
    expect(c.err()).toContain('missing command');
    expect(c.err()).toContain('Usage: agent');
  });

  it('errors to stderr with usage for an unknown command', async () => {
    const c = makeDeps({ argv: ['frobnicate'] });
    expect(await run(c.deps)).toBe(1);
    expect(c.err()).toContain("unknown command 'frobnicate'");
  });

  it.each(['claude', 'codex', 'shell', 'clean'])(
    'dispatches %s and surfaces the config error when .agent/config.js is absent',
    async (cmd) => {
      // fileExists:()=>false → loadConfig throws → the launch/clean path prints
      // the actionable config error and exits 1 (proves real dispatch).
      const c = makeDeps({ argv: [cmd] });
      expect(await run(c.deps)).toBe(1);
      expect(c.err()).toContain('run `agent init`');
    },
  );

  it('dispatches init and surfaces the not-a-git-repo error (proves real dispatch)', async () => {
    // The default exec stub returns exit 0 with empty stdout, so
    // `git rev-parse --is-inside-work-tree` yields '' (not 'true') → init
    // refuses with the actionable error. (The success path is covered against
    // real git fixtures in scaffold.test.ts.)
    const c = makeDeps({ argv: ['init'] });
    expect(await run(c.deps)).toBe(1);
    expect(c.err()).toContain('not a git repository');
  });

  it('runs clean with a valid config (label-scoped prune + rebuild)', async () => {
    const calls: string[][] = [];
    const c = makeDeps({
      argv: ['clean'],
      fileExists: (p) => p === '/proj/.agent/config.js',
      importModule: async () => ({ default: VALID_CONFIG }),
      exec: async (_cmd, args) => {
        calls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await run(c.deps)).toBe(0);
    // The prune list must be scoped to THIS project's label (the §2 bug fix).
    expect(calls[0]).toEqual([
      'ps',
      '-aq',
      '--filter',
      'label=agentic-coding.project=couetil-com',
      '--filter',
      'status=exited',
    ]);
  });

  it('clean prints one actionable line and exits 1 when docker cannot be spawned', async () => {
    const c = makeDeps({
      argv: ['clean'],
      fileExists: (p) => p === '/proj/.agent/config.js',
      importModule: async () => ({ default: VALID_CONFIG }),
      exec: async () => {
        throw new Error('spawn docker ENOENT');
      },
    });
    expect(await run(c.deps)).toBe(1);
    expect(c.err()).toContain('docker is not available (spawn docker ENOENT)');
    expect(c.err()).toContain('install Docker');
  });

  it('refuses to run inside a container (IS_SANDBOX=1) for every command', async () => {
    for (const cmd of ['claude', 'codex', 'shell', 'clean', 'init', 'doctor']) {
      const c = makeDeps({ argv: [cmd], env: { IS_SANDBOX: '1' } });
      expect(await run(c.deps)).toBe(1);
      expect(c.err()).toContain('cannot run inside an agent container');
    }
  });
});

describe('run — doctor', () => {
  it('prints the resolved config plus real image and environment sections, exit 0', async () => {
    const c = makeDeps({
      argv: ['doctor'],
      // Config present; no overlay Dockerfile.
      fileExists: (p) => p === '/proj/.agent/config.js',
      // exit 0 from `docker image inspect` → base image present.
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      // Only the project .env exists, carrying GH_TOKEN (value must not leak).
      readTextFile: (path) =>
        path === '/proj/.env' ? 'GH_TOKEN=secret-token\n' : undefined,
      importModule: async () => ({ default: VALID_CONFIG }),
    });
    expect(await run(c.deps)).toBe(0);
    const text = c.out();
    expect(text).toContain('project        couetil-com');
    expect(text).toContain('image          agentic-couetil-com');
    expect(text).toContain('agentic-coding.version=9.9.9');
    expect(text).toContain('astro → 4321 (as $DEV_HOST_ASTRO)');
    expect(text).toContain('caches         agentic-npm-cache, agentic-couetil-com-uv');
    expect(text).toContain('requiredEnv    (none)');
    // Real Images section: versioned base present; overlay uses base (no Dockerfile).
    expect(text).toContain('base     agentic-coding-base:9.9.9 — present');
    expect(text).toContain('.agent/Dockerfile absent');
    // Real Environment section: files, redacted keys, GH_TOKEN verdict.
    expect(text).toContain('project ./.env — found');
    expect(text).toContain('host    ~/.config/agentic-coding/env — missing');
    expect(text).toContain('keys           GH_TOKEN (values redacted)');
    expect(text).toContain('GH_TOKEN       present');
    expect(text).not.toContain('secret-token');
  });

  it('reports missing images and credentials when nothing is present', async () => {
    const c = makeDeps({
      argv: ['doctor'],
      fileExists: () => true,
      exec: async () => ({ code: 1, stdout: '', stderr: '' }), // inspect fails
      readTextFile: () => undefined,
      importModule: async () => ({ default: VALID_CONFIG }),
    });
    expect(await run(c.deps)).toBe(0);
    const text = c.out();
    expect(text).toContain('base     agentic-coding-base:9.9.9 — missing');
    expect(text).toContain('GH_TOKEN       MISSING — add to ./.env');
    expect(text).toContain('claude cred    MISSING');
    expect(text).toContain('codex cred     MISSING');
  });

  it('still renders every section when docker cannot be spawned (fresh machine)', async () => {
    const c = makeDeps({
      argv: ['doctor'],
      fileExists: (p) => p === '/proj/.agent/config.js',
      importModule: async () => ({ default: VALID_CONFIG }),
      readTextFile: (path) =>
        path === '/proj/.env' ? 'GH_TOKEN=gh\n' : undefined,
      exec: async () => {
        throw new Error('spawn docker ENOENT');
      },
    });
    expect(await run(c.deps)).toBe(0);
    const text = c.out();
    // All three sections render; Images explains docker is missing.
    expect(text).toContain('project        couetil-com');
    expect(text).toContain('Images');
    expect(text).toContain('docker is not available (spawn docker ENOENT)');
    expect(text).toContain('install Docker');
    expect(text).toContain('GH_TOKEN       present');
  });

  it('shows credentials present when the env files carry them', async () => {
    const c = makeDeps({
      argv: ['doctor'],
      fileExists: () => true,
      readTextFile: (path) => {
        if (path === '/proj/.env') return 'GH_TOKEN=g';
        if (path === '/home/me/.config/agentic-coding/env')
          return 'CLAUDE_CODE_OAUTH_TOKEN=c\nOPENAI_API_KEY=o';
        return undefined;
      },
      importModule: async () => ({ default: VALID_CONFIG }),
    });
    expect(await run(c.deps)).toBe(0);
    const text = c.out();
    expect(text).toContain('claude cred    present');
    expect(text).toContain('codex cred     present');
  });

  it('renders (none) for empty ports and lists a populated requiredEnv', async () => {
    const c = makeDeps({
      argv: ['doctor'],
      fileExists: () => true,
      importModule: async () => ({
        default: { ...VALID_CONFIG, ports: {}, requiredEnv: ['DEPLOY_TOKEN'] },
      }),
    });
    expect(await run(c.deps)).toBe(0);
    const text = c.out();
    expect(text).toContain('ports          (none)');
    expect(text).toContain('requiredEnv    DEPLOY_TOKEN');
  });

  it('prints an actionable error section and exits 1 when config is missing', async () => {
    const c = makeDeps({ argv: ['doctor'], fileExists: () => false });
    expect(await run(c.deps)).toBe(1);
    const text = c.out();
    expect(text).toContain('Config');
    expect(text).toContain('run `agent init`');
  });
});

describe('isEntry', () => {
  it('is false when argv[1] is undefined', () => {
    expect(isEntry('file:///a/cli.js', undefined)).toBe(false);
  });

  it('matches through a symlinked argv[1] (npm bin stubs are symlinks)', () => {
    // Node realpaths the entry module's import.meta.url but argv[1] keeps the
    // invoked (symlink) path — isEntry must bridge that or npx never matches.
    const dir = mkdtempSync(join(tmpdir(), 'agentic-isentry-'));
    try {
      const real = join(dir, 'cli.js');
      const link = join(dir, 'bin-stub');
      writeFileSync(real, '');
      symlinkSync(real, link);
      // mkdtemp on macOS returns paths under /var (a symlink to /private/var);
      // realpath the expected side too, as Node does for import.meta.url.
      const metaUrl = pathToFileURL(realpathSync(real)).href;
      expect(isEntry(metaUrl, link)).toBe(true);
      expect(isEntry(metaUrl, real)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is true when the module URL matches argv[1] directly (real file)', () => {
    const self = fileURLToPath(import.meta.url);
    expect(isEntry(pathToFileURL(realpathSync(self)).href, self)).toBe(true);
  });

  it('falls back to the unresolved path when argv[1] does not exist', () => {
    // catch branch: realpathSync throws, the raw path is compared instead.
    expect(isEntry('file:///a/cli.js', fileURLToPath('file:///a/cli.js'))).toBe(
      true,
    );
    expect(isEntry('file:///a/cli.js', '/other/missing.js')).toBe(false);
  });

  it('is false when argv[1] points at a different existing file', () => {
    expect(isEntry('file:///a/cli.js', fileURLToPath(import.meta.url))).toBe(
      false,
    );
  });
});

describe('makeRealDeps', () => {
  it('wires real process/fs/import closures', async () => {
    const d = makeRealDeps();
    expect(Array.isArray(d.argv)).toBe(true);
    expect(typeof d.version).toBe('string');
    expect(d.version.length).toBeGreaterThan(0);
    expect(d.cwd).toBe(process.cwd());
    expect(typeof d.home).toBe('string');
    expect(d.home.length).toBeGreaterThan(0);
    expect(typeof d.isTTY).toBe('boolean');
    expect(d.now()).toBeInstanceOf(Date);
    expect(d.packageDockerDir.replace(/\\/g, '/')).toMatch(/\/docker$/);
    expect(d.packageTemplatesDir.replace(/\\/g, '/')).toMatch(/\/templates$/);
    expect(typeof d.port.randomInt).toBe('function');
    expect(typeof d.port.tryListen).toBe('function');
    // Exercise each closure (writing empty strings is harmless).
    d.out('');
    d.err('');
    expect(d.fileExists(fileURLToPath(import.meta.url))).toBe(true);
    expect(d.fileExists('/definitely/not/here')).toBe(false);
    // readTextFile: reads an existing file; returns undefined on a missing one
    // (the catch branch).
    expect(d.readTextFile(fileURLToPath(import.meta.url))).toContain('makeRealDeps');
    expect(d.readTextFile('/definitely/not/here')).toBeUndefined();
    // Exercise the fs-mutation seams against a real tmp dir.
    const dir = mkdtempSync(join(tmpdir(), 'agentic-realdeps-'));
    try {
      const sub = join(dir, 'a', 'b');
      d.mkdirp(sub);
      const file = join(sub, 'shim');
      d.writeTextFile(file, 'hi');
      d.makeExecutable(file);
      expect(readFileSync(file, 'utf8')).toBe('hi');
      expect(statSync(file).mode & 0o111).not.toBe(0); // executable bits set
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(d.importModule('node:os')).resolves.toBeDefined();
    expect(typeof d.exec).toBe('function');
  });
});
