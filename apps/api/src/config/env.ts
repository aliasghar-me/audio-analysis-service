import { z } from 'zod';

/**
 * The one place this application reads `process.env`.
 *
 * Everything downstream takes a typed `Env` value, so a missing variable fails
 * once at boot with the key named, rather than surfacing as `undefined` in the
 * middle of an upload.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'a Postgres connection string is required'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4490),

  /** Relative paths resolve from the api app directory. */
  STORAGE_DIR: z.string().default('./storage'),

  /** 50 MiB. Enforced by @fastify/multipart — the only place the cap exists. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800),

  OUTLIER_MIN_SECONDS: z.coerce.number().nonnegative().default(5),
  OUTLIER_MAX_SECONDS: z.coerce.number().positive().default(600),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/**
 * Parse and validate the environment.
 *
 * Throws with every problem listed at once — fixing a `.env` one restart at a
 * time is a waste of everyone's afternoon.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvironmentError(`Invalid environment configuration:\n${problems}`);
  }

  if (result.data.OUTLIER_MIN_SECONDS >= result.data.OUTLIER_MAX_SECONDS) {
    throw new EnvironmentError(
      'Invalid environment configuration:\n  OUTLIER_MIN_SECONDS must be less than OUTLIER_MAX_SECONDS',
    );
  }

  return result.data;
}
