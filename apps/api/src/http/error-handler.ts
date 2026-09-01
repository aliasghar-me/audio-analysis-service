import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, type ErrorCode } from './errors.js';

/**
 * Multipart failures arrive as Fastify error codes rather than as our own.
 * Translating them here means no route has to know that busboy exists.
 */
const MULTIPART_ERRORS: Record<string, { code: ErrorCode; message: string }> = {
  FST_INVALID_MULTIPART_CONTENT_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'This endpoint expects a multipart/form-data request.',
  },
  FST_REQ_FILE_TOO_LARGE: {
    code: 'FILE_TOO_LARGE',
    message: 'The uploaded file exceeds the size limit.',
  },
  FST_FILES_LIMIT: {
    code: 'FILE_TOO_LARGE',
    message: 'Too many files in one request; upload one file at a time.',
  },
  FST_PARTS_LIMIT: {
    code: 'FILE_TOO_LARGE',
    message: 'Too many parts in one request.',
  },
  FST_FIELDS_LIMIT: {
    code: 'FILE_TOO_LARGE',
    message: 'Too many fields in one request.',
  },
};

/**
 * One error handler, one response shape.
 *
 * Anything that is not an AppError is a bug by definition: it is logged in
 * full and answered with a generic 500, so an internal message or a filesystem
 * path can never reach a client by accident.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    // A rejected upload still has a body in flight. Draining it means the
    // client reads our JSON instead of an ECONNRESET.
    if (!request.raw.readableEnded) {
      request.raw.resume();
    }

    if (error instanceof AppError) {
      request.log.info({ err: error, code: error.code }, 'request rejected');
      return reply.code(error.statusCode).send(error.toEnvelope());
    }

    if (error instanceof ZodError) {
      const appError = new AppError('VALIDATION_ERROR', 'The request could not be validated.', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return reply.code(appError.statusCode).send(appError.toEnvelope());
    }

    const errorCode = (error as { code?: unknown }).code;
    const multipart = typeof errorCode === 'string' ? MULTIPART_ERRORS[errorCode] : undefined;
    if (multipart) {
      const appError = new AppError(multipart.code, multipart.message);
      request.log.info({ err: error }, 'multipart request rejected');
      return reply.code(appError.statusCode).send(appError.toEnvelope());
    }

    request.log.error({ err: error }, 'unhandled error');
    const fallback = new AppError('INTERNAL_ERROR', 'Something went wrong.');
    return reply.code(fallback.statusCode).send(fallback.toEnvelope());
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new AppError('UPLOAD_NOT_FOUND', `No route for ${request.method} ${request.url}`);
    return reply.code(404).send(error.toEnvelope());
  });
}
