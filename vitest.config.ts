import { defineConfig } from 'vitest/config';

// Coverage is scoped to src/** only (this config and test/ are excluded by not
// being listed in `include`). Thresholds are pinned at 100% per PLAN.md §9 so
// `npm run coverage` is a hard gate; honesty is kept by banning ignore comments
// and routing every OS boundary through an injectable seam instead.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
