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
    code: 'TOO_MANY_FILES',
    message: 'Only one file may be uploaded per request.',
  },
  FST_PARTS_LIMIT: {
    code: 'TOO_MANY_PARTS',
    message: 'Too many parts in one request.',
  },
  FST_FIELDS_LIMIT: {
    code: 'TOO_MANY_PARTS',
    message: 'Too many fields in one request.',
  },
};

/**
 * Fastify's own framework errors already carry the right status — a request
 * with no Content-Type raises FST_ERR_CTP_INVALID_MEDIA_TYPE with statusCode
 * 415. Answering those with a blanket 500 would claim a server fault for what
 * is plainly a malformed client request, and would put a 500 in the logs for
 * every curl typed without a header.
 */
export function frameworkStatus(error: unknown): number | null {
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number') return null;
  return status >= 400 && status < 500 ? status : null;
}

const FRAMEWORK_CODE_MESSAGES: Record<number, { code: ErrorCode; message: string }> = {
  415: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'This endpoint expects a multipart/form-data request.',
  },
  413: { code: 'FILE_TOO_LARGE', message: 'The request body is too large.' },
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

    // A Fastify framework error that already knows it is a 4xx is a client
    // problem, not ours. Preserve its status rather than flattening to 500.
    const status = frameworkStatus(error);
    if (status !== null) {
      const mapped = FRAMEWORK_CODE_MESSAGES[status];
      const appError = mapped
        ? new AppError(mapped.code, mapped.message)
        : new AppError('VALIDATION_ERROR', 'The request could not be processed as sent.');
      request.log.info({ err: error, status }, 'malformed request rejected');
      return reply.code(status).send(appError.toEnvelope());
    }

    request.log.error({ err: error }, 'unhandled error');
    const fallback = new AppError('INTERNAL_ERROR', 'Something went wrong.');
    return reply.code(fallback.statusCode).send(fallback.toEnvelope());
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new AppError('ROUTE_NOT_FOUND', `No route for ${request.method} ${request.url}`);
    return reply.code(error.statusCode).send(error.toEnvelope());
  });
}
