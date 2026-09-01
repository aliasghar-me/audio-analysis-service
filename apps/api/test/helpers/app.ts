import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
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
  /** Anything left in the staging directory. Should always be empty once a
   *  request has finished, whether it succeeded or was rejected. */
  stagedFiles(): Promise<string[]>;
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

    async stagedFiles() {
      try {
        return (await readdir(path.join(storageDir, 'tmp'))).sort();
      } catch {
        return [];
      }
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

/**
 * A multipart upload whose body is a *stream*, for payloads that must never be
 * held in memory.
 *
 * `uploadRequest` builds the whole body as one Buffer, which is fine at test
 * sizes and self-defeating at 50 MB — a test asserting the service streams
 * cannot itself materialise the file. `light-my-request` accepts a
 * `NodeJS.ReadableStream` as the payload, so the envelope is assembled around
 * the file stream rather than around its bytes.
 */
export function streamingUploadRequest(
  file: Readable,
  options: { filename?: string; contentType?: string; field?: string } = {},
): InjectOptions {
  const boundary = `----audio-analysis-${Math.random().toString(36).slice(2)}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${options.field ?? 'file'}"; ` +
      `filename="${options.filename ?? 'large.mp3'}"\r\n` +
      `Content-Type: ${options.contentType ?? 'audio/mpeg'}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);

  async function* body() {
    yield preamble;
    for await (const chunk of file) yield chunk as Buffer;
    yield epilogue;
  }

  return {
    method: 'POST',
    url: '/api/upload',
    payload: Readable.from(body()),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
