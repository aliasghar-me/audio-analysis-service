/**
 * Every failure this service can express, and the HTTP status it maps to.
 *
 * The table is the single source of truth: a route raises a code, and the
 * status is looked up here. Status and code therefore cannot drift apart, and
 * adding a failure mode is one line rather than a grep for `reply.code(...)`.
 */
export const ERROR_STATUS = {
  /** The request body was not multipart/form-data at all. */
  UNSUPPORTED_MEDIA_TYPE: 415,
  /** Multipart, but with no `file` part in it. */
  NO_FILE: 400,
  /** The Content-Type is one we accept but the body does not parse as it —
   *  a missing boundary parameter, most often. Distinct from
   *  UNSUPPORTED_MEDIA_TYPE, which means we do not speak that type at all. */
  MALFORMED_MULTIPART: 400,
  /** More than one file part. One upload per request, by design. */
  TOO_MANY_FILES: 400,
  /** The multipart body had more parts or fields than we will parse. */
  TOO_MANY_PARTS: 413,
  /** A file part with zero bytes. */
  EMPTY_FILE: 400,
  /** Not an MP3. `details.reason` says which check rejected it. */
  INVALID_AUDIO: 400,
  /** Exceeded MAX_UPLOAD_BYTES. `details.maxBytes` says by what standard. */
  FILE_TOO_LARGE: 413,
  /** Route params or query string failed their schema. */
  VALIDATION_ERROR: 400,
  UPLOAD_NOT_FOUND: 404,
  /** No such route. Distinct from UPLOAD_NOT_FOUND, which means "no upload with
   *  that id" — a client that retries with a different id would be wasting its
   *  time on a route that does not exist. */
  ROUTE_NOT_FOUND: 404,
  /** The row exists but its bytes do not. Deliberately not a 404 — the
   *  resource did exist, and the metadata endpoint still proves it. */
  FILE_GONE: 410,
  /** A Range header that no part of the representation can satisfy. */
  RANGE_NOT_SATISFIABLE: 416,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * An error with a client-facing code and message.
 *
 * Anything thrown that is not an AppError is, by definition, a bug: the error
 * handler logs it in full and returns a generic INTERNAL_ERROR, so an internal
 * message or a filesystem path can never reach a client by accident.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get statusCode(): number {
    return ERROR_STATUS[this.code];
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Prisma's unique-constraint violation, duck-typed.
 *
 * Deliberately not `instanceof PrismaClientKnownRequestError`: under Prisma 7
 * that class lives inside the generated client, so importing it couples this
 * module to the generator's output layout and makes it untestable without a
 * database. The error code is the stable part of the contract.
 */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if ((error as { code: unknown }).code !== 'P2002') return false;
  if (target === undefined) return true;

  const meta = (error as { meta?: { target?: unknown } }).meta;
  const fields = meta?.target;
  if (Array.isArray(fields)) return fields.includes(target);
  if (typeof fields === 'string') return fields.includes(target);
  // P2002 without usable metadata: assume it is ours rather than 500 on it.
  return true;
}
