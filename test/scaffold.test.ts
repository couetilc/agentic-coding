import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { realExec } from '../src/exec.js';
import {
  majorVersion,
  normalizeRemote,
  packageTemplatesDir,
  render,
  runInit,
  slugify,
} from '../src/scaffold.js';
import type { ExecResult, ScaffoldDeps } from '../src/types.js';

// --- Pure functions --------------------------------------------------------

describe('normalizeRemote', () => {
  it('normalizes every form git emits to owner/name', () => {
    // scp-like SSH
    expect(normalizeRemote('git@github.com:couetilc/couetil.com.git')).toBe(
      'couetilc/couetil.com',
    );
    expect(normalizeRemote('git@github.com:owner/name')).toBe('owner/name');
    // HTTPS, with and without .git
    expect(normalizeRemote('https://github.com/owner/name.git')).toBe(
      'owner/name',
    );
    expect(normalizeRemote('https://github.com/owner/name')).toBe('owner/name');
    // ssh:// URL form (optional user)
    expect(normalizeRemote('ssh://git@github.com/owner/name.git')).toBe(
      'owner/name',
    );
    // trailing slash (and .git) stripped
    expect(normalizeRemote('https://github.com/owner/name/')).toBe('owner/name');
    expect(normalizeRemote('https://github.com/owner/name.git/')).toBe(
      'owner/name',
    );
  });

  it('returns undefined for anything without a parseable owner/name', () => {
    expect(normalizeRemote('')).toBeUndefined();
    expect(normalizeRemote('   ')).toBeUndefined();
    expect(normalizeRemote('.git')).toBeUndefined();
    expect(normalizeRemote('not-a-remote')).toBeUndefined();
    // A URL with a single path segment has no owner.
    expect(normalizeRemote('https://github.com/owner')).toBeUndefined();
  });
});

describe('slugify', () => {
  it('lowercases and turns non-slug runs into single hyphens, trimmed', () => {
    expect(slugify('couetil.com')).toBe('couetil-com');
    expect(slugify('My_Repo')).toBe('my-repo');
    expect(slugify('a..b__c')).toBe('a-b-c');
    expect(slugify('-Edge-.')).toBe('edge');
    expect(slugify('already-slug')).toBe('already-slug');
  });
});

describe('majorVersion', () => {
  it('takes the leading semver segment', () => {
    expect(majorVersion('0.1.0')).toBe('0');
    expect(majorVersion('1.2.3')).toBe('1');
    expect(majorVersion('10.0.0-beta.1')).toBe('10');
  });
});

describe('render', () => {
  it('substitutes known tokens and leaves unknown ones intact', () => {
    expect(render('{{A}}/{{B}}', { A: 'x', B: 'y' })).toBe('x/y');
    expect(render('{{A}} {{MISSING}}', { A: 'x' })).toBe('x {{MISSING}}');
  });
});

describe('packageTemplatesDir', () => {
  it('resolves the package templates/ directory (with the shipped templates)', () => {
    const dir = packageTemplatesDir();
    expect(dir.replace(/\\/g, '/')).toMatch(/\/templates$/);
    expect(existsSync(join(dir, 'config.js.tmpl'))).toBe(true);
  });
});

// --- Derivation + written content, via a stubbed git exec + capturing fs ----

interface GitState {
  insideWorkTree?: boolean; // default true
  originUrl?: string | null; // null → `git remote get-url` fails
  originHead?: string; // absent → symbolic-ref origin/HEAD fails
  currentBranch?: string; // absent → symbolic-ref --short HEAD fails
}

function gitHandler(state: GitState): (args: string[]) => Partial<ExecResult> {
  return (args) => {
    if (args[0] === 'rev-parse') {
      return state.insideWorkTree === false
        ? { code: 128, stderr: 'not a work tree' }
        : { code: 0, stdout: 'true\n' };
    }
    if (args[0] === 'remote') {
      if (state.originUrl === null) {
        return { code: 2, stderr: 'No such remote' };
      }
      return {
        code: 0,
        stdout: `${state.originUrl ?? 'git@github.com:couetilc/couetil.com.git'}\n`,
      };
    }
    if (args[1] === 'refs/remotes/origin/HEAD') {
      return state.originHead === undefined
        ? { code: 128, stderr: 'not found' }
        : { code: 0, stdout: `${state.originHead}\n` };
    }
    // symbolic-ref --short HEAD
    return state.currentBranch === undefined
      ? { code: 128, stderr: 'unborn' }
      : { code: 0, stdout: `${state.currentBranch}\n` };
  };
}

