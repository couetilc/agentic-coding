import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Docker-gated e2e (PLAN.md §9, §10.3 exit criterion): drive the REAL CLI end to
// end — `node dist/cli.js init` scaffolds a scratch repo, then
// `node dist/cli.js shell -- true` builds the image, launches a container, whose
// entrypoint clones the fixture and execs `true` → exit 0. That single 0 proves
// init's scaffold + config load + launch + entrypoint + clone all compose.
//
// Skipped unless AGENTIC_E2E=1. The `-- true` run is non-TTY (spawnSync pipes,
// so the CLI sees no terminal → `docker run -i` without `-t`); that is exactly
// what the §10.3 deviation (buildRunArgs -t only on a TTY) exists for — a `-it`
// here would fail with "the input device is not a TTY".
//
// The real launcher mounts nothing from the host (isolation contract), so a host
// `file://` path is unreachable inside the container. We serve the fixture over
// `git daemon` (PLAN.md §9's alternative to a file remote) via
// host.docker.internal, so no GitHub / token is needed for the workspace clone.
const RUN = process.env.AGENTIC_E2E === '1';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const dockerContext = fileURLToPath(new URL('../../docker', import.meta.url));
const version = (
  JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
const baseTag = `agentic-coding-base:${version}`;

// Hermetic git for FIXTURE setup: ignore the host's global/system config so
// commit-signing / hooksPath don't interfere.
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): void {
  spawnSync('sh', ['-c', `sleep ${ms / 1000}`]);
}

// Poll the daemon over loopback until it serves the fixture (or give up).
function waitForDaemon(port: number): void {
  for (let i = 0; i < 50; i++) {
    const probe = spawnSync(
      'git',
      ['ls-remote', `git://127.0.0.1:${port}/repo.git`],
      { stdio: 'ignore' },
    );
    if (probe.status === 0) {
      return;
    }
    sleep(200);
  }
  throw new Error('git daemon did not come up');
}

describe.skipIf(!RUN)('e2e: init → shell composes', () => {
  let projectDir: string;
  let fixtureBase: string;
  let daemon: ChildProcess | undefined;
  let port: number;

  beforeAll(async () => {
    // 1. Build the base image the launcher resolves (shares layer cache with the
    //    entrypoint e2e's build).
    execFileSync('docker', ['build', '-t', baseTag, dockerContext], {
      stdio: 'inherit',
    });

    // 2. Fixture repo, served over git:// so the isolated container can clone it
    //    with no GitHub and no token.
    fixtureBase = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-e2e-fix-')));
    const work = join(fixtureBase, 'work');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'README.md'), '# fixture\n');
    git(work, ['init', '-q', '-b', 'main']);
    git(work, ['config', 'user.name', 'Fixture']);
    git(work, ['config', 'user.email', 'fixture@example.com']);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'fixture']);
    git(fixtureBase, ['clone', '-q', '--bare', work, 'repo.git']);

    port = await freePort();
    daemon = spawn(
      'git',
      [
        'daemon',
        '--reuseaddr',
        '--listen=0.0.0.0',
        `--port=${port}`,
        `--base-path=${fixtureBase}`,
        '--export-all',
        fixtureBase,
      ],
      { stdio: 'ignore' },
    );
    waitForDaemon(port);

    // 3. Scratch project repo with a fake github origin; init via the REAL CLI.
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-e2e-proj-')));
    git(projectDir, ['init', '-q', '-b', 'main']);
    git(projectDir, ['config', 'user.name', 'E2E Tester']);
    git(projectDir, ['config', 'user.email', 'e2e@example.com']);
    git(projectDir, [
      'remote',
      'add',
      'origin',
      'git@github.com:fixture/scratch.git',
    ]);
    execFileSync('node', [cli, 'init'], { cwd: projectDir, stdio: 'inherit' });

    // 4. Project .env: the required GH_TOKEN (dummy; the git:// clone ignores it)
    //    and the test-only clone URL the container reaches via host.docker.internal.
    writeFileSync(
      join(projectDir, '.env'),
      `GH_TOKEN=dummy\nAGENTIC_TEST_REPO_URL=git://host.docker.internal:${port}/repo.git\n`,
    );
  });

  afterAll(() => {
    daemon?.kill();
    for (const dir of [projectDir, fixtureBase]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    try {
      execFileSync('docker', ['image', 'rm', '-f', baseTag], {
        stdio: 'ignore',
      });
    } catch {
      // Best-effort; leaving the image behind is harmless.
    }
  });

  it('`shell -- true` exits 0 — scaffold + config + launch + entrypoint + clone all compose', () => {
    // Non-TTY (piped stdio) → the CLI adds -i but not -t. The scratch repo's
    // local git identity is what the launcher injects as GIT_USER_NAME/EMAIL.
    const result = spawnSync('node', [cli, 'shell', '--', 'true'], {
      cwd: projectDir,
      stdio: 'inherit',
    });
    expect(result.status).toBe(0);
  });
});
