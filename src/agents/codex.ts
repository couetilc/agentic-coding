import { join } from 'node:path';
import { envPresent } from '../env.js';
import type {
  AgentAuth,
  AgentAuthDeps,
  AgentModule,
  AgentSettings,
} from '../types.js';

// Port of news's bin/codex. Model/effort from config; reasoning effort is passed
// as a flag (the reliable source of truth — config.toml effort can be ignored on
// a fresh launch, openai/codex#17436). OPENAI_API_KEY belongs in the host env
// file (§7).
const HOST_ENV_FILE = '~/.config/agentic-coding/env';

// The shared flag block; `--config model_reasoning_effort="<effort>"` is a single
// argv element whose value carries literal double quotes (a TOML string).
function flags(settings: AgentSettings): string[] {
  return [
    '--dangerously-bypass-approvals-and-sandbox',
    '--model',
    settings.model,
    '--config',
    `model_reasoning_effort="${settings.effort}"`,
  ];
}

// codex has no `-p` flag: a leading `-p` maps to the `codex exec` non-interactive
// subcommand (news behavior); otherwise a plain `codex` invocation.
function buildCommand(settings: AgentSettings, args: string[]): string[] {
  const f = flags(settings);
  if (args[0] === '-p') {
    return ['codex', 'exec', ...f, ...args.slice(1)];
  }
  return ['codex', ...f, ...args];
}

// The entrypoint's config.toml reads these (PLAN.md §5, §8).
function modelEnv(settings: AgentSettings): string[] {
  return [
    '-e',
    `CODEX_MODEL=${settings.model}`,
    '-e',
    `CODEX_EFFORT=${settings.effort}`,
  ];
}

function authFilePath(deps: AgentAuthDeps): string {
  const codexHome = deps.env.CODEX_HOME ?? join(deps.home, '.codex');
  return join(codexHome, 'auth.json');
}

function resolveAuth(deps: AgentAuthDeps): AgentAuth {
  const auth = deps.readTextFile(authFilePath(deps));
  if (auth !== undefined) {
    // Base64-encode the host's `codex login` credential (multi-line JSON that
    // --env-file can't carry) and pass a bare `-e CODEX_AUTH_B64` — the value
    // rides in the docker CLIENT process env, off the argv (never in `ps`),
    // exactly as news does. Buffer, no shelling out.
    const b64 = Buffer.from(auth, 'utf8').toString('base64');
    return {
      ok: true,
      dockerArgs: ['-e', 'CODEX_AUTH_B64'],
      childEnv: { CODEX_AUTH_B64: b64 },
    };
  }
  if (envPresent(deps.merged, 'OPENAI_API_KEY')) {
    // Already delivered via --env-file; nothing extra to inject.
    return { ok: true, dockerArgs: [], childEnv: {} };
  }
  return {
    ok: false,
    error: `no Codex credential found — run \`codex login\` on the host (uses your ChatGPT subscription), or set OPENAI_API_KEY in ${HOST_ENV_FILE} for pay-as-you-go API billing`,
    dockerArgs: [],
    childEnv: {},
  };
}

export const codexAgent: AgentModule = {
  kind: 'codex',
  buildCommand,
  modelEnv,
  resolveAuth,
};
