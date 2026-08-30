#!/bin/sh
# .agent/init.sh — project bootstrap, run INSIDE the container after the clone.
#
# USER-OWNED: `agent init` writes this once and never overwrites it. It runs as
# the non-root `node` user, so it CANNOT `apt install` — root/system deps belong
# in a `.agent/Dockerfile` overlay instead (see .agent/README.md). This is for
# user-space, repo-dependent setup that needs the clone to exist: installing
# dependencies, syncing tool caches, generating files.
#
# A failure here warns loudly but does NOT block the session — the agent inside
# can diagnose.

# This runs on the launch critical path (issue #8). `npm ci` already runs the
# `prepare` script, which builds dist/ (tsc) — a separate `npm run build` here
# would build twice. --prefer-offline trusts the shared npm cache volume (the
# lockfile pins exact versions, so a cache hit is byte-identical); --no-audit
# --no-fund skip two network round-trips.
npm ci --prefer-offline --no-audit --no-fund
