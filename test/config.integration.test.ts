import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

// Exercise the real fs + dynamic-import path against an on-disk fixture, the way
// `agent doctor` loads a project's `.agent/config.js`.
const dir = mkdtempSync(join(tmpdir(), 'agentic-cfg-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('loads a real ESM .agent/config.js from disk', async () => {
  // A real project root: type:module so the .js is treated as ESM.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(dir, '.agent'), { recursive: true });
  writeFileSync(
    join(dir, '.agent', 'config.js'),
    `export default {
  schemaVersion: 1,
  project: 'fixture-proj',
  repo: 'owner/fixture-proj',
  defaultBranch: 'main',
  ports: { web: 3000 },
  agents: {
    claude: { model: 'claude-fable-5', effort: 'xhigh' },
    codex: { model: 'gpt-5.5', effort: 'xhigh' },
  },
  requiredEnv: [],
  caches: ['uv'],
};
`,
  );

  const config = await loadConfig({
    cwd: dir,
    fileExists: existsSync,
    importModule: (spec) => import(spec),
  });

  expect(config.project).toBe('fixture-proj');
  expect(config.ports).toEqual({ web: 3000 });
  expect(config.caches).toEqual(['uv']);
});
