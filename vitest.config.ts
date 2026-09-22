import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // Uncapped, vitest runs a worker per file and the timing-sensitive
    // scenario tests time out; 2 was the only green value measured (3 and 4 were not).
    maxWorkers: 2,
  },
});
