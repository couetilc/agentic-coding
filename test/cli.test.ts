import {
  mkdtempSync,
  realpathSync,
  rmSync,
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
    out: (t) => outBuf.push(t),
    err: (t) => errBuf.push(t),
    fileExists: () => false,
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
    'refuses %s as not implemented (phase 2)',
    async (cmd) => {
      const c = makeDeps({ argv: [cmd] });
      expect(await run(c.deps)).toBe(1);
      expect(c.err()).toContain('not implemented yet (phase 2)');
    },
  );

  it('refuses init as not implemented (phase 3)', async () => {
    const c = makeDeps({ argv: ['init'] });
    expect(await run(c.deps)).toBe(1);
    expect(c.err()).toContain('not implemented yet (phase 3)');
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
  it('prints the resolved config and placeholder sections, exit 0', async () => {
    const c = makeDeps({
      argv: ['doctor'],
      fileExists: () => true,
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
    expect(text).toContain('Images');
    expect(text).toContain('Environment');
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
    // Exercise each closure (writing empty strings is harmless).
    d.out('');
    d.err('');
    expect(d.fileExists(fileURLToPath(import.meta.url))).toBe(true);
    expect(d.fileExists('/definitely/not/here')).toBe(false);
    await expect(d.importModule('node:os')).resolves.toBeDefined();
    expect(typeof d.exec).toBe('function');
  });
});
