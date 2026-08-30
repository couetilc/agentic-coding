# Roadmap

Forward-looking work for `@couetilc/agentic-coding`. Design detail lives in
[PLAN.md](PLAN.md) (§ references below); this file is the what-and-in-what-order.
Completed work lives in git history, not here.

## Also: System prompt injection into every agent session

Every agent running should get a command injected into memory:

```md
- commit often when you've completed pieces of work, and merge PRs. you do not
  need human approval to commit or merge into main. commits should auto-push to
  the remote. share PRs when you want a human to review them.
- store memory in ~/.agent/skills/memory-* (is this a good idea?)
```

Once the GitHub credential proxy is working, I can add some instructions
surrounding the `gh` CLI and what permissions the default auth session has.

## Next: GitHub credential proxy (Worker mode) — PLAN.md §13

Egress credential injection via a Cloudflare Worker: the real GitHub
credential never touches the machine or any container; agents hold only a
revocable gate key. Mechanisms validated 2026-08-28 (see §13).

- **Phase A — standalone Worker**: `worker/` workspace + one-time deploy docs
  (`wrangler deploy`, `wrangler secret put`), fine-grained-PAT secret, gate
  key, `Link`-header rewrite. Usable on its own before any engine changes.
- **Phase B — engine integration**: proxy-pair-or-`GH_TOKEN` preflight
  (`src/env.ts`), entrypoint proxy branch (`insteadOf` rewrite,
  `GH_HOST`/`GH_ENTERPRISE_TOKEN` export), `agent doctor` mode line,
  workerd-in-vitest tests + `wrangler dev` e2e.
- **Phase C — hardening**: GitHub App installation tokens (1 h) replacing the
  PAT, repo allowlist for write ops, optional `agent proxy` helper
  (deploy/rotate), Cloudflare Access service-token gate.

## Adoption (PLAN.md §10, remaining)

- **couetil.com** — `agent init`; `config.js` (ports: astro; caches: uv),
  `init.sh` (`cd astro && npm ci`); project `GH_TOKEN` (or proxy mode once
  Phase B lands). Exit: a real `agent claude -p ...` run lands a pushed
  branch.
- **news** — `agent init`; overlay Dockerfile re-adding Playwright (pin) +
  actionlint + shellcheck; `init.sh` with root `npm ci`; delete its
  `bin/claude`, `bin/codex`, `bin/_agent-common.sh`, `docker/`, and
  `.git-hooks/` wiring. Exit: news CI green, one real agent run.

## Later

- **Safe resume**: interactive-only reattach (refuse `-p` containers),
  possibly via `docker exec` into a running container or a session-manager
  process rather than `docker start -ai` replay.
- Registry-published base image (GHCR) to skip the first local build.
- Additional agent integrations (the `src/agents/` seam is the contract).
- `agent prune --all-projects`, container GC by age.
- Config as functions / `defineConfig()` helper with editor types.
- Windows hosts.
