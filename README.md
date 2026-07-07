# @couetilc/agentic-coding

Run Claude Code / Codex in a disposable, non-root Docker container, one per
project. The container clones the repo fresh from GitHub at launch and mounts
nothing from your machine; work leaves it only via `git push` (commits are
gitleaks-gated then auto-pushed). Containers run as non-root and are kept after
exit, so unpushed work is salvageable with `docker cp`. Tokens are injected as
environment variables, never baked into images. Parallel containers share
nothing but package caches. A project opts in by committing a small `.agent/`
directory; the engine itself ships as a versioned npm package and never lives in
the repo.

## Install

```sh
npx @couetilc/agentic-coding init
```

Run it from a project repo root. It derives everything from git (no prompting)
and scaffolds a committed `.agent/` directory. Re-running is idempotent —
engine-owned files are regenerated, your `config.js` and `init.sh` are left
untouched.

## Commands

```
agent claude [args...]   launch Claude Code in the project's agent container
                         (args pass through: agent claude -p "fix tests")
agent codex  [args...]   same for Codex (-p maps to `codex exec`)
agent shell  [cmd...]    a shell in the container instead of an agent
                         (runs the given command directly, or interactive bash)
agent clean              remove THIS project's exited containers + rebuild images
agent init               scaffold/upgrade .agent/ in the current repo (idempotent)
agent doctor             print resolved config, image status, env preflight
```

Every command refuses to run inside an agent container (`IS_SANDBOX=1`) — no
docker-in-docker. `agent clean` is label-scoped, so cleaning one project never
touches another's kept containers.

The `.agent/bin/` shims (`agent`, `claude`, `codex`) are added to your PATH via
`.envrc`; with `direnv allow`, `claude` and `codex` in the project launch the
*container*. Escape hatch: `command claude` runs the host CLI.

## Config (`.agent/config.js`)

Pure data (ESM `export default`), validated with actionable errors. `agent init`
fills in the derived `project`/`repo`/`defaultBranch`:

```js
export default {
  schemaVersion: 1,

  project: 'couetil-com',           // names image, containers, volumes, labels
  repo: 'couetilc/couetil.com',     // clone target (HTTPS + GH_TOKEN)
  defaultBranch: 'main',            // auto-push hook skips this branch

  // Named container ports → a fresh random host port per launch, injected as
  // $DEV_HOST_<NAME> (e.g. $DEV_HOST_ASTRO). Bind the dev server to 0.0.0.0.
  ports: { astro: 4321 },

  agents: {
    claude: { model: 'claude-fable-5', effort: 'xhigh' },
    codex:  { model: 'gpt-5.5',        effort: 'xhigh' },
  },

  requiredEnv: [],                  // .env keys the preflight requires beyond GH_TOKEN
  caches: ['uv'],                   // extra named cache volumes (npm is always mounted)
}
```

Per-project dependencies split two ways: **root/system deps** (`apt`,
`/usr/local` binaries, browser libs) go in an optional `.agent/Dockerfile`
overlay, built `FROM` the base image before the container starts; **user-space,
repo-dependent bootstrap** (`npm ci`, `uv sync`) goes in `.agent/init.sh`, which
runs as the non-root user after the clone. The scaffolded `.agent/README.md`
documents both.

## Host prerequisites

- **node** >= 20.19
- **docker** (running)
- **git** (with a `user.name` / `user.email` identity — the container refuses
  to commit as nobody)
- **direnv** — optional; the shims are directly invocable without it.

## Env & secrets

Two env files, merged at launch (project overrides host); each passed to docker
via `--env-file` only if it exists. Values are never printed; `agent doctor`
shows a redacted view.

| File | Scope | Contents |
| --- | --- | --- |
| `~/.config/agentic-coding/env` | host (all projects) | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), optional `OPENAI_API_KEY` |
| `./.env` (project root, gitignored) | project | `GH_TOKEN` (fine-grained PAT for this repo), deploy tokens, anything in `requiredEnv` |

Codex subscription auth stays file-based: `~/.codex/auth.json` is base64-encoded
into an exported var and passed off the argv, so a secret never shows in `ps`.

## Updating

The shims pin the major: `npx -y @couetilc/agentic-coding@^<major>`. Patch and
minor releases arrive automatically the next time you run a command. A major bump
is deliberate — re-run `agent init` to rewrite the shims to the new major.

## Development

```sh
npm test                     # unit + integration (vitest)
npm run coverage             # 100% lines/branches/functions/statements on src/**
AGENTIC_E2E=1 npm run test:e2e   # docker-gated: builds the base image, drives real containers
```

Coverage is a hard gate: no `v8-ignore` / `istanbul ignore` comments anywhere in
`src/`; every OS boundary (child_process, net, fs, clock) sits behind an
injectable seam so real logic is fully exercised. The e2e suite is excluded from
the coverage gate (it exercises shell assets, not TS) and skipped unless
`AGENTIC_E2E=1`.

## License

MIT
