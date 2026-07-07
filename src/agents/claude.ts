import { envPresent } from '../env.js';
import type {
  AgentAuth,
  AgentAuthDeps,
  AgentModule,
  AgentSettings,
} from '../types.js';

// Port of news's bin/claude. Model/effort come from config (not hardcoded);
// `-p` is a native claude flag, so user args pass straight through.

// CLAUDE_CODE_OAUTH_TOKEN belongs in the host env file (§7).
const HOST_ENV_FILE = '~/.config/agentic-coding/env';

function buildCommand(settings: AgentSettings, args: string[]): string[] {
  return [
    'claude',
    '--dangerously-skip-permissions',
    '--model',
    settings.model,
    '--effort',
    settings.effort,
    ...args,
  ];
}

// The entrypoint seeds ~/.claude/settings.json from these rather than baking in
// model/effort literals (PLAN.md §5, §8).
function modelEnv(settings: AgentSettings): string[] {
  return [
    '-e',
    `CLAUDE_MODEL=${settings.model}`,
    '-e',
    `CLAUDE_EFFORT=${settings.effort}`,
  ];
}

function resolveAuth(deps: AgentAuthDeps): AgentAuth {
  if (envPresent(deps.merged, 'CLAUDE_CODE_OAUTH_TOKEN')) {
    return { ok: true, dockerArgs: [], childEnv: {} };
  }
  return {
    ok: false,
    error: `CLAUDE_CODE_OAUTH_TOKEN is not set — add it to ${HOST_ENV_FILE} (claude authenticates with it inside the container)`,
    dockerArgs: [],
    childEnv: {},
  };
}

export const claudeAgent: AgentModule = {
  kind: 'claude',
  buildCommand,
  modelEnv,
  resolveAuth,
};
