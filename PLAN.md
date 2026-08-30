# @couetilc/agentic-coding — implementation plan

Extract the isolated-agent-container tooling from `couetilc/news` (`bin/claude`,
`bin/codex`, `bin/_agent-common.sh`, `docker/`, `.git-hooks/`) into a reusable,
npm-distributed framework. A project opts in by running the scaffolder, which
creates a committed `.agent/` directory holding that project's configuration;
the engine itself ships as a versioned npm package and never lives in the
project repo.

First adopter: `couetilc/couetil.com`. Second: migrate `couetilc/news` onto it
and delete the originals.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Distribution | npm package `@couetilc/agentic-coding` (public, scoped) |
| Implementation | TypeScript (strict, ESM/NodeNext, compiled with tsc to `dist/`), ported from the news bash scripts |
| Testing | vitest + `@vitest/coverage-v8`; **100% coverage enforced** (lines, branches, functions, statements) on `src/**` |
| Primary command | `agent <claude\|codex\|shell\|clean\|init> [args...]` |
| Convenience shims | `.agent/bin/claude`, `.agent/bin/codex` → `npx @couetilc/agentic-coding <agent>` |
| Per-project config | `.agent/config.js`, ESM `export default {...}`, pure data |
| Per-project deps | `.agent/Dockerfile` overlay (root/system deps) + `.agent/init.sh` (user-space bootstrap) |
| Update mechanism | npm semver; shims pin the major (`@^1`); config carries `schemaVersion` |
| Dropped from v1 | `--resume` (footgun-laden), `sync_main` (obsolete under npm distribution) |
| Kept from news | full isolation contract, kept containers, gitleaks + auto-push hooks, port mapping, codex auth injection, claude/codex first-run seeding |

## Isolation contract (unchanged from news)

Nothing from the host is mounted. The container clones the repo fresh from
GitHub at launch (`GH_TOKEN` over HTTPS; no SSH keys inside). Work leaves the
container only via git: commits are gitleaks-gated (pre-commit) and auto-pushed
(post-commit). Containers run as non-root (`--dangerously-skip-permissions`
refuses root) and are kept after exit (no `--rm`) so unpushed work is
salvageable via `docker cp`. Parallel containers share nothing but package
caches. Tokens are injected as environment variables, never baked into images.

## 1. Package & distribution

```
agentic-coding/               (this repo → github.com/couetilc/agentic-coding)
├── package.json              name @couetilc/agentic-coding, type: module
├── tsconfig.json             strict, NodeNext, src/ → dist/ (declarations on)
├── vitest.config.ts          coverage provider v8; 100% thresholds on src/**
├── src/
│   ├── cli.ts                bin entry (shebang); arg parsing, subcommand dispatch
│   ├── types.ts              config schema + injectable-dependency interfaces
│   ├── config.ts             load/validate .agent/config.js (schemaVersion gate)
│   ├── launch.ts             docker run orchestration (port of agent_launch)
│   ├── docker.ts             image build (base + overlay), container naming/labels
│   ├── ports.ts              free-port picking (port of pick_port/port_free)
│   ├── env.ts                host env + project .env merge, preflights
│   ├── exec.ts               thin injectable child_process wrapper (testability seam)
│   ├── agents/
│   │   ├── claude.ts         CMD construction + auth preflight (CLAUDE_CODE_OAUTH_TOKEN)
│   │   └── codex.ts          CMD construction + auth.json b64 injection + fallback key
│   └── scaffold.ts           `agent init` — writes .agent/, .envrc, .gitignore checks
├── docker/
│   ├── Dockerfile            the base image (see §5)
│   ├── entrypoint.sh         generalized from news (see §5)
│   ├── hooks/
│   │   ├── pre-commit        gitleaks gate (verbatim from news)
│   │   └── post-commit       auto-push, branch name parameterized
│   └── instructions.md       generic in-container CLAUDE.md/AGENTS.md (see §6)
├── templates/                files `agent init` writes into a project
│   ├── config.js.tmpl
│   ├── README.md             the .agent/README.md (host-side config docs)
│   ├── init.sh.tmpl
│   ├── Dockerfile.tmpl       commented-out overlay example
│   ├── env.example.tmpl
│   └── bin/                  agent, claude, codex shims
└── test/                     unit + integration + docker-gated e2e
```

**package.json specifics**

- `"bin": { "agentic-coding": "dist/cli.js", "agent": "dist/cli.js" }`.
  The `agentic-coding` bin is required for `npx @couetilc/agentic-coding ...` to
  resolve (npx picks the bin matching the unscoped package name); `agent` is the
  short command for PATH use.
