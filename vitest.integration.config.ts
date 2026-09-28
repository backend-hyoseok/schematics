import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/integration/**/*.integration.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 240000,
  },
});
