import { defineConfig } from 'vitest/config';

/**
 * Integration tests, against a real Postgres and a real filesystem.
 *
 * One database, shared: parallel files would truncate each other's rows
 * mid-test, so this suite is single-file, single-fork by construction.
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['test/integration/**/*.spec.ts'],
    setupFiles: ['./test/setup.ts'],
    // One database, one worker. In Vitest 4 `fileParallelism: false` is what
    // pins this to a single worker; `poolOptions.forks.singleFork` is gone.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
