import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // Uncapped, vitest defaults to availableParallelism() - 1 workers (9 here), and under
    // this machine's load the timing-sensitive scenario tests time out. 2 is the chosen
    // value; confirmation is left to a run on a quiet machine.
    maxWorkers: 2,
  },
});
