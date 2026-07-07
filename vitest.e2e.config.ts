import { defineConfig } from 'vitest/config';

// Docker-gated end-to-end suite (PLAN.md §9). Excluded from the coverage gate:
// it builds the base image and drives real containers to assert the shell
// assets (entrypoint clone/hooks/seeding/init.sh), not TS. Runs only when
// AGENTIC_E2E=1; the base image build downloads toolchains, so allow ~10min on
// a cold first build.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // Building the base image is a one-time multi-minute cost; give it room.
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
