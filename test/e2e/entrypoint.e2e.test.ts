import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheMountPath } from '../../src/config.js';
import { chownCacheArgs } from '../../src/launch.js';

// Docker-gated e2e (PLAN.md §9): build the real base image and drive containers
// to assert the entrypoint's shell behavior (clone, hooksPath, agent seeding,
// init.sh). Skipped unless AGENTIC_E2E=1. Containers are run headlessly (no
// `-it`) so their output can be captured — the launcher's `-it` is proven by the
// argv golden test instead. The clone uses AGENTIC_TEST_REPO_URL (test-only) against
// a local bare-repo fixture, so no GitHub / network access is needed for the
// workspace itself (only the one-time image build downloads toolchains).
const RUN = process.env.AGENTIC_E2E === '1';
const IMAGE = 'agentic-coding-base:e2e';
const dockerContext = fileURLToPath(new URL('../../docker', import.meta.url));

let workdir: string;
let bareRepo: string;

// Hermetic git: ignore the host's global/system config, whose commit-signing
// (e.g. 1Password ssh signing) or hooksPath would otherwise break or slow the
// fixture commits on a developer machine.
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

describe.skipIf(!RUN)('e2e: base image + entrypoint', () => {
  beforeAll(() => {
    // 1. Build the base image from the package's docker/ context.
    execFileSync('docker', ['build', '-t', IMAGE, dockerContext], {
      stdio: 'inherit',
    });

    // 2. Fixture: a working tree with an executable .agent/init.sh, pushed into
    //    a bare repo the container clones over file://.
    workdir = realpathSync(mkdtempSync(join(tmpdir(), 'agentic-e2e-')));
    const src = join(workdir, 'src');
    mkdirSync(join(src, '.agent'), { recursive: true });
    writeFileSync(join(src, 'README.md'), '# fixture\n');
    const initSh = join(src, '.agent', 'init.sh');
    writeFileSync(initSh, '#!/bin/sh\ntouch /workspace/INIT_MARKER\n');
    chmodSync(initSh, 0o755);
    git(src, ['init', '-q', '-b', 'main']);
    git(src, ['config', 'user.name', 'Fixture']);
    git(src, ['config', 'user.email', 'fixture@example.com']);
    git(src, ['add', '-A']);
    git(src, ['commit', '-q', '-m', 'fixture']);
    bareRepo = join(workdir, 'repo.git');
    git(workdir, ['clone', '-q', '--bare', src, bareRepo]);
    // World-readable so the container's non-root `node` user can clone it.
    execFileSync('chmod', ['-R', 'a+rX', workdir]);
  });

  afterAll(() => {
    if (workdir) {
      rmSync(workdir, { recursive: true, force: true });
    }
    try {
      execFileSync('docker', ['image', 'rm', '-f', IMAGE], { stdio: 'ignore' });
    } catch {
      // Best-effort cleanup; leaving the image behind is harmless.
    }
  });

  // Run a throwaway container mirroring a launcher-produced env, capturing
  // stdout. safe.directory='*' (via GIT_CONFIG_* env) waives git's
  // dubious-ownership check on the bind-mounted fixture, which the host and the
  // container's `node` user own under different uids.
  function runContainer(env: Record<string, string>, cmd: string[]): string {
    const args = ['run', '--rm', '-v', `${bareRepo}:${bareRepo}:ro`];
    const full: Record<string, string> = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      ...env,
    };
    for (const [k, v] of Object.entries(full)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(IMAGE, ...cmd);
    return execFileSync('docker', args, { encoding: 'utf8' });
  }

  // Like runContainer, but returns stdout AND stderr separately — the timing
  // marks (issue #8) go to stderr by contract, and the test must prove stdout
  // stays clean for scripted `agent claude -p` runs.
  function runContainerCapture(
    env: Record<string, string>,
    cmd: string[],
  ): { stdout: string; stderr: string } {
    const args = ['run', '--rm', '-v', `${bareRepo}:${bareRepo}:ro`];
    const full: Record<string, string> = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
      ...env,
    };
    for (const [k, v] of Object.entries(full)) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(IMAGE, ...cmd);
    const res = spawnSync('docker', args, { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`docker run exited ${res.status}: ${res.stderr}`);
    }
    return { stdout: res.stdout, stderr: res.stderr };
  }

  function baseEnv(): Record<string, string> {
    return {
      GIT_USER_NAME: 'E2E Tester',
      GIT_USER_EMAIL: 'e2e@example.com',
      DEFAULT_BRANCH: 'main',
      AGENTIC_TEST_REPO_URL: `file://${bareRepo}`,
    };
  }

  it('claude-kind: clones, sets hooksPath, runs init.sh, writes instructions + settings', () => {
    const out = runContainer(
      {
        ...baseEnv(),
        AGENT_KIND: 'claude',
        CLAUDE_MODEL: 'e2e-model',
        CLAUDE_EFFORT: 'e2e-effort',
      },
      [
        'bash',
        '-lc',
        [
          'echo HOOKS=$(git config --global core.hooksPath)',
          'test -d /workspace/.git && echo CLONE_OK',
          'test -f /workspace/INIT_MARKER && echo INIT_OK',
          'test -f "$HOME/.claude/CLAUDE.md" && echo INSTR_OK',
          'echo MODEL=$(jq -r .model "$HOME/.claude/settings.json")',
          'echo EFFORT=$(jq -r .effort "$HOME/.claude/settings.json")',
          'echo SKIP=$(jq -r .skipDangerousModePermissionPrompt "$HOME/.claude/settings.json")',
          // Kept-container restart semantics: re-running the entrypoint with a
          // DIFFERENT model must NOT stomp the existing settings (`//=` is
          // sticky; the launched CMD's --model flag carries config's choice).
          'CLAUDE_MODEL=other-model agent-entrypoint true >/dev/null 2>&1',
          'echo MODEL2=$(jq -r .model "$HOME/.claude/settings.json")',
          'echo E2E_DONE',
        ].join('; '),
      ],
    );
    expect(out).toContain('HOOKS=/opt/agent/hooks');
    expect(out).toContain('CLONE_OK');
    expect(out).toContain('INIT_OK');
    expect(out).toContain('INSTR_OK');
    expect(out).toContain('MODEL=e2e-model');
    expect(out).toContain('EFFORT=e2e-effort');
    expect(out).toContain('SKIP=true');
    expect(out).toContain('MODEL2=e2e-model');
    expect(out).toContain('E2E_DONE');
  });

  it('AGENT_TIMING=1: per-stage marks on stderr (stdout clean); silent without it', () => {
    const timed = runContainerCapture(
      {
        ...baseEnv(),
        AGENT_KIND: 'shell',
        AGENT_TIMING: '1',
        // The host and its containers share a kernel clock, so the entrypoint
        // can report the docker create+start gap from this pre-run stamp.
        AGENT_LAUNCH_T0: String(Date.now()),
      },
      ['true'],
    );
    for (const stage of [
      'docker create+start',
      'git identity + transport',
      'workspace clone',
      'agent CLI setup',
      'surface instructions',
      'project init.sh',
      'entrypoint total',
    ]) {
      expect(timed.stderr).toContain(`[agent-timing] ${stage}`);
    }
    expect(timed.stdout).not.toContain('[agent-timing]');

    const untimed = runContainerCapture(
      { ...baseEnv(), AGENT_KIND: 'shell' },
      ['true'],
    );
    expect(untimed.stderr).not.toContain('[agent-timing]');
  });

  it('codex-kind: writes config.toml from env, decodes CODEX_AUTH_B64, writes AGENTS.md', () => {
    const authJson = '{"tokens":{"access":"e2e-secret"}}';
    const b64 = Buffer.from(authJson, 'utf8').toString('base64');
    const out = runContainer(
      {
        ...baseEnv(),
        AGENT_KIND: 'codex',
        CODEX_MODEL: 'e2e-codex',
        CODEX_EFFORT: 'e2e-hi',
        CODEX_AUTH_B64: b64,
      },
      [
        'bash',
        '-lc',
        [
          'cat "$HOME/.codex/config.toml"',
          'echo AUTH=$(cat "$HOME/.codex/auth.json")',
          'test -f "$HOME/.codex/AGENTS.md" && echo AGENTS_OK',
          'echo E2E_DONE',
        ].join('; '),
      ],
    );
    expect(out).toContain('model = "e2e-codex"');
    expect(out).toContain('model_reasoning_effort = "e2e-hi"');
    expect(out).toContain('trust_level = "trusted"');
    expect(out).toContain(`AUTH=${authJson}`);
    expect(out).toContain('AGENTS_OK');
    expect(out).toContain('E2E_DONE');
  });

  it('refuses to start without a git identity', () => {
    expect(() =>
      runContainer(
        {
          AGENT_KIND: 'shell',
          DEFAULT_BRANCH: 'main',
          AGENTIC_TEST_REPO_URL: `file://${bareRepo}`,
        },
        ['true'],
      ),
    ).toThrow();
  });

  it('a FRESH named volume at a non-baked cache path is node-writable after the chown pre-step', () => {
    // The regression this guards: docker creates a missing mountpoint as root,
    // so a fresh named volume at e.g. ~/.cache/pip came up root-owned and the
    // non-root node user was locked out of its own cache forever. The launcher
    // now runs the chownCacheArgs pre-step first; replicate that exact flow
    // against a brand-new volume, at a path the image does NOT pre-create.
    const volume = `agentic-e2e-cache-${Date.now()}`;
    const path = cacheMountPath('pip'); // /home/node/.cache/pip — no baked dir
    try {
      // The pre-step, exactly as runLaunch issues it.
      execFileSync('docker', chownCacheArgs([{ volume, path }], IMAGE), {
        stdio: 'ignore',
      });
      // Then a normal (non-root) container mounts the same volume and writes.
      const out = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${volume}:${path}`,
          '--entrypoint',
          'bash',
          IMAGE,
          '-c',
          `echo OWNER=$(stat -c %U ${path}); touch ${path}/probe && echo WRITE_OK`,
        ],
        { encoding: 'utf8' },
      );
      expect(out).toContain('OWNER=node');
      expect(out).toContain('WRITE_OK');
    } finally {
      execFileSync('docker', ['volume', 'rm', '-f', volume], {
        stdio: 'ignore',
      });
    }
  });
});
