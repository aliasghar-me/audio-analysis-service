import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import { registerErrorHandler } from './http/error-handler.js';
import { FileStore } from './storage/store.js';
import { UploadsRepository } from './uploads/repository.js';
import { registerUploadRoutes } from './uploads/routes.js';
import { UploadsService } from './uploads/service.js';

export interface BuildAppOptions {
  env: Env;
  db: Database;
}

/**
 * Assemble the application.
 *
 * Everything is passed in rather than imported as a singleton, which is what
 * lets the integration suite build a real app against the test database and a
 * temporary storage directory without mocking anything.
 */
export async function buildApp({ env, db }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
    },
    // The upload cap belongs to multipart, below. This one only covers JSON.
    bodyLimit: 1_048_576,
  });

  await app.register(cors, { origin: true });

  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      files: 1,
      fields: 5,
      parts: 10,
    },
  });

  const storageRoot = path.resolve(process.cwd(), env.STORAGE_DIR);
  const store = new FileStore(storageRoot);
  const repository = new UploadsRepository(db);
  const outlierPolicy = {
    minSeconds: env.OUTLIER_MIN_SECONDS,
    maxSeconds: env.OUTLIER_MAX_SECONDS,
  };

  const service = new UploadsService({
    repository,
    store,
    outlierPolicy,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    logger: app.log,
  });

  registerErrorHandler(app);

  app.get('/health', async (_request, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok', database: 'up' });
    } catch (error) {
      app.log.error({ err: error }, 'health check failed');
      return reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  await registerUploadRoutes(app, { service, repository, store, outlierPolicy });

  return app;
}
