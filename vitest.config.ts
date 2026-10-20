import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
