import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import FormData from 'form-data';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createDatabase, type Database } from '../../src/db/client.js';

export interface TestHarness {
  app: FastifyInstance;
  db: Database;
  env: Env;
  storageDir: string;
  /** Wipe the table between cases. Refuses to run outside NODE_ENV=test. */
  truncate(): Promise<void>;
  /** Every stored audio file, relative to the storage root. */
  storedFiles(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * A real Fastify app, a real Postgres, a real filesystem. Nothing is mocked —
 * the point of this suite is to prove the pieces fit together, and a mocked
 * unique constraint would prove nothing about concurrency.
 */
export async function buildTestHarness(overrides: Partial<Env> = {}): Promise<TestHarness> {
  const env = { ...loadEnv(), ...overrides };
  const db = createDatabase({ connectionString: env.DATABASE_URL, maxConnections: 5 });
  const app = await buildApp({ env, db });
  await app.ready();

  const storageDir = path.resolve(process.cwd(), env.STORAGE_DIR);

  return {
    app,
    db,
    env,
    storageDir,

    async truncate() {
      if (process.env['NODE_ENV'] !== 'test') {
        throw new Error('refusing to truncate outside NODE_ENV=test');
      }
      await db.$executeRawUnsafe('TRUNCATE TABLE "uploads" RESTART IDENTITY CASCADE');
      await rm(path.join(storageDir, 'audio'), { recursive: true, force: true });
      await rm(path.join(storageDir, 'tmp'), { recursive: true, force: true });
    },

    async storedFiles() {
      const root = path.join(storageDir, 'audio');
      const found: string[] = [];
      async function walk(dir: string): Promise<void> {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry);
          if ((await stat(full)).isDirectory()) await walk(full);
          else found.push(path.relative(root, full));
        }
      }
      await walk(root);
      return found.sort();
    },

    async close() {
      await app.close();
      await db.$disconnect();
    },
  };
}

/**
 * Build a multipart upload request for `app.inject()`.
 *
 * `inject` exercises the identical multipart code path without opening a
 * socket, which is why there is no supertest and no port allocation here.
 */
export function uploadRequest(
  body: Buffer,
  options: { filename?: string; contentType?: string; field?: string } = {},
): InjectOptions {
  const form = new FormData();
  form.append(options.field ?? 'file', body, {
    filename: options.filename ?? 'sample.mp3',
    contentType: options.contentType ?? 'audio/mpeg',
  });

  return {
    method: 'POST',
    url: '/api/upload',
    payload: form.getBuffer(),
    headers: form.getHeaders(),
  };
}