function capturingDeps(
  git: GitState,
  over: Partial<ScaffoldDeps> = {},
): {
  deps: ScaffoldDeps;
  written: Map<string, string>;
  out: () => string;
  err: () => string;
} {
  const written = new Map<string, string>();
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const templatesDir = packageTemplatesDir();
  const handle = gitHandler(git);
  const deps: ScaffoldDeps = {
    cwd: '/proj',
    version: '0.1.0',
    packageTemplatesDir: templatesDir,
    exec: async (command, args) => {
      if (command === 'git') {
        return { code: 0, stdout: '', stderr: '', ...handle(args) };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    fileExists: (p) => written.has(p),
    // Templates read from the real package dir; everything else from the
    // capturing map (so a re-run sees what a previous run "wrote").
    readTextFile: (p) => {
      if (p.startsWith(templatesDir)) {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return undefined;
        }
      }
      return written.get(p);
    },
    writeTextFile: (p, c) => {
      written.set(p, c);
    },
    makeExecutable: () => {},
    mkdirp: () => {},
    out: (t) => outBuf.push(t),
    err: (t) => errBuf.push(t),
    ...over,
  };
  return { deps, written, out: () => outBuf.join(''), err: () => errBuf.join('') };
}

describe('runInit — derivation and rendered content', () => {
  it('derives repo/project/defaultBranch and fills every template', async () => {
    const c = capturingDeps({
      originUrl: 'git@github.com:couetilc/couetil.com.git',
      originHead: 'refs/remotes/origin/main',
    });
    expect(await runInit(c.deps)).toBe(0);

    const config = c.written.get('/proj/.agent/config.js') ?? '';
    expect(config).toContain("project: 'couetil-com'");
    expect(config).toContain("repo: 'couetilc/couetil.com'");
    expect(config).toContain("defaultBranch: 'main'");
    expect(config).toContain('schemaVersion: 1');
    expect(config).not.toContain('{{'); // every token substituted

    // Engine package.json is exactly {"type":"module"}.
    expect(c.written.get('/proj/.agent/package.json')).toBe(
      '{\n  "type": "module"\n}\n',
    );

    // README carries the derived project and the major pin.
    const readme = c.written.get('/proj/.agent/README.md') ?? '';
    expect(readme).toContain('couetil-com');
    expect(readme).toContain('@^0');
    expect(readme).not.toContain('{{');

    // Summary printed to stdout, mentioning the derivation.
    expect(c.out()).toContain('Scaffolded .agent/ for couetil-com');
    expect(c.out()).toContain('direnv allow');
  });

  it('shims carry the sandbox guard, the npx line, and the major pin', async () => {
    const c = capturingDeps({ originHead: 'refs/remotes/origin/main' });
    expect(await runInit(c.deps)).toBe(0);
    for (const [name, sub] of [
      ['agent', ''],
      ['claude', 'claude '],
      ['codex', 'codex '],
    ] as const) {
      const shim = c.written.get(`/proj/.agent/bin/${name}`) ?? '';
      expect(shim).toContain('#!/bin/sh');
      expect(shim).toContain('IS_SANDBOX');
      expect(shim).toContain('exit 0'); // no-ops politely inside the container
      expect(shim).toContain(
        `exec npx -y @couetilc/agentic-coding@^0 ${sub}"$@"`,
      );
      expect(shim).not.toContain('{{');
    }
  });

  it('derives the major pin from THIS CLI version (e.g. 1.x → @^1)', async () => {
    const c = capturingDeps(
      { originHead: 'refs/remotes/origin/main' },
      { version: '1.4.2' },
    );
    expect(await runInit(c.deps)).toBe(0);
    expect(c.written.get('/proj/.agent/bin/claude')).toContain(
      '@couetilc/agentic-coding@^1 claude',
    );
  });

  it('falls back to the current branch when origin/HEAD is unset', async () => {
    const c = capturingDeps({ currentBranch: 'develop' });
    expect(await runInit(c.deps)).toBe(0);
    expect(c.written.get('/proj/.agent/config.js')).toContain(
      "defaultBranch: 'develop'",
    );
  });

  it('falls back to main when neither origin/HEAD nor a current branch exists', async () => {
    const c = capturingDeps({});
    expect(await runInit(c.deps)).toBe(0);
    expect(c.written.get('/proj/.agent/config.js')).toContain(
      "defaultBranch: 'main'",
    );
  });

  it('refuses outside a git repo with an actionable error', async () => {
    const c = capturingDeps({ insideWorkTree: false });
    expect(await runInit(c.deps)).toBe(1);
    expect(c.err()).toContain('not a git repository');
    expect(c.written.size).toBe(0);
  });

  it('refuses (telling the user to add one) when there is no origin remote', async () => {
    const c = capturingDeps({ originUrl: null });
    expect(await runInit(c.deps)).toBe(1);
    expect(c.err()).toContain('no `origin` remote');
    expect(c.err()).toContain('git remote add origin');
  });

  it('treats an origin that returns empty output as no origin (gitOut empty→undefined)', async () => {
    const c = capturingDeps({ originUrl: '' });
    expect(await runInit(c.deps)).toBe(1);
    expect(c.err()).toContain('no `origin` remote');
  });

  it('errors when the origin URL cannot be parsed to owner/name', async () => {
    const c = capturingDeps({ originUrl: 'not-a-github-remote' });
    expect(await runInit(c.deps)).toBe(1);
    expect(c.err()).toContain('could not parse `owner/name`');
  });

  it('errors clearly when a packaged template is missing (broken install)', async () => {
    const c = capturingDeps(
      { originHead: 'refs/remotes/origin/main' },
      { readTextFile: () => undefined }, // no templates readable
    );
    expect(await runInit(c.deps)).toBe(1);
    expect(c.err()).toContain('missing packaged template');
  });
});

// --- Real tmp-dir git fixtures ---------------------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

function setupRepo(
  dir: string,
  origin = 'git@github.com:fixture/scratch.git',
): void {
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['remote', 'add', 'origin', origin]);
}

