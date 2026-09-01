#!/bin/bash
# Bootstrap the agent container, then exec the requested command (PLAN.md §5).
# Setup shared by every agent (git identity, clone, hooks, instructions,
# .agent/init.sh) runs unconditionally; agent-specific CLI config + auth is
# branched on $AGENT_KIND. Generalized from news's entrypoint: $REPO drives the
# clone, hooks live at /opt/agent/hooks, and .agent/init.sh replaces the
# hardcoded root `npm ci`.
set -e

# ── 0. Launch timing (issue #8) ──────────────────────────────────────
# AGENT_TIMING=1 prints per-stage durations to stderr (never stdout — scripted
# `agent claude -p` owns stdout). AGENT_LAUNCH_T0 is the host launcher's
# wall-clock in ms, captured just before `docker run`; containers share the
# host kernel clock, so entry-minus-T0 is the docker create+start overhead the
# host cannot observe itself (`docker run` only returns when the session ends).
AGENT_TIMING="${AGENT_TIMING:-}"
if [ -n "$AGENT_TIMING" ]; then
	T_ENTRY_NS=$(date +%s%N)
	T_PREV_NS=$T_ENTRY_NS
	if [ -n "${AGENT_LAUNCH_T0:-}" ]; then
		printf '[agent-timing] %-26s %6d ms\n' 'docker create+start' \
			"$(( T_ENTRY_NS / 1000000 - AGENT_LAUNCH_T0 ))" >&2
	fi
fi
# timing_mark <label>: print the time since the previous mark, then reset it.
timing_mark() {
	if [ -n "$AGENT_TIMING" ]; then
		local now_ns
		now_ns=$(date +%s%N)
		printf '[agent-timing] %-26s %6d ms\n' "$1" \
			"$(( (now_ns - T_PREV_NS) / 1000000 ))" >&2
		T_PREV_NS=$now_ns
	fi
}

# Which agent this container runs (the launcher injects claude|codex|shell). No
# default seeding for a bare `docker run` — only explicit claude/codex seed CLIs.
AGENT_KIND="${AGENT_KIND:-}"

# ── 1. Git identity ──────────────────────────────────────────────────
# Injected from the host's `git config` by the launcher. No personal fallback:
# error out if unset (the launcher preflights this too, but the entrypoint is
# the last line of defense — a bare `docker run` must not commit as nobody).
if [ -z "${GIT_USER_NAME:-}" ] || [ -z "${GIT_USER_EMAIL:-}" ]; then
	echo "error: GIT_USER_NAME and GIT_USER_EMAIL must be set (injected from host git config)" >&2
	exit 1
fi
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

# ── 2. Git transport + hooks ─────────────────────────────────────────
# All git traffic is HTTPS with GH_TOKEN (no SSH keys in here — that's the
# point); rewrite any SSH remotes defensively. Hooks are baked into the image
# (gitleaks pre-commit, auto-push post-commit); DEFAULT_BRANCH drives the
# post-commit skip.
git config --global url."https://github.com/".insteadOf "git@github.com:"
git config --global core.hooksPath /opt/agent/hooks
if [ -n "${GH_TOKEN:-}" ]; then
	gh auth setup-git 2>/dev/null || true
fi
timing_mark 'git identity + transport'

# ── 3. Clone the workspace ───────────────────────────────────────────
# Each container clones its own tree — no host mounts, so parallel containers
# share nothing. Skipped when /workspace/.git already exists (kept-container
# restart). AGENTIC_TEST_REPO_URL is TEST-ONLY: it lets the e2e suite clone a
# local file:// / git-daemon fixture with no GitHub and no token. Never set it
# in real use — production always clones https://github.com/$REPO.git with
# GH_TOKEN.
if [ ! -e /workspace/.git ]; then
	if [ -n "${AGENTIC_TEST_REPO_URL:-}" ]; then
		echo "Cloning from AGENTIC_TEST_REPO_URL (test-only)..."
		git clone "$AGENTIC_TEST_REPO_URL" /workspace
	else
		if [ -z "${REPO:-}" ]; then
			echo "error: REPO is required (owner/name) to clone the workspace" >&2
			exit 1
		fi
		if [ -z "${GH_TOKEN:-}" ]; then
			echo "error: GH_TOKEN is required to clone ${REPO} over HTTPS" >&2
			exit 1
		fi
		echo "Cloning ${REPO}..."
		git clone "https://github.com/${REPO}.git" /workspace
	fi
