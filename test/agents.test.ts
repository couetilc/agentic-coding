import { describe, expect, it } from 'vitest';
import { claudeAgent } from '../src/agents/claude.js';
import { codexAgent } from '../src/agents/codex.js';
import type { AgentAuthDeps, AgentSettings } from '../src/types.js';

const CLAUDE: AgentSettings = { model: 'claude-fable-5', effort: 'xhigh' };
const CODEX: AgentSettings = { model: 'gpt-5.6-sol', effort: 'xhigh' };

function authDeps(over: Partial<AgentAuthDeps> = {}): AgentAuthDeps {
  return {
    merged: {},
    env: {},
    home: '/home/me',
    readTextFile: () => undefined,
    ...over,
  };
}

describe('claude agent', () => {
  it('builds the CMD with config model/effort and passes user args through', () => {
    expect(claudeAgent.buildCommand(CLAUDE, ['-p', 'fix tests'])).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'claude-fable-5',
      '--effort',
      'xhigh',
      '-p',
      'fix tests',
    ]);
  });

  it('builds a bare interactive CMD when no args are given', () => {
    expect(claudeAgent.buildCommand(CLAUDE, [])).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'claude-fable-5',
      '--effort',
      'xhigh',
    ]);
  });

  it('injects CLAUDE_MODEL/CLAUDE_EFFORT for the entrypoint to seed', () => {
    expect(claudeAgent.modelEnv(CLAUDE)).toEqual([
      '-e',
      'CLAUDE_MODEL=claude-fable-5',
      '-e',
      'CLAUDE_EFFORT=xhigh',
    ]);
  });

  it('auth passes when CLAUDE_CODE_OAUTH_TOKEN is present', () => {
    const auth = claudeAgent.resolveAuth(
      authDeps({ merged: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } }),
    );
    expect(auth).toEqual({ ok: true, dockerArgs: [], childEnv: {} });
  });

  it('auth fails naming the key and the host env file when the token is absent', () => {
    const auth = claudeAgent.resolveAuth(authDeps());
    expect(auth.ok).toBe(false);
    expect(auth.error).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(auth.error).toContain('~/.config/agentic-coding/env');
  });
});

describe('codex agent', () => {
  it('maps a leading -p to `codex exec` and quotes the effort as a TOML string', () => {
    expect(codexAgent.buildCommand(CODEX, ['-p', 'do it'])).toEqual([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="xhigh"',
      'do it',
    ]);
  });

  it('runs a plain `codex` (no exec) when there is no leading -p', () => {
    expect(codexAgent.buildCommand(CODEX, ['review'])).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="xhigh"',
      'review',
    ]);
  });

  it('injects CODEX_MODEL/CODEX_EFFORT for the entrypoint config.toml', () => {
    expect(codexAgent.modelEnv(CODEX)).toEqual([
      '-e',
      'CODEX_MODEL=gpt-5.6-sol',
      '-e',
      'CODEX_EFFORT=xhigh',
    ]);
  });

  it('auth.json present → base64 goes in childEnv, only a bare -e on the argv', () => {
    const auth = codexAgent.resolveAuth(
      authDeps({
        readTextFile: (path) =>
          path === '/home/me/.codex/auth.json' ? '{"token":"secret"}' : undefined,
      }),
    );
    expect(auth.ok).toBe(true);
    // The secret is NOT on the argv — only the bare env-var name.
    expect(auth.dockerArgs).toEqual(['-e', 'CODEX_AUTH_B64']);
    expect(auth.dockerArgs.join(' ')).not.toContain('secret');
    // The value rides in the child process env instead.
    expect(auth.childEnv.CODEX_AUTH_B64).toBe(
      Buffer.from('{"token":"secret"}', 'utf8').toString('base64'),
    );
  });

  it('honors CODEX_HOME when locating auth.json', () => {
    const auth = codexAgent.resolveAuth(
      authDeps({
        env: { CODEX_HOME: '/custom/codex' },
        readTextFile: (path) =>
          path === '/custom/codex/auth.json' ? '{}' : undefined,
      }),
    );
    expect(auth.ok).toBe(true);
    expect(auth.dockerArgs).toEqual(['-e', 'CODEX_AUTH_B64']);
  });

  it('falls back to OPENAI_API_KEY (no extra docker args) when auth.json is absent', () => {
    const auth = codexAgent.resolveAuth(
      authDeps({ merged: { OPENAI_API_KEY: 'sk-x' } }),
    );
    expect(auth).toEqual({ ok: true, dockerArgs: [], childEnv: {} });
  });

  it('fails with both remedies when neither credential exists', () => {
    const auth = codexAgent.resolveAuth(authDeps());
    expect(auth.ok).toBe(false);
    expect(auth.error).toContain('codex login');
    expect(auth.error).toContain('OPENAI_API_KEY');
    expect(auth.error).toContain('~/.config/agentic-coding/env');
  });
});
