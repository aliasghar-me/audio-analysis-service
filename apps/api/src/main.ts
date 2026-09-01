import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDatabase } from './db/client.js';

/**
 * Process entry point: load the environment, open the database, serve, and shut
 * down cleanly when the orchestrator asks.
 */

// The repository-root .env is the single source of environment truth. In Docker
// the variables come from the compose file and there is no file to load.
const appDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(appDir, '../../..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const env = loadEnv();
const db = createDatabase({ connectionString: env.DATABASE_URL });
const app = await buildApp({ env, db });

/**
 * Stop accepting connections, finish what is in flight, then close the pool.
 * Without this, an in-progress upload is killed mid-write on every deploy.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await db.$disconnect();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'failed to shut down cleanly');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void shutdown(signal));
}

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
