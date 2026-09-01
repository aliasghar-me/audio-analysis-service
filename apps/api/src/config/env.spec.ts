import { describe, expect, it } from 'vitest';
import { EnvironmentError, loadEnv } from './env.js';

const minimal = { DATABASE_URL: 'postgresql://u:p@localhost:5495/db' };

describe('loadEnv', () => {
  it('names the missing key rather than failing anonymously', () => {
    expect(() => loadEnv({})).toThrow(EnvironmentError);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('applies defaults for everything optional', () => {
    const env = loadEnv(minimal);
    expect(env.API_PORT).toBe(4490);
    expect(env.MAX_UPLOAD_BYTES).toBe(52_428_800);
    expect(env.OUTLIER_MIN_SECONDS).toBe(5);
    expect(env.OUTLIER_MAX_SECONDS).toBe(600);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces the numeric variables, which arrive as strings', () => {
    const env = loadEnv({ ...minimal, API_PORT: '3000', MAX_UPLOAD_BYTES: '1024' });
    expect(env.API_PORT).toBe(3000);
    expect(env.MAX_UPLOAD_BYTES).toBe(1024);
  });

  it('rejects a log level it does not understand', () => {
    expect(() => loadEnv({ ...minimal, LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects an outlier window that is inside out', () => {
    expect(() =>
      loadEnv({ ...minimal, OUTLIER_MIN_SECONDS: '600', OUTLIER_MAX_SECONDS: '5' }),
    ).toThrow(/OUTLIER_MIN_SECONDS/);
  });
});