- `"engines": { "node": ">=20" }`. Host prerequisites: node, docker, git.
  direnv optional (shims are directly invocable without it).
- `"files"`: dist, docker, templates. No runtime dependencies is the goal;
  dev-only deps (typescript, vitest, @vitest/coverage-v8) for build/testing.
- Publish with `--access public`. GitHub Actions: test on PR; publish on tag.

**Update story.** Shims invoke `npx -y @couetilc/agentic-coding@^1 ...`, so
patch/minor updates arrive automatically via npx resolution; a major bump is an
explicit shim edit (re-run `agent init`). `config.js` carries `schemaVersion`;
the CLI refuses configs newer than it understands and migrates older ones
in-place (with a diff shown) on `agent init` re-run.

**Supersedes `curl | bash`**: install is `npx @couetilc/agentic-coding init`.
Optionally keep a one-line `install.sh` in this repo that checks for node and
execs that npx command, for README copy-paste ergonomics.

## 2. CLI surface (v1)

```
agent claude [args...]     launch Claude Code in the project's agent container
                           (args pass through: `agent claude -p "fix tests"`)
agent codex [args...]      same for Codex (`-p` maps to `codex exec`, as in news)
agent shell [cmd...]       bash in the container instead of an agent
                           (skips agent-credential preflight; still needs GH_TOKEN)
agent clean                rm exited containers for THIS project (label-scoped)
                           + rebuild images --pull --no-cache
agent init                 scaffold/upgrade .agent/ in the current repo (idempotent)
agent doctor               print resolved config, image status, env preflight results
```

- All commands refuse to run inside a container (`IS_SANDBOX=1` guard) — no
  docker-in-docker.
- `agent clean` fixes the latent news bug: the prune filter must be
  `label=agentic-coding.project=<name>`, not a shared label, so cleaning one
  project never destroys another's kept containers.
- **`--resume` is dropped.** In news, `docker start -ai` re-runs the original
  command — for a headless `-p` container that replays an autonomous prompt
  (edits, commits, pushes). Recovery paths in v1: the auto-pushed branch
  (primary), `docker cp` from the kept container (salvage). A safe resume
  (interactive-only, refusing `-p` containers) is future work (§10).
- **`sync_main` is dropped.** It existed because news built the image and ran
  the launcher from the host working tree. Under npm distribution the engine is
  versioned independently and the container always clones fresh; the only
  host-tree inputs are `.agent/` files, which git already manages.

## 3. Project scaffold (`agent init`)

Run from a project repo root. Derives instead of prompting:

- `repo` from `git remote get-url origin` (normalizes SSH → `owner/name`)
- `project` from the repo name (slugified)
- `defaultBranch` from `git symbolic-ref refs/remotes/origin/HEAD`, falling
  back to the current branch

Writes (never overwriting user-owned files on re-run; engine-owned shims are
regenerated):

```
.agent/
├── config.js         from template, derived values filled in   [user-owned]
├── README.md         host-side config docs (see §6)            [engine-owned]
├── bin/
│   ├── agent         exec npx -y @couetilc/agentic-coding@^1 "$@"
│   ├── claude        exec npx -y @couetilc/agentic-coding@^1 claude "$@"
│   └── codex         exec npx -y @couetilc/agentic-coding@^1 codex "$@"
├── init.sh           commented template (user-space bootstrap)  [user-owned]
├── Dockerfile        OPTIONAL; not written by default — README
│                     documents creating it (overlay example)
└── env.example       project-scoped tokens documentation        [engine-owned]
```

Plus, outside `.agent/`:

- `.envrc`: create or **append** `PATH_add ./.agent/bin` (never clobber an
  existing file; skip if the line is present). Print a `direnv allow` reminder.
- `.gitignore`: ensure `.env` is ignored. `.agent/` itself is fully committed.
- Never writes secrets. Points the user at `.agent/env.example` (project
  tokens → `./.env`) and `~/.config/agentic-coding/env` (host tokens, §7).

**PATH-shadowing note (accepted tradeoff):** with direnv active, `claude` in
the project launches the *container*, not the host CLI. Escape hatch is
`command claude`; `.agent/README.md` documents this. The shims also carry the
`IS_SANDBOX` guard so they no-op politely inside the container (where the clone
includes them).

## 4. Config schema (`.agent/config.js`)

