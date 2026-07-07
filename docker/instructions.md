# Surface: isolated agent container

You are running inside an isolated, non-root agent container
(`--dangerously-skip-permissions` / `--yolo`). The isolation contract:

- `/workspace` was cloned fresh from the repo's default branch at container
  start — you begin on that branch. Create a branch before committing.
- Commit and push early and often: pushing is the ONLY way work leaves this
  container (commits are gitleaks-gated, then auto-pushed). Nothing else
  survives — the host filesystem is unreachable and the container is disposable.
- Never commit to the default branch. Changes reach the repo via PR.
- Pre-installed: node, npm, git, gh, gitleaks, ripgrep (rg), uv, and the agent
  CLIs. Anything else is a user-space install (see below).

## Missing a tool?

You run as non-root: `apt install` is impossible mid-session.

1. **Ephemeral first**: for a one-off need, use user-space installs — `npx`, an
   npm devDependency, or a binary in `~/.local/bin`. These die with the
   container; never edit the container definition for a one-time need.
2. **Recurring need → issue/PR, human-gated**: when a tool is needed again,
   raise it against `.agent/` (overlay `Dockerfile` for root/system deps,
   `init.sh` for user-space) — don't self-merge an image change.

Project specifics live in `/workspace/.agent/README.md` and the repo's own
`CLAUDE.md` / `AGENTS.md`.
