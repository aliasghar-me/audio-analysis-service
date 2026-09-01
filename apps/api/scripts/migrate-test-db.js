#!/usr/bin/env node
/**
 * Apply migrations to the integration-test database.
 *
 * `prisma migrate deploy` targets whatever DATABASE_URL resolves to, so the
 * test database needs its own invocation with the variable overridden. Without
 * this, the integration suite fails with `relation "uploads" does not exist`
 * and it is never obvious why.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.resolve(appDir, '../..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
