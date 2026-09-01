// @ts-check
/**
 * Mutation testing, scoped to the pure analysis modules.
 *
 * 100% branch coverage says every branch executed. It does not say a test would
 * fail if `>` became `>=` — and this service's scoring thresholds, duration
 * boundaries and range arithmetic are exactly where an off-by-one hides behind
 * a green suite.
 *
 * Deliberately narrow. Anything touching Postgres or the filesystem is excluded:
 * each mutant re-runs the suite, so including them multiplies the runtime for
 * mutants that mostly prove the database still works.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts' },
  reporters: ['html', 'clear-text', 'progress'],
  coverageAnalysis: 'perTest',
  mutate: [
    'src/audio/**/*.ts',
    'src/http/range.ts',
    'src/http/errors.ts',
    'src/uploads/presenter.ts',
    '!src/**/*.spec.ts',
  ],
  tempDirName: '.stryker-tmp',
  htmlReporter: { fileName: 'reports/mutation.html' },
  // Measured at 92.2%, so the gate sits just beneath it: a real floor that
  // does not flap. The ~33 survivors were read individually and are
  // predominantly equivalent mutants — removing the comma guard in range.ts,
  // for instance, still returns `none` because the anchored pattern rejects
  // the header anyway. Contorting tests to kill those would make the suite
  // worse, not better.
  thresholds: { high: 95, low: 85, break: 90 },
};
