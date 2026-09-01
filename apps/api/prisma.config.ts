import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 no longer loads `.env` implicitly, and the single source of
 * environment truth here is the repository-root `.env` rather than a per-app
 * copy. Load it so the CLI, migrations and the running server all resolve
 * DATABASE_URL identically.
 *
 * Inlined rather than importing a helper: the Prisma CLI loads this file
 * through its own loader, before anything in src/ has been built.
 */
const appDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(appDir, '../..', '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  schema: path.join(appDir, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(appDir, 'prisma', 'migrations'),
  },
  datasource: {
    // `prisma migrate` against the test database goes through
    // scripts/migrate-test-db.js, which overrides DATABASE_URL first.
    url: process.env['DATABASE_URL'] ?? '',
  },
});
