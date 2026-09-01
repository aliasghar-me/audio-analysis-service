import { describe, expect, it } from 'vitest';
import { AppError, ERROR_STATUS, isUniqueViolation } from './errors.js';

describe('AppError', () => {
  it.each([
    ['UNSUPPORTED_MEDIA_TYPE', 415],
    ['NO_FILE', 400],
    ['EMPTY_FILE', 400],
    ['INVALID_AUDIO', 400],
    ['FILE_TOO_LARGE', 413],
    ['VALIDATION_ERROR', 400],
    ['UPLOAD_NOT_FOUND', 404],
    ['FILE_GONE', 410],
    ['INTERNAL_ERROR', 500],
  ] as const)('%s maps to %i', (code, status) => {
    expect(ERROR_STATUS[code]).toBe(status);
    expect(new AppError(code, 'x').statusCode).toBe(status);
  });

  it('serialises to the documented envelope', () => {
    const error = new AppError('INVALID_AUDIO', 'File is not readable as MP3 audio', {
      reason: 'parse_failed',
    });
    expect(error.toEnvelope()).toEqual({
      error: {
        code: 'INVALID_AUDIO',
        message: 'File is not readable as MP3 audio',
        details: { reason: 'parse_failed' },
      },
    });
  });

  it('omits `details` entirely when there are none', () => {
    const envelope = new AppError('NO_FILE', 'No file was uploaded').toEnvelope();
    expect(envelope.error).not.toHaveProperty('details');
  });

  it('keeps the underlying cause for the log without exposing it', () => {
    const cause = new Error('ENOENT: /var/secrets/thing');
    const error = new AppError('INTERNAL_ERROR', 'Something went wrong', undefined, { cause });
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toEnvelope())).not.toContain('/var/secrets');
  });
});

describe('isUniqueViolation', () => {
  it('recognises Prisma P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it('matches on the constrained field when one is named', () => {
    expect(
      isUniqueViolation({ code: 'P2002', meta: { target: ['contentHash'] } }, 'contentHash'),
    ).toBe(true);
    expect(isUniqueViolation({ code: 'P2002', meta: { target: ['id'] } }, 'contentHash')).toBe(
      false,
    );
  });

  it.each([
    ['a different Prisma error', { code: 'P2003' }],
    ['a plain Error', new Error('boom')],
    ['null', null],
    ['a string', 'P2002'],
  ])('rejects %s', (_label, value) => {
    expect(isUniqueViolation(value)).toBe(false);
  });
});