fi
timing_mark 'workspace clone'

# ── 4. Agent-specific CLI setup ──────────────────────────────────────
if [ "$AGENT_KIND" = "codex" ]; then
	# config.toml: model/effort from the injected env (not hardcoded), plus a
	# /workspace trust entry so Codex loads repo guidance without the first-run
	# trust UI. The launcher also passes both as flags — the reliable source of
	# truth (config.toml effort can be ignored on a fresh launch, openai/codex#17436).
	mkdir -p "$HOME/.codex"
	{
		printf 'model = "%s"\n' "${CODEX_MODEL:-gpt-5.6-sol}"
		printf 'model_reasoning_effort = "%s"\n\n' "${CODEX_EFFORT:-xhigh}"
		printf '[projects."/workspace"]\n'
		printf 'trust_level = "trusted"\n'
	} > "$HOME/.codex/config.toml"
	# Auth. Primary: the host's `codex login` credential, injected base64-encoded
	# (auth.json is multi-line JSON --env-file can't carry). Fallback:
	# OPENAI_API_KEY for pay-as-you-go API billing. Never block startup.
	if [ -n "${CODEX_AUTH_B64:-}" ]; then
		# `if` consumes the decode's status, so a bad blob never aborts start.
		if printf '%s' "$CODEX_AUTH_B64" | base64 -d > "$HOME/.codex/auth.json"; then
			chmod 600 "$HOME/.codex/auth.json"
		fi
	elif command -v codex >/dev/null 2>&1 && [ -n "${OPENAI_API_KEY:-}" ]; then
		# The CLI dropped `--api-key`; pipe the key to `--with-api-key` instead.
		printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1 || true
	fi
elif [ "$AGENT_KIND" = "claude" ]; then
	# (The CLI freshness check moved to §6.5: it must run AFTER this seeding —
	# the updater can create ~/.claude.json, and racing the jq merge below
	# would clobber the seeded flags — and it now TTL-gates against the shared
	# install volume instead of blocking every launch. Issue #8 P1a.)

	# First-run state: onboarding, bypass-permissions warning, and /workspace
	# trust marked complete so a fresh container drops straight into an
	# authenticated session. The installer/`claude update` create ~/.claude.json,
	# so MERGE the flags; theme defaulted only when unset; idempotent on restart.
	flags='{"hasCompletedOnboarding": true, "bypassPermissionsModeAccepted": true, "projects": {"/workspace": {"hasTrustDialogAccepted": true}}}'
	if [ -f "$HOME/.claude.json" ]; then
		jq --argjson flags "$flags" '. * $flags | .theme //= "dark"' "$HOME/.claude.json" \
			> "$HOME/.claude.json.tmp" && mv "$HOME/.claude.json.tmp" "$HOME/.claude.json"
	else
		printf '%s\n' "$flags" | jq '.theme = "dark"' > "$HOME/.claude.json"
	fi

	# settings.json: model/effort defaults from the injected env (config owns the
	# values, not a hardcoded literal), seeded STICKY (`//=`, news semantics): a
	# kept-container restart must not stomp an in-session /model choice. Config
	# still wins for every real launch — the launcher's CMD carries explicit
	# --model/--effort flags. skipDangerousModePermissionPrompt pre-accepts the
	# bypass dialog.
	mkdir -p "$HOME/.claude"
	if [ -f "$HOME/.claude/settings.json" ]; then
		jq --arg m "${CLAUDE_MODEL:-claude-fable-5}" --arg e "${CLAUDE_EFFORT:-xhigh}" \
			'.model //= $m | .effort //= $e | .skipDangerousModePermissionPrompt //= true' \
			"$HOME/.claude/settings.json" \
			> "$HOME/.claude/settings.json.tmp" && mv "$HOME/.claude/settings.json.tmp" "$HOME/.claude/settings.json"
	else
		jq -n --arg m "${CLAUDE_MODEL:-claude-fable-5}" --arg e "${CLAUDE_EFFORT:-xhigh}" \
			'{model: $m, effort: $e, skipDangerousModePermissionPrompt: true}' \
			> "$HOME/.claude/settings.json"
	fi
