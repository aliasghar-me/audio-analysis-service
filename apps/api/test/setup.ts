import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Point the integration suite at the test database and a throwaway storage
 * directory, before any application module is imported.
 *
 * The suite runs single-worker, so this file is evaluated once per test file.
 * The guard makes it idempotent: without it, the second file would compare an
 * already-swapped DATABASE_URL against itself and the safety check below would
 * be meaningless.
 */
const ALREADY_SWAPPED = '__AUDIO_TEST_ENV_READY__';

if (!process.env[ALREADY_SWAPPED]) {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envPath = path.resolve(appDir, '../..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }

  const testUrl = process.env['TEST_DATABASE_URL'];
  if (!testUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env, then run `pnpm infra:up`.',
    );
  }

  // Truncating the development database because of a typo in .env is the kind
  // of afternoon nobody needs.
  if (testUrl === process.env['DATABASE_URL']) {
    throw new Error('TEST_DATABASE_URL must not be the same database as DATABASE_URL.');
  }

  process.env['DATABASE_URL'] = testUrl;
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'silent';
  process.env['STORAGE_DIR'] = mkdtempSync(path.join(tmpdir(), 'audio-analysis-test-'));
  process.env[ALREADY_SWAPPED] = '1';
}
