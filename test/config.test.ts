import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  SUPPORTED_SCHEMA_VERSION,
  cacheMountPath,
  cacheMounts,
  cacheVolumeName,
  cacheVolumeNames,
  configPath,
  containerName,
  errorMessage,
  imageName,
  labels,
  loadConfig,
  randomNameSuffix,
} from '../src/config.js';
import type { AgentConfig, ConfigDeps } from '../src/types.js';

const VALID = {
  schemaVersion: 1,
  project: 'couetil-com',
  repo: 'couetilc/couetil.com',
  defaultBranch: 'main',
  ports: { astro: 4321 },
  agents: {
    claude: { model: 'claude-fable-5', effort: 'xhigh' },
    codex: { model: 'gpt-5.6-sol', effort: 'xhigh' },
  },
  requiredEnv: [],
  caches: ['uv'],
};

function deps(raw: unknown, over: Partial<ConfigDeps> = {}): ConfigDeps {
  return {
    cwd: '/proj',
    fileExists: () => true,
    importModule: async () => ({ default: raw }),
    ...over,
  };
}

/** Load a config built from VALID with the given field overridden. */
function loadWith(patch: Record<string, unknown>): Promise<AgentConfig> {
  return loadConfig(deps({ ...VALID, ...patch }));
}

async function expectError(
  promise: Promise<unknown>,
  match: RegExp,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ConfigError);
  await expect(promise).rejects.toThrow(match);
}

describe('loadConfig — load boundary', () => {
  it('accepts a valid config and normalizes it (retentionDays defaults to 30)', async () => {
    await expect(loadConfig(deps(VALID))).resolves.toEqual({
      ...VALID,
      retentionDays: 30,
    });
  });

  it('errors when .agent/config.js is absent', async () => {
    await expectError(
      loadConfig(deps(VALID, { fileExists: () => false })),
      /no \.agent\/config\.js found in \/proj — run `agent init`/,
    );
  });

  it('wraps an Error thrown while importing the module', async () => {
    await expectError(
      loadConfig(
        deps(VALID, {
          importModule: async () => {
            throw new Error('boom');
          },
        }),
      ),
      /failed to load \.agent\/config\.js: boom/,
    );
  });

  it('wraps a non-Error thrown while importing the module', async () => {
    await expectError(
      loadConfig(
        deps(VALID, {
          importModule: async () => {
            throw 'stringly';
          },
        }),
      ),
      /failed to load \.agent\/config\.js: stringly/,
    );
  });

  it('errors when there is no default export', async () => {
    await expectError(
      loadConfig(deps(VALID, { importModule: async () => ({}) })),
      /must `export default`/,
    );
  });

  it('errors when the default export is not an object', async () => {
    await expectError(loadConfig(deps(42)), /default export must be an object/);
    await expectError(loadConfig(deps(null)), /default export must be an object/);
    await expectError(loadConfig(deps([1])), /default export must be an object/);
  });
});

describe('loadConfig — schemaVersion gate', () => {
  it('rejects a non-integer schemaVersion', async () => {
    await expectError(loadWith({ schemaVersion: '1' }), /must be an integer/);
    await expectError(loadWith({ schemaVersion: 1.5 }), /must be an integer/);
  });

  it('rejects a schemaVersion below 1', async () => {
    await expectError(loadWith({ schemaVersion: 0 }), /must be >= 1/);
  });

  it('refuses a schemaVersion newer than supported and says to upgrade', async () => {
    await expectError(
      loadWith({ schemaVersion: SUPPORTED_SCHEMA_VERSION + 1 }),
      /newer than this CLI supports .* upgrade the CLI/,
    );
  });
});