fi
timing_mark 'agent CLI setup'

# ── 5. Surface-identity instructions ─────────────────────────────────
# Container-scoped global instructions, auto-loaded into every session's
# context. Written to the agent's global path and overwritten each start so
# updates propagate. Non-codex (claude/shell/bare) uses the claude path.
case "$AGENT_KIND" in
	codex) AGENT_GLOBAL_INSTRUCTIONS="$HOME/.codex/AGENTS.md" ;;
	*)     AGENT_GLOBAL_INSTRUCTIONS="$HOME/.claude/CLAUDE.md" ;;
esac
mkdir -p "$(dirname "$AGENT_GLOBAL_INSTRUCTIONS")"
cp /opt/agent/instructions.md "$AGENT_GLOBAL_INSTRUCTIONS"
timing_mark 'surface instructions'

# ── 6. Project bootstrap ─────────────────────────────────────────────
# Run the project's user-space bootstrap if it exists and is executable
# (npm ci in subdirs, uv sync, ...). A failure warns loudly but does NOT block —
# the agent inside can diagnose. (Replaces news's hardcoded root-level npm ci.)
if [ -x /workspace/.agent/init.sh ]; then
	echo "Running /workspace/.agent/init.sh..."
	if ! /workspace/.agent/init.sh; then
		echo "warning: /workspace/.agent/init.sh failed (non-fatal); continuing" >&2
	fi
fi
timing_mark 'project init.sh'

# ── 6.5 Claude CLI freshness (issue #8 P1a) ──────────────────────────
# ~/.local/share/claude is a shared machine-wide named volume (launcher
# cacheMounts): docker seeds an empty volume from the image's baked install
# (copy-on-first-use), and one update from any container serves every later
# launch. First activate the newest version the volume holds — this
# container's image-baked bin symlink may point at a version the volume has
# since superseded — then TTL-gate `claude update` on a marker file in the
# volume: fresh → skip (one stat); expired → BLOCKING update under flock, so
# this session starts current and parallel launches don't double-download.
# Runs after the §4 seeding (the updater can create ~/.claude.json; racing
# the jq merge would clobber the seeded flags). AGENT_NO_UPDATE=1 skips the
# check entirely; AGENT_UPDATE_TTL_HOURS tunes the window (default 12).
if [ "$AGENT_KIND" = "claude" ]; then
	claude_share="$HOME/.local/share/claude"
	claude_activate() {
		local newest
		newest=$(ls "$claude_share/versions" 2>/dev/null | sort -V | tail -n 1)
		if [ -n "$newest" ]; then
			ln -sfn "$claude_share/versions/$newest" "$HOME/.local/bin/claude"
		fi
	}
	claude_update_fresh() {
		[ -f "$claude_share/.last-update-check" ] \
			&& [ $(( $(date +%s) - $(stat -c %Y "$claude_share/.last-update-check") )) -lt $(( ${AGENT_UPDATE_TTL_HOURS:-12} * 3600 )) ]
	}
	claude_activate
	if [ -z "${AGENT_NO_UPDATE:-}" ] && ! claude_update_fresh; then
		if command -v flock >/dev/null 2>&1; then
			(
				flock -w 30 9 || exit 0
				# Re-check under the lock: a parallel launch may have just updated.
				claude_update_fresh && exit 0
				claude update 2>&1 | tail -n 1 || true
				touch "$claude_share/.last-update-check"
			) 9>>"$claude_share/.update.lock"
		else
			claude update 2>&1 | tail -n 1 || true
			touch "$claude_share/.last-update-check"
		fi
		# Point the symlink at whatever the update just installed.
		claude_activate
	fi
fi
timing_mark 'claude CLI freshness'

# ── 7. Hand off to the requested command ─────────────────────────────
if [ -n "$AGENT_TIMING" ]; then
	printf '[agent-timing] %-26s %6d ms\n' 'entrypoint total' \
		"$(( ($(date +%s%N) - T_ENTRY_NS) / 1000000 ))" >&2
fi
exec "$@"
