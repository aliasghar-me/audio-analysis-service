import { defineConfig } from 'vitest/config';

/**
 * The unit suite alone, flattened out of `projects`.
 *
 * Stryker's vitest runner has no option to select a project, so pointing it at
 * `vitest.config.ts` would re-run the integration, security and large suites
 * for every mutant — each needing Postgres, and the large one moving 50 MB.
 * The mutated modules are all pure, so the unit suite is the only one that can
 * kill their mutants anyway.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/helpers/**/*.spec.ts', 'test/fixtures/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