ESM, `export default`, **pure data** (no functions in v1 — keeps the bash→node
bridge trivial to reason about and the file diffable). Loaded via dynamic
`import()`, validated in `src/config.js` with actionable errors.

```js
// .agent/config.js — couetil.com example
export default {
  schemaVersion: 1,

  project: 'couetil-com',           // names image, containers, volumes, labels
  repo: 'couetilc/couetil.com',     // clone target (HTTPS + GH_TOKEN)
  defaultBranch: 'main',            // auto-push hook skips this branch

  // Named container ports → host mapping. Each gets a fresh random localhost
  // port per launch, injected as $DEV_HOST_<NAME> (e.g. $DEV_HOST_ASTRO).
  ports: { astro: 4321 },

  agents: {
    claude: { model: 'claude-fable-5', effort: 'xhigh' },
    codex:  { model: 'gpt-5.5',        effort: 'xhigh' },
  },

  // .env keys the preflight requires beyond GH_TOKEN + agent credentials.
  requiredEnv: [],

  // Extra named docker volumes mounted for cross-container caching.
  // npm cache is always mounted; add e.g. uv for Python projects.
  caches: ['uv'],
}
```

Derivations: image `agentic-<project>`, containers
`agentic-<project>-<agent>-<MMDD-HHMMSS>-<4 random hex>`
(reverse-lexical-sortable, as in news; the suffix keeps same-second launches
and kept year-old same-date containers from colliding on the name, #6),
labels `agentic-coding.project=<project>` and
`agentic-coding.version=<pkg version>`, volumes `agentic-<project>-<cache>`
except the npm cache which stays shared across projects
(`agentic-npm-cache`) to keep installs fast, matching news behavior.

## 5. Container architecture

**Two-stage image, built locally** (no registry in v1):

1. **Base** — built from the npm package's own `docker/` directory (resolved
   inside the npx/node_modules install), tagged
   `agentic-coding-base:<pkg version>` so an engine upgrade naturally triggers
   a rebuild. Contents (trimmed from news's Dockerfile): `node:24-slim`, git,
   curl, ca-certificates, jq, procps, ripgrep, gh, gitleaks (pinned), claude
   CLI (native installer, node-owned `~/.local`), codex CLI (npm global into
   the same prefix), uv (pinned), the entrypoint, the hooks copied to
   `/opt/agent/hooks`, non-root `node` user, `IS_SANDBOX=1`,
   `DISABLE_AUTOUPDATER=1`.
   *Moved out of base into overlay territory:* Playwright/Chromium, actionlint,
   shellcheck — generally useful but project-choice; news re-adds them in its
   overlay when it migrates.
2. **Overlay** — if `.agent/Dockerfile` exists, build
   `FROM agentic-coding-base:<version>` with context `.agent/`, tagged
   `agentic-<project>:<version>`; otherwise the base is used directly. The
   scaffolded README documents the split: **root/system deps (apt, /usr/local
   binaries, browser libs) go in the overlay; everything user-space goes in
   init.sh** — the container is non-root at runtime, so an init script
   *cannot* `apt install`. The overlay must not assume the repo clone exists
   (build happens before launch); repo-dependent setup belongs in init.sh.

The base `FROM` version pin is injected as a build arg by the CLI so the
overlay template is just `ARG BASE\nFROM ${BASE}` — no version literal for the
user to let drift.

**Entrypoint** (generalized from news's `entrypoint.sh`):

1. Git identity from injected `GIT_USER_NAME`/`GIT_USER_EMAIL` (no hardcoded
   personal fallback — error if unset, since the launcher always injects them
   from host `git config`).
2. HTTPS-rewrite of SSH remotes; `gh auth setup-git`;
   `core.hooksPath /opt/agent/hooks` (hooks baked in image; no per-project
   `.git-hooks/` needed; `DEFAULT_BRANCH` env drives the post-commit skip).
3. Clone `https://github.com/$REPO.git` into `/workspace` unless `.git`
   already exists (kept-container restart).
4. Agent-specific seeding, ported as-is from news: claude update + merged
   `~/.claude.json` flags + `~/.claude/settings.json` (model/effort/
   skipDangerousModePermissionPrompt from config); codex `config.toml` +
   `auth.json` decode / `--with-api-key` fallback.
5. Write the generic surface-identity instructions (§6) to
   `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`.
6. Run `/workspace/.agent/init.sh` if present and executable (project
   bootstrap: `npm ci` in subdirs, `uv sync`, ...). A failure warns loudly but
   does not block the session — the agent inside can diagnose.
   (This replaces news's hardcoded root-level `npm ci` check, which silently
   no-ops on couetil.com's `astro/package-lock.json` layout.)
7. `exec "$@"`.

**Launch flow** (`src/launch.js`, port of `agent_launch`): resolve config →
env preflight (§7) → build base (cached) → build overlay if present → pick
host ports for each named port → `docker run -it` with `--name`, labels,
cache volumes, merged env-files, `DEV_HOST_*` vars, `-p 127.0.0.1:<host>:<container>`
per named port, no `--rm`. Print the container name, the `agent clean`
reminder, and the dev-server URLs (with the "bind 0.0.0.0 inside" caveat from
news).

## 6. Documentation split (two readers, two files)

- **`.agent/README.md`** (scaffolded into each project; host-side): how to add
  ports, add deps (overlay vs init.sh rule), set project tokens in `.env`, set
  host tokens in `~/.config/agentic-coding/env`, update the tool, the
  PATH-shadowing note, recovery ("work leaves only via git; salvage with
  docker cp"). Written so a *host-side* coding agent can maintain the config.
- **In-container instructions** (`docker/instructions.md`, written by the
  entrypoint to each agent's global path): generic and concise (~15 lines) —
  the isolation contract, "you begin on a fresh clone of `main`; branch before
  committing; commit+push early and often; nothing else survives", the
  non-root missing-tool policy (ephemeral user-space installs → recurring need
  becomes an issue/PR against `.agent/`, human-gated), and a pointer:
  "project specifics live in `/workspace/.agent/README.md` and the repo's own
  CLAUDE.md/AGENTS.md." All news-specific content (backlog conventions, tool
  inventories, deploy paths) moves to the projects' own repo docs.

## 7. Env & secrets

Two env files, merged by the launcher (project overrides host); each passed
via `--env-file` only if it exists:

| File | Scope | Contents |
| --- | --- | --- |
| `~/.config/agentic-coding/env` | host (all projects) | `CLAUDE_CODE_OAUTH_TOKEN`, optional `OPENAI_API_KEY` |
| `./.env` (project root) | project | `GH_TOKEN` (fine-grained PAT scoped to this repo), deploy tokens, anything in `requiredEnv` |

Codex subscription auth stays file-based: `~/.codex/auth.json` base64-encoded
into an exported var and passed as bare `-e CODEX_AUTH_B64` (off the argv),
exactly as news does. Preflight failures name the missing key **and which file
it belongs in**. `agent doctor` prints the merged view with values redacted.

## 8. Porting map (news → package)

| news source | destination | changes |
| --- | --- | --- |
| `bin/claude` (wrapper) | `src/agents/claude.ts` | model/effort from config, not hardcoded |
| `bin/codex` (wrapper) | `src/agents/codex.ts` | same; auth-b64 injection kept verbatim in spirit |
| `_agent-common.sh` `agent_launch` | `src/launch.ts` + `src/docker.ts` | project-scoped labels; overlay build; no sync_main |
| `_agent-common.sh` `pick_port`/`port_free` | `src/ports.ts` | net-based try-listen; named ports |
| `_agent-common.sh` `agent_resume` | — dropped | future work |
| `_agent-common.sh` `--clean` | `agent clean` | label-scoped prune (bug fix) |
| `docker/Dockerfile` | `docker/Dockerfile` (base) | Playwright/actionlint/shellcheck removed → overlays |
| `docker/entrypoint.sh` | `docker/entrypoint.sh` | `$REPO` from config; hooks path `/opt/agent/hooks`; `.agent/init.sh` replaces root `npm ci`; identity fallbacks removed; heredoc → `instructions.md` |
| `.git-hooks/pre-commit` | `docker/hooks/pre-commit` | verbatim |
| `.git-hooks/post-commit` | `docker/hooks/post-commit` | branch from `$DEFAULT_BRANCH` |
| `.env.example` | `templates/env.example.tmpl` + host env docs | split per §7; Cloudflare block stays in news's own `.env.example` |

## 9. Testing

Runner: **vitest** with `@vitest/coverage-v8`. Coverage thresholds are pinned
at **100%** for lines, branches, functions, and statements over `src/**/*.ts`
in `vitest.config.ts`, so `npm run coverage` is a hard gate. Policy keeping
100% honest rather than gamed:

- No `v8-ignore` / `istanbul ignore` comments anywhere in `src/`.
- Every OS boundary (child_process, net, fs, clock, process.exit) sits behind
  an injectable seam (`src/exec.ts`, deps objects) so real logic is fully
  exercisable in unit tests.
- The docker-gated e2e suite is excluded from the coverage gate (it exercises
  shell assets, not TS).

- **Unit**: config load/validate/migrate (fixtures incl. bad schemas), name/
  label/volume derivation, port picking (occupied-port fake), env merge +
  preflight matrices, CMD construction per agent (`-p` → `codex exec`, arg
  passthrough), repo-slug normalization (ssh/https remotes).
- **Integration (no docker)**: `agent init` against tmp-dir git fixtures —
  fresh repo, re-run idempotency, existing `.envrc` append, config migration;
  `docker run` argv assembled by launch.js asserted against golden arrays
  (docker invocation stubbed at the spawn boundary).
- **E2E (docker-gated, skipped when unavailable / `AGENTIC_E2E=1` in CI)**:
  build base image; `agent shell -- true` round-trips against a local fixture
  repo served via `git daemon` or a file remote; entrypoint seeding assertions
  (`~/.claude/settings.json` contents, hooksPath, init.sh execution).

## 10. Rollout phases

1. **Package skeleton** — repo scaffolding, package.json, CLI dispatch,
   config loader + schema, unit tests, CI (test on PR). Exit: `npx . doctor`
   works against a fixture project.
2. **Launch parity** — docker.js/launch.js/ports.js/env.js + base Dockerfile +
   entrypoint + hooks; `agent claude|codex|shell|clean` reach feature parity
   with news's launchers (minus resume/sync_main). Exit: e2e suite green.
3. **Scaffolder + docs** — `agent init`, templates, `.agent/README.md`,
   in-container instructions, this repo's README. Exit: init on a scratch repo
   produces a working `agent shell`.
4. **Publish + adopt couetil.com** — npm publish; run `agent init` in
   couetil.com; write its `.agent/config.js` (ports: astro; caches: uv),
   `init.sh` (`cd astro && npm ci`), mint a fine-grained `GH_TOKEN` for
   `couetilc/couetil.com` (Contents RW, PRs RW, Issues RW, Actions R,
   Metadata R); create `~/.config/agentic-coding/env`. Exit: a real
   `agent claude -p ...` run lands a pushed branch.
   Note: agents see only pushed state — most useful once the in-flight satpic
   migration commits land.
5. **Migrate news** — `agent init` there; overlay Dockerfile re-adding
   Playwright (pin) + actionlint + shellcheck; `init.sh` with root `npm ci`;
   port the surface-identity extras into news's own docs; delete
   `bin/claude`, `bin/codex`, `bin/_agent-common.sh`, `docker/`, and the
   `.git-hooks/` wiring; trim its `.env.example`. Exit: news CI green, one
   real agent run.

## 11. Deferred / future work

Moved to [ROADMAP.md](ROADMAP.md) ("Later"). Section number kept so
cross-references in this doc stay stable.

## 12. Defaults chosen (veto anytime)

- Config filename `.agent/config.js` (over `agent.config.js` — avoids
  `.agent/agent.` stutter; the directory provides the namespace).
- `agent` as the short bin name — generic enough to collide with other tools
  someday; `agentic-coding` is the canonical bin and the shims survive a
  rename.
- Base image stays on `node:24-slim`; projects needing a different node get it
  via overlay.

## 13. GitHub credential proxy (Worker mode)

Egress credential-injection: the real GitHub credential lives only in a
Cloudflare Worker secret, never on the machine or in any container. The agent
holds a low-value **gate key** that grants *use* of the proxy (revocable,
auditable, rate-limitable at Cloudflare), never possession of the credential.
Kills per-project PAT minting: a new project needs zero secret setup. The
Worker is also a per-request policy/audit point no token scope can express.

**Mode selection — default on, per-machine.** Proxy mode activates when
`GH_PROXY_URL` + `GH_PROXY_KEY` are present in the merged env; their natural
home is `~/.config/agentic-coding/env` (set once → every project on the
machine). The existing project-overrides-host merge rule is the opt-out: a
project sets `GH_PROXY_URL=` (empty) and `GH_TOKEN=...` in `./.env` to use the
legacy path. Proxy wins when both are present. Preflight requires the proxy
pair OR `GH_TOKEN`, naming both options and their files on failure. Both env
files already flow into the container via `--env-file`, so no new launcher
injection is needed.

**Validated 2026-08-28** (local Node sim of the Worker + the real base image;
`test/` will encode these as regression fixtures):

- git smart HTTP round-trips a naive HTTP reverse proxy unmodified (public
  clone; private clone with injected auth; no MITM/TLS tricks needed).
- git endpoints require **Basic** auth (`base64("x-access-token:<tok>")`);
  the REST API's `token` scheme is rejected there.
- git sends credentials only after a 401 challenge — the gate's 401 MUST
  carry `WWW-Authenticate: Basic`, or clients never retry with the key.
- `gh` speaks GHES to any custom host: `GH_HOST=<worker-host>` +
  `GH_ENTERPRISE_TOKEN=<gate key>` routes REST to `/api/v3/*` and GraphQL to
  `/api/graphql`. `gh api`, `gh repo view`, `gh pr list`, `gh issue list` all
  verified through the sim from `agentic-coding-base:0.1.1`.
- `gh api --paginate` follows GitHub's absolute `Link:` headers straight to
  `api.github.com`, bypassing the proxy (verified: page 2 of a private repo
  404s). The Worker MUST rewrite `Link` response headers
  (`https://api.github.com/` → `https://<worker-host>/api/v3/`).

**Considered & rejected**: `HTTP_PROXY`/`HTTPS_PROXY` (git and gh both honor
them, but a forward proxy only sees `CONNECT github.com:443` — TLS is
end-to-end, so header injection is impossible without a MITM CA in the
container, and CF Workers can't accept CONNECT tunnels anyway); local sidecar
container (works, kept as fallback if Worker limits bite — adds a second
container + docker network per launch); same-container credential helper
(anything in the agent's process tree can read it — no real boundary).

**Worker** (`worker/`, ~100 lines, no deps; not shipped in the npm package):

- Gate: accept the key as `token`/`bearer` value or Basic password; 401 +
  `WWW-Authenticate: Basic realm="gh-proxy"` otherwise.
- Routes: `/api/v3/*` → `api.github.com/*`; `/api/graphql` →
  `api.github.com/graphql`; everything else → `github.com` (git smart HTTP).
- Swap: strip inbound auth; inject `token <real>` on API legs, Basic
  `x-access-token:<real>` on git legs. Rewrite `Link` headers per above.
- Secrets: `GATE_KEY` + v1 `GITHUB_TOKEN` (fine-grained PAT, now scoped to
  all repos the proxy should reach). v2 upgrades to a GitHub App minting 1-h
  installation tokens (repo scoping moves to the App installation).
- `wrangler.toml` + README: one-time `wrangler deploy` + `wrangler secret put`.
- Accepted limit: Workers cap request bodies (~100 MB) — a giant push fails;
  clones stream fine.

**Engine changes** (all seams already exist):

| Where | Change |
| --- | --- |
| `src/env.ts` | requirement becomes proxy-pair OR `GH_TOKEN`; mode resolver |
| `docker/entrypoint.sh` | when `GH_PROXY_URL` set: `insteadOf` both `https://github.com/` and `git@github.com:` → `https://x:${GH_PROXY_KEY}@<worker-host>/`; skip `gh auth setup-git`; export `GH_HOST` + `GH_ENTERPRISE_TOKEN` before the exec. Clone command, hooks, remotes unchanged — they still say `github.com`. |
| `agent doctor` | print active mode (`proxy <url>` vs `token`), key redacted |
| templates/README | proxy documented as the primary path, PAT as fallback |

**Testing**: env/mode logic is pure → unit-tested under the coverage gate.
The Worker is tested in the real runtime, not a sim:
`@cloudflare/vitest-pool-workers` runs `worker/` tests inside workerd via
vitest, with `cloudflare:test`'s `fetchMock` stubbing the github.com /
api.github.com upstreams — gate 401 + challenge, routing, header swap, `Link`
rewrite, all in-repo with no network and no account. `worker/` is its own
workspace (own `package.json`, own vitest config — the Workers pool has no v8
coverage support, so it sits outside the `src/**` 100% gate, like e2e).
Real-client e2e drives the actual git + gh binaries from the base image
against `wrangler dev --local-protocol https` (workerd again; the container
trusts the dev cert via `SSL_CERT_FILE`/`GIT_SSL_CAINFO`) with
`GH_PROXY_URL=https://host.docker.internal:<port>` — full proxy-mode e2e with
no Cloudflare account and no real tokens, gated like `AGENTIC_E2E`. The
2026-08-28 Node sim remains only as the concept-validation artifact; nothing
ships or tests against it. The deployed Worker gets the same probe script run
manually.

**Phases**: tracked in [ROADMAP.md](ROADMAP.md) ("Next").
