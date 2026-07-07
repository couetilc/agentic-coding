import { describe, expect, it } from 'vitest';
import {
  GH_TOKEN_REQUIREMENT,
  environmentLines,
  envFileArgs,
  envFileErrors,
  envPresent,
  hostEnvPath,
  launchRequirements,
  loadEnvFiles,
  mergeEnv,
  parseEnvContent,
  preflightErrors,
  projectEnvPath,
  redactedKeys,
} from '../src/env.js';
import type { EnvDeps } from '../src/types.js';

// The parser must mirror `docker --env-file` EXACTLY (the files are handed to
// docker verbatim). Every case here was verified against docker CLI 29.0.0.
describe('parseEnvContent — docker parity', () => {
  it('parses KEY=VALUE and skips blank lines and # comments', () => {
    expect(parseEnvContent('# a comment\n\nGH_TOKEN=abc\nFOO=bar\n')).toEqual({
      vars: { GH_TOKEN: 'abc', FOO: 'bar' },
      invalid: [],
    });
  });

  it('left-trims lines: indented comments and whitespace-only lines skipped, leading key whitespace fine', () => {
    expect(parseEnvContent('   # indented comment\n   \n  D=4\n')).toEqual({
      vars: { D: '4' },
      invalid: [],
    });
  });

  it('flags `export KEY=...` as invalid (docker: "variable contains whitespaces") with a fix hint', () => {
    const parsed = parseEnvContent('export GH_TOKEN=xyz');
    expect(parsed.vars).toEqual({});
    expect(parsed.invalid).toHaveLength(1);
    expect(parsed.invalid[0]).toContain('"export GH_TOKEN"');
    expect(parsed.invalid[0]).toContain('docker --env-file rejects');
    expect(parsed.invalid[0]).toContain("drop the 'export ' prefix");
  });

  it('flags any whitespace inside a name, without the export hint for non-export lines', () => {
    const assign = parseEnvContent('E =5');
    expect(assign.vars).toEqual({});
    expect(assign.invalid[0]).toContain('"E "');
    expect(assign.invalid[0]).not.toContain('export');
    // A bare (no `=`) name with whitespace is rejected by docker too.
    const bare = parseEnvContent('NO PE');
    expect(bare.invalid[0]).toContain('"NO PE"');
  });

  it('flags an empty name (`=value`) as invalid (docker: "no variable name")', () => {
    const parsed = parseEnvContent('=orphan\nGOOD=1');
    expect(parsed.vars).toEqual({ GOOD: '1' });
    expect(parsed.invalid).toEqual(['no variable name on line "=orphan"']);
  });

  it('takes values verbatim: embedded `=`, spaces, and trailing whitespace kept', () => {
    expect(
      parseEnvContent('OPENAI_API_KEY=sk-a=b=c\nF= spaced trailing  '),
    ).toEqual({
      vars: { OPENAI_API_KEY: 'sk-a=b=c', F: ' spaced trailing  ' },
      invalid: [],
    });
  });

  it('skips a bare valid name (docker passes it through from the client env)', () => {
    expect(parseEnvContent('NOKEY\nI=1')).toEqual({
      vars: { I: '1' },
      invalid: [],
    });
  });

  it('strips a leading UTF-8 BOM like docker does', () => {
    expect(parseEnvContent('\uFEFFB=2\n')).toEqual({
      vars: { B: '2' },
      invalid: [],
    });
  });
});

describe('env file paths', () => {
  it('derives the host and project paths', () => {
    expect(hostEnvPath('/home/me')).toBe(
      '/home/me/.config/agentic-coding/env',
    );
    expect(projectEnvPath('/proj')).toBe('/proj/.env');
  });
});

// A fake fs seam mapping path → file contents (absent = missing file).
function fakeDeps(files: Record<string, string>): EnvDeps {
  return {
    cwd: '/proj',
    home: '/home/me',
    readTextFile: (path) => files[path],
  };
}

describe('loadEnvFiles + mergeEnv', () => {
  it('loads both files, marks missing ones, and merges project over host', () => {
    const deps = fakeDeps({
      '/home/me/.config/agentic-coding/env': 'CLAUDE_CODE_OAUTH_TOKEN=host\nSHARED=fromhost',
      '/proj/.env': 'GH_TOKEN=gh\nSHARED=fromproject',
    });
    const files = loadEnvFiles(deps);
    expect(files.map((f) => f.scope)).toEqual(['host', 'project']);
    expect(files.every((f) => f.exists)).toBe(true);
    expect(mergeEnv(files)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'host',
      GH_TOKEN: 'gh',
      SHARED: 'fromproject',
    });
  });

  it('treats a missing file as empty (no vars, exists=false)', () => {
    const deps = fakeDeps({ '/proj/.env': 'GH_TOKEN=gh' });
    const files = loadEnvFiles(deps);
    const host = files.find((f) => f.scope === 'host');
    expect(host?.exists).toBe(false);
    expect(host?.vars).toEqual({});
    expect(mergeEnv(files)).toEqual({ GH_TOKEN: 'gh' });
  });
});