describe('loadConfig — field validation', () => {
  it('rejects a missing/invalid project slug', async () => {
    await expectError(loadWith({ project: '' }), /project must be a non-empty/);
    await expectError(loadWith({ project: 123 }), /project must be a non-empty/);
    await expectError(
      loadWith({ project: 'Not A Slug' }),
      /project "Not A Slug" is not a valid slug/,
    );
  });

  it('rejects a repo that is not owner/name', async () => {
    await expectError(loadWith({ repo: 123 }), /repo must be a non-empty/);
    await expectError(loadWith({ repo: 'noslash' }), /must be `owner\/name`/);
  });

  it('rejects a missing defaultBranch', async () => {
    await expectError(
      loadWith({ defaultBranch: undefined }),
      /defaultBranch must be a non-empty/,
    );
  });

  it('defaults ports to {} and validates entries', async () => {
    await expect(loadWith({ ports: undefined })).resolves.toMatchObject({
      ports: {},
    });
    await expectError(loadWith({ ports: [] }), /ports must be an object/);
    await expectError(
      loadWith({ ports: { 'Bad Key': 4321 } }),
      /ports key "Bad Key" must be a slug/,
    );
    await expectError(
      loadWith({ ports: { astro: '4321' } }),
      /ports\.astro must be an integer/,
    );
    await expectError(
      loadWith({ ports: { astro: 1.5 } }),
      /ports\.astro must be an integer/,
    );
    await expectError(
      loadWith({ ports: { astro: 0 } }),
      /ports\.astro must be an integer/,
    );
    await expectError(
      loadWith({ ports: { astro: 99999 } }),
      /ports\.astro must be an integer/,
    );
  });

  it('validates the agents block', async () => {
    await expectError(loadWith({ agents: null }), /agents must be an object/);
    await expectError(
      loadWith({ agents: { codex: VALID.agents.codex } }),
      /agents\.claude must be an object/,
    );
    await expectError(
      loadWith({
        agents: {
          claude: { effort: 'xhigh' },
          codex: VALID.agents.codex,
        },
      }),
      /agents\.claude\.model must be a non-empty/,
    );
    await expectError(
      loadWith({
        agents: {
          claude: { model: 'm', effort: '' },
          codex: VALID.agents.codex,
        },
      }),
      /agents\.claude\.effort must be a non-empty/,
    );
  });

  it('defaults requiredEnv to [] and validates entries', async () => {
    await expect(loadWith({ requiredEnv: undefined })).resolves.toMatchObject({
      requiredEnv: [],
    });
    await expectError(
      loadWith({ requiredEnv: 'FOO' }),
      /requiredEnv must be an array/,
    );
    await expectError(
      loadWith({ requiredEnv: [''] }),
      /requiredEnv\[0\] must be a non-empty/,
    );
    await expect(loadWith({ requiredEnv: ['FOO'] })).resolves.toMatchObject({
      requiredEnv: ['FOO'],
    });
  });

  it('defaults caches to [] and validates slugs', async () => {
    await expect(loadWith({ caches: undefined })).resolves.toMatchObject({
      caches: [],
    });
    await expectError(loadWith({ caches: 'uv' }), /caches must be an array/);
    await expectError(loadWith({ caches: [7] }), /caches\[0\] must be a non-empty/);
    await expectError(
      loadWith({ caches: ['Not Slug'] }),
      /caches\[0\] "Not Slug" is not a valid slug/,
    );
  });

  it('accepts explicit retentionDays, including 0 (disabled)', async () => {
    await expect(loadWith({ retentionDays: 45 })).resolves.toMatchObject({
      retentionDays: 45,
    });
    await expect(loadWith({ retentionDays: 0 })).resolves.toMatchObject({
      retentionDays: 0,
    });
  });

  it('rejects non-integer, negative, and non-number retentionDays', async () => {
    await expectError(
      loadWith({ retentionDays: 1.5 }),
      /retentionDays must be a non-negative integer/,
    );
    await expectError(
      loadWith({ retentionDays: -1 }),
      /retentionDays must be a non-negative integer/,
    );
    await expectError(
      loadWith({ retentionDays: '30' }),
      /retentionDays must be a non-negative integer.*got "30"/,
    );
  });
});

describe('errorMessage', () => {
  it('reads .message from an Error and stringifies anything else', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('y')).toBe('y');
  });
});

describe('derivations', () => {
  it('configPath joins the .agent/config.js path', () => {
    expect(configPath('/proj')).toBe('/proj/.agent/config.js');
  });

  it('imageName', () => {
    expect(imageName('couetil-com')).toBe('agentic-couetil-com');
  });

  it('containerName uses a reverse-sortable MMDD-HHMMSS stamp plus a suffix', () => {
    const now = new Date(2026, 0, 5, 3, 7, 9); // Jan 5, 03:07:09 local
    expect(containerName('couetil-com', 'claude', now, 'ab12')).toBe(
      'agentic-couetil-com-claude-0105-030709-ab12',
    );
  });

  it('randomNameSuffix emits 4 hex chars (name-safe, seconds-tiebreaking)', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomNameSuffix()).toMatch(/^[0-9a-f]{4}$/);
    }
  });

  it('labels carry the project and package version', () => {
    expect(labels('couetil-com', '1.2.3')).toEqual([
      'agentic-coding.project=couetil-com',
      'agentic-coding.version=1.2.3',
    ]);
  });

  it('cacheVolumeName shares the npm cache and scopes the rest', () => {
    expect(cacheVolumeName('couetil-com', 'npm')).toBe('agentic-npm-cache');
    expect(cacheVolumeName('couetil-com', 'uv')).toBe('agentic-couetil-com-uv');
  });

  it('cacheVolumeNames always includes the shared npm cache first', () => {
    const config = { ...VALID, caches: ['uv'] } as AgentConfig;
    expect(cacheVolumeNames(config)).toEqual([
      'agentic-npm-cache',
      'agentic-couetil-com-uv',
    ]);
  });

  it('cacheMountPath maps known caches and falls back to ~/.cache/<name>', () => {
    expect(cacheMountPath('npm')).toBe('/home/node/.npm');
    expect(cacheMountPath('uv')).toBe('/home/node/.cache/uv');
    expect(cacheMountPath('pip')).toBe('/home/node/.cache/pip');
  });

  it('cacheMounts pairs each volume with its container path, npm first, claude install last', () => {
    const config = { ...VALID, caches: ['uv', 'pip'] } as AgentConfig;
    expect(cacheMounts(config)).toEqual([
      { volume: 'agentic-npm-cache', path: '/home/node/.npm' },
      { volume: 'agentic-couetil-com-uv', path: '/home/node/.cache/uv' },
      { volume: 'agentic-couetil-com-pip', path: '/home/node/.cache/pip' },
      // The shared claude install rides along for every config (issue #8 P1a).
      { volume: 'agentic-claude-install', path: '/home/node/.local/share/claude' },
    ]);
  });
});
