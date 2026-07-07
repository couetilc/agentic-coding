# Base agent image for @couetilc/agentic-coding (PLAN.md §5). Everything a
# Claude Code / Codex session needs to run non-root in an isolated container:
# node, git, gh, gitleaks, the two agent CLIs, uv. Nothing project-specific —
# projects layer root/system deps in an optional `.agent/Dockerfile` overlay
# (FROM this image via the injected BASE build-arg) and user-space deps in
# `.agent/init.sh`. Nothing from the host is mounted: each container clones the
# repo from GitHub at launch; work leaves only via git push.
FROM node:24-slim

# Base CLI toolchain. ripgrep (rg) is fast search for shell sessions;
# git/curl/ca-certificates/jq/procps are the launch/entrypoint prerequisites.
# (shellcheck, actionlint, and Playwright/Chromium were dropped from news's
# image — they are project choices that belong in an overlay, PLAN.md §5.)
RUN apt-get update && apt-get install -y --no-install-recommends \
		git curl ca-certificates jq procps ripgrep \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# gitleaks: pinned, arch-matched static binary. The pre-commit hook (baked into
# the image at /opt/agent/hooks) scans staged changes with it.
ARG GITLEAKS_VERSION=8.29.0
RUN arch=$(dpkg --print-architecture) && case "$arch" in \
		amd64) gl_arch=x64 ;; arm64) gl_arch=arm64 ;; *) echo "unsupported arch $arch" && exit 1 ;; esac \
	&& curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz" \
		| tar -xz -C /usr/local/bin gitleaks \
	&& gitleaks version

# The generalized entrypoint, the baked git hooks, and the in-container surface
# instructions (written to the agent's global path each start by the entrypoint).
COPY entrypoint.sh /usr/local/bin/agent-entrypoint
COPY hooks /opt/agent/hooks
COPY instructions.md /opt/agent/instructions.md
RUN chmod +x /usr/local/bin/agent-entrypoint /opt/agent/hooks/*

# Pre-create node-owned dirs so fresh cache volumes and the clone target never
# end up root-owned: /workspace (clone), ~/.npm + ~/.cache/uv (the cache paths
# the tool maps by name — a fresh named volume copies the image dir's
# ownership), ~/.claude (seeded settings). Cache names without a baked dir get
# their mountpoint chowned by the launcher's pre-step (chownCacheArgs).
RUN mkdir -p /workspace /home/node/.claude /home/node/.npm /home/node/.cache/uv \
	&& chown -R node:node /workspace /home/node/.claude /home/node/.npm /home/node/.cache

USER node
WORKDIR /workspace

# claude CLI via the native installer, owned by `node` (~/.local) so the
# entrypoint can `claude update` before a session. Mid-session auto-update is
# off for predictability — the refresh happens at start.
ENV PATH="/home/node/.local/bin:${PATH}"
RUN curl -fsSL https://claude.ai/install.sh | bash

# codex CLI (OpenAI) into the same node-owned ~/.local prefix, so `agent clean`
# rebuilds refresh both CLIs together.
RUN npm install -g --prefix /home/node/.local @openai/codex \
	&& codex --version

# uv (Astral): runs Python tooling scripts without a system Python or root.
# Pinned, arch-matched static binary; the glibc (-gnu) build matches node:24-slim
# (Debian). Extracted into the node-owned ~/.local/bin (already on PATH).
ARG UV_VERSION=0.11.21
RUN arch=$(dpkg --print-architecture) && case "$arch" in \
		amd64) uv_arch=x86_64-unknown-linux-gnu ;; \
		arm64) uv_arch=aarch64-unknown-linux-gnu ;; \
		*) echo "unsupported arch $arch" && exit 1 ;; esac \
	&& curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}.tar.gz" \
		| tar -xz -C /home/node/.local/bin --strip-components=1 \
			"uv-${uv_arch}/uv" "uv-${uv_arch}/uvx" \
	&& uv --version

# IS_SANDBOX marks this as a sandboxed environment (the CLI's docker-in-docker
# guard also keys off it). DISABLE_AUTOUPDATER keeps the CLIs frozen mid-session.
ENV IS_SANDBOX=1
ENV DISABLE_AUTOUPDATER=1

ENTRYPOINT ["agent-entrypoint"]
# The launcher always passes an explicit CMD (claude/codex/bash + config flags);
# this default only covers a bare `docker run` of the image.
CMD ["bash"]
