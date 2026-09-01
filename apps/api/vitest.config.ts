import { defineConfig } from 'vitest/config';

/**
 * Unit tests: pure functions only, no database, no filesystem, no HTTP.
 *
 * This suite runs on a bare checkout with nothing but `pnpm install` — which is
 * the reason the audio analysis lives in pure modules in the first place.
 */
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/helpers/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
