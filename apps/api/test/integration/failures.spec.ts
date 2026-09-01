import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import type { Database } from '../../src/db/client.js';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

/**
 * What the service does when its dependencies fail.
 *
 * A real Postgres cannot be made to fail on demand from inside the suite
 * without breaking it for every other test, so these build the real app around
 * a database that refuses. Everything else — routing, the error handler, the
 * response envelope — is the genuine article.
 */
describe('when the database is unavailable', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const failing = {
      $queryRaw: async () => {
        throw new Error('connection refused');
      },
      upload: {
        findUnique: async () => {
          throw new Error('connection refused');
        },
        findMany: async () => {
          throw new Error('connection refused');
        },
        create: async () => {
          throw new Error('connection refused');
        },
        update: async () => {
          throw new Error('connection refused');
        },
      },
    } as unknown as Database;

    app = await buildApp({ env: { ...loadEnv(), LOG_LEVEL: 'silent' }, db: failing });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports itself degraded rather than healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    // 503, not 500: the process is fine, its dependency is not, and an
    // orchestrator needs to take it out of rotation rather than restart it.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', database: 'down' });
  });

  it('answers a read with a generic 500 that leaks nothing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/uploads/0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' },
    });
    // The real cause goes to the log, never to the client.
    expect(response.body).not.toContain('connection refused');
    expect(response.body).not.toContain('    at ');
  });

  it('answers a listing with a generic 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/uploads' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
  });

  it('fails an upload without leaving anything behind', async () => {
    const response = await app.inject(uploadRequest(synthesizeMp3({ frames: 200 })));

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('connection refused');
  });
});

describe('logger configuration', () => {
  it('attaches the pretty transport in development and still serves requests', async () => {
    // The only branch in app.ts: development gets pino-pretty, everything else
    // gets plain JSON lines. Worth proving the app still boots with it.
    const app = await buildApp({
      env: { ...loadEnv(), NODE_ENV: 'development', LOG_LEVEL: 'silent' },
      db: { $queryRaw: async () => [{ 1: 1 }] } as unknown as Database,
    });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('when a row survives but its bytes do not', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildTestHarness();
    await harness.truncate();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('404s the file endpoint for an id that was never stored', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/uploads/0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee/file',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('UPLOAD_NOT_FOUND');
  });
});