const dirs: string[] = [];
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-scaffold-'));
  dirs.push(dir);
  setupRepo(dir);
  return dir;
}

function realDeps(
  dir: string,
  out: string[] = [],
): ScaffoldDeps {
  return {
    cwd: dir,
    version: '0.1.0',
    packageTemplatesDir: packageTemplatesDir(),
    exec: realExec,
    fileExists: existsSync,
    readTextFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeTextFile: (p, content) => writeFileSync(p, content),
    makeExecutable: (p) => chmodSync(p, 0o755),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    out: (t) => out.push(t),
    err: () => {},
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const isExecutable = (path: string): boolean =>
  (statSync(path).mode & 0o111) !== 0;

describe('runInit — real git fixture, fresh repo', () => {
  it('writes every .agent file with the expected contents and executable bits', async () => {
    const dir = tmpRepo();
    expect(await runInit(realDeps(dir))).toBe(0);
    const agent = join(dir, '.agent');
    const templates = packageTemplatesDir();
    const vars = {
      PROJECT: 'scratch',
      REPO: 'fixture/scratch',
      DEFAULT_BRANCH: 'main',
      MAJOR: '0',
    };

    // config.js — user-owned, exactly the rendered template, and it loads.
    expect(readFileSync(join(agent, 'config.js'), 'utf8')).toBe(
      render(readFileSync(join(templates, 'config.js.tmpl'), 'utf8'), vars),
    );
    expect(isExecutable(join(agent, 'config.js'))).toBe(false);

    // package.json — engine-owned, exact.
    expect(readFileSync(join(agent, 'package.json'), 'utf8')).toBe(
      '{\n  "type": "module"\n}\n',
    );

    // shims — engine-owned, executable, exactly the rendered templates.
    for (const name of ['agent', 'claude', 'codex']) {
      const shim = join(agent, 'bin', name);
      expect(readFileSync(shim, 'utf8')).toBe(
        render(readFileSync(join(templates, 'bin', name), 'utf8'), vars),
      );
      expect(isExecutable(shim)).toBe(true);
    }

    // init.sh — user-owned, executable, verbatim (no tokens).
    expect(readFileSync(join(agent, 'init.sh'), 'utf8')).toBe(
      readFileSync(join(templates, 'init.sh.tmpl'), 'utf8'),
    );
    expect(isExecutable(join(agent, 'init.sh'))).toBe(true);

    // README + env.example — engine-owned.
    expect(readFileSync(join(agent, 'README.md'), 'utf8')).toContain('@^0');
    expect(readFileSync(join(agent, 'env.example'), 'utf8')).toContain(
      'GH_TOKEN',
    );

    // Does NOT write .agent/Dockerfile (README documents creating it).
    expect(existsSync(join(agent, 'Dockerfile'))).toBe(false);

    // The scaffolded config actually loads and validates.
    const config = await loadConfig({
      cwd: dir,
      fileExists: existsSync,
      importModule: (spec) => import(spec),
    });
    expect(config.project).toBe('scratch');
    expect(config.repo).toBe('fixture/scratch');
    expect(config.defaultBranch).toBe('main');
  });

  it('creates .envrc (with PATH_add) and .gitignore (ignoring .env) from scratch', async () => {
    const dir = tmpRepo();
    expect(await runInit(realDeps(dir))).toBe(0);
    expect(readFileSync(join(dir, '.envrc'), 'utf8')).toBe(
      'PATH_add ./.agent/bin\n',
    );
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.env\n');
  });
});

describe('runInit — real git fixture, re-run idempotency', () => {
  it('regenerates engine files but leaves user-owned config.js and init.sh untouched', async () => {
    const dir = tmpRepo();
    expect(await runInit(realDeps(dir))).toBe(0);

    // Mutate a user-owned file and an engine-owned file.
    const configPath = join(dir, '.agent', 'config.js');
    const shimPath = join(dir, '.agent', 'bin', 'claude');
    writeFileSync(configPath, '// hand-edited by the user\nexport default {};\n');
    writeFileSync(shimPath, 'CLOBBERED\n');

    const out: string[] = [];
    expect(await runInit(realDeps(dir, out))).toBe(0);

    // User-owned config.js preserved verbatim.
    expect(readFileSync(configPath, 'utf8')).toBe(
      '// hand-edited by the user\nexport default {};\n',
    );
    // Engine-owned shim regenerated.
    const shim = readFileSync(shimPath, 'utf8');
    expect(shim).not.toContain('CLOBBERED');
    expect(shim).toContain('@couetilc/agentic-coding@^0 claude');
    expect(isExecutable(shimPath)).toBe(true);

    // The summary reports the user-owned files as skipped and skips the
    // direnv reminder (nothing changed on .envrc).
    expect(out.join('')).toContain('skipped');
    expect(out.join('')).toContain('.agent/config.js');
    expect(out.join('')).toContain('.agent/init.sh');
  });
});

describe('runInit — real git fixture, .envrc / .gitignore matrices', () => {
  it('.envrc present WITHOUT the line → appends it exactly once', async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, '.envrc'), 'export FOO=bar\n');
    expect(await runInit(realDeps(dir))).toBe(0);
    const envrc = readFileSync(join(dir, '.envrc'), 'utf8');
    expect(envrc).toBe('export FOO=bar\nPATH_add ./.agent/bin\n');
    // Idempotent: a second run does not append again.
    expect(await runInit(realDeps(dir))).toBe(0);
    expect(readFileSync(join(dir, '.envrc'), 'utf8')).toBe(envrc);
  });

  it('.envrc present WITH the line (no trailing newline) → untouched', async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, '.envrc'), 'PATH_add ./.agent/bin');
    expect(await runInit(realDeps(dir))).toBe(0);
    expect(readFileSync(join(dir, '.envrc'), 'utf8')).toBe('PATH_add ./.agent/bin');
  });

  it('.gitignore already ignoring .env (or /.env) → untouched', async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n/.env\n');
    expect(await runInit(realDeps(dir))).toBe(0);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n/.env\n',
    );
  });

  it('.gitignore present WITHOUT .env (no trailing newline) → appends it once', async () => {
    const dir = tmpRepo();
    writeFileSync(join(dir, '.gitignore'), 'dist');
    expect(await runInit(realDeps(dir))).toBe(0);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('dist\n.env\n');
  });
});