describe('envFileArgs', () => {
  it('emits --env-file only for existing files, host before project', () => {
    const deps = fakeDeps({
      '/home/me/.config/agentic-coding/env': 'X=1',
      '/proj/.env': 'GH_TOKEN=gh',
    });
    expect(envFileArgs(loadEnvFiles(deps))).toEqual([
      '--env-file',
      '/home/me/.config/agentic-coding/env',
      '--env-file',
      '/proj/.env',
    ]);
  });

  it('skips a missing file', () => {
    const deps = fakeDeps({ '/proj/.env': 'GH_TOKEN=gh' });
    expect(envFileArgs(loadEnvFiles(deps))).toEqual(['--env-file', '/proj/.env']);
  });
});

describe('envPresent', () => {
  it('treats a non-empty string as present and an empty/absent one as not', () => {
    expect(envPresent({ K: 'v' }, 'K')).toBe(true);
    expect(envPresent({ K: '' }, 'K')).toBe(false);
    expect(envPresent({}, 'K')).toBe(false);
  });
});

describe('envFileErrors', () => {
  it('prefixes each docker-rejected line with the file label', () => {
    const deps = fakeDeps({
      '/proj/.env': 'export GH_TOKEN=x\nOK=1',
      '/home/me/.config/agentic-coding/env': '=orphan',
    });
    const errors = envFileErrors(loadEnvFiles(deps));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('~/.config/agentic-coding/env: no variable name');
    expect(errors[1]).toContain('./.env: variable "export GH_TOKEN"');
  });

  it('is empty for clean or missing files', () => {
    expect(envFileErrors(loadEnvFiles(fakeDeps({ '/proj/.env': 'A=1' })))).toEqual(
      [],
    );
    expect(envFileErrors(loadEnvFiles(fakeDeps({})))).toEqual([]);
  });
});

describe('preflight', () => {
  it('GH_TOKEN requirement names the project .env file', () => {
    expect(GH_TOKEN_REQUIREMENT).toEqual({ key: 'GH_TOKEN', file: './.env' });
  });

  it('launchRequirements includes GH_TOKEN plus each requiredEnv key', () => {
    expect(launchRequirements(['DEPLOY_TOKEN'])).toEqual([
      { key: 'GH_TOKEN', file: './.env' },
      { key: 'DEPLOY_TOKEN', file: './.env' },
    ]);
  });

  it('reports every missing key with its file and passes when all present', () => {
    const reqs = launchRequirements(['DEPLOY_TOKEN']);
    expect(preflightErrors({}, reqs)).toEqual([
      'GH_TOKEN is not set — add it to ./.env',
      'DEPLOY_TOKEN is not set — add it to ./.env',
    ]);
    expect(
      preflightErrors({ GH_TOKEN: 'g', DEPLOY_TOKEN: 'd' }, reqs),
    ).toEqual([]);
  });
});

describe('doctor helpers', () => {
  it('redactedKeys returns sorted key names only', () => {
    expect(redactedKeys({ B: 'x', A: 'y' })).toEqual(['A', 'B']);
  });

  it('environmentLines lists files, redacted keys, and verdicts (no values)', () => {
    const deps = fakeDeps({
      '/proj/.env': 'GH_TOKEN=secret-value',
    });
    const files = loadEnvFiles(deps);
    const merged = mergeEnv(files);
    const lines = environmentLines(files, merged, launchRequirements([]));
    const text = lines.join('\n');
    expect(text).toContain('host    ~/.config/agentic-coding/env — missing');
    expect(text).toContain('project ./.env — found');
    expect(text).toContain('keys           GH_TOKEN (values redacted)');
    expect(text).toContain('GH_TOKEN       present');
    // The redaction contract: no secret value ever appears.
    expect(text).not.toContain('secret-value');
  });

  it('environmentLines shows (none) for an empty merge and MISSING verdicts', () => {
    const deps = fakeDeps({});
    const files = loadEnvFiles(deps);
    const lines = environmentLines(files, mergeEnv(files), launchRequirements([]));
    const text = lines.join('\n');
    expect(text).toContain('keys           (none) (values redacted)');
    expect(text).toContain('GH_TOKEN       MISSING — add to ./.env');
  });

  it('environmentLines surfaces lines docker would reject as INVALID', () => {
    const deps = fakeDeps({ '/proj/.env': 'export GH_TOKEN=x' });
    const files = loadEnvFiles(deps);
    const text = environmentLines(
      files,
      mergeEnv(files),
      launchRequirements([]),
    ).join('\n');
    expect(text).toContain('INVALID        ./.env: variable "export GH_TOKEN"');
  });
});
