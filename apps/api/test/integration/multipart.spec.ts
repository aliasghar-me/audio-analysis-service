import FormData from 'form-data';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

/**
 * The multipart layer's edge cases.
 *
 * Several of these exist because busboy's limits do not all fail the same way:
 * `fileSize` ends the stream and sets `truncated`, but a `files` cap trips
 * *while an earlier file stream is still open* and simply stops parsing — the
 * stream never emits `end`, the handler never returns, and the request hangs
 * with no response at all. A hang is worse than any status code, so the
 * "responds at all" assertions below are the point, not decoration.
 */
describe('multipart handling', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildTestHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.truncate();
  });

  /** Fail fast and loudly rather than letting a hang burn the suite timeout. */
  async function inject(options: InjectOptions): Promise<LightMyRequestResponse> {
    const result = await Promise.race([
      harness.app.inject(options),
      new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 5_000)),
    ]);
    expect(result, 'request never produced a response (hang)').not.toBe('TIMEOUT');
    return result as LightMyRequestResponse;
  }

  function multipart(parts: {
    files?: Array<{ field?: string; name?: string; body?: Buffer }>;
    fields?: number;
  }) {
    const form = new FormData();
    for (let i = 0; i < (parts.fields ?? 0); i += 1) form.append(`extra${i}`, 'value');
    for (const [i, file] of (parts.files ?? []).entries()) {
      form.append(file.field ?? 'file', file.body ?? synthesizeMp3({ frames: 60 + i }), {
        filename: file.name ?? `track-${i}.mp3`,
        contentType: 'audio/mpeg',
      });
    }
    return {
      method: 'POST',
      url: '/api/upload',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    } satisfies InjectOptions;
  }

  describe('content type', () => {
    it('rejects a request with no Content-Type as unsupported media, not a server error', async () => {
      // Fastify raises FST_ERR_CTP_INVALID_MEDIA_TYPE, which already carries
      // statusCode 415. Flattening it to 500 would claim our own bug.
      const response = await inject({ method: 'POST', url: '/api/upload', payload: 'raw bytes' });

      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects a malformed JSON body as a client error, not a server error', async () => {
      const response = await inject({
        method: 'POST',
        url: '/api/upload',
        payload: '{not json',
        headers: { 'content-type': 'application/json' },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    });

    it('rejects text/plain as unsupported media', async () => {
      const response = await inject({
        method: 'POST',
        url: '/api/upload',
        payload: 'hello',
        headers: { 'content-type': 'text/plain' },
      });

      expect(response.statusCode).toBe(415);
      expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });
  });

  describe('number of files', () => {
    it('rejects two file parts instead of hanging', async () => {
      const response = await inject(multipart({ files: [{}, {}] }));

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('TOO_MANY_FILES');
      expect(await harness.db.upload.count()).toBe(0);
      expect(await harness.storedFiles()).toHaveLength(0);
      // The first file was staged before the second one was seen. If it is
      // still in tmp/, every rejected multi-file upload leaks a temp file.
      expect(await harness.stagedFiles()).toHaveLength(0);
    });

    it('rejects many file parts instead of hanging', async () => {
      const response = await inject(multipart({ files: Array.from({ length: 20 }, () => ({})) }));

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('TOO_MANY_FILES');
      expect(await harness.db.upload.count()).toBe(0);
      expect(await harness.stagedFiles()).toHaveLength(0);
    });

    it('accepts exactly one file part', async () => {
      const response = await inject(multipart({ files: [{}] }));
      expect(response.statusCode).toBe(201);
    });
  });

  describe('non-file fields', () => {
    it('ignores unexpected fields that arrive before the file', async () => {
      const response = await inject(multipart({ fields: 3, files: [{}] }));
      expect(response.statusCode).toBe(201);
    });

    it('responds to a flood of fields rather than hanging', async () => {
      const response = await inject(multipart({ fields: 40, files: [{}] }));

      // The exact code matters less than: it answers, it is a 4xx, and it is
      // not a 500 claiming the server broke.
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
      expect(await harness.db.upload.count()).toBe(0);
    });
  });

  describe('methods and unknown routes', () => {
    it.each(['GET', 'PUT', 'DELETE', 'PATCH'] as const)(
      '%s /api/upload is refused without pretending an upload was not found',
      async (method) => {
        const response = await inject({ method, url: '/api/upload' });

        expect(response.statusCode).toBe(404);
        // UPLOAD_NOT_FOUND means "no upload with that id". No id was looked up
        // here, so reusing it would mislead a client into retrying with a
        // different id.
        expect(response.json().error.code).toBe('ROUTE_NOT_FOUND');
      },
    );

    it('still reports a genuinely missing upload as UPLOAD_NOT_FOUND', async () => {
      const response = await inject({
        method: 'GET',
        url: '/api/uploads/0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('UPLOAD_NOT_FOUND');
    });
  });

  describe('size boundaries', () => {
    it('rejects a 1-byte file', async () => {
      const response = await inject(uploadRequest(Buffer.from([0xff])));

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_AUDIO');
      expect(await harness.db.upload.count()).toBe(0);
      expect(await harness.stagedFiles()).toHaveLength(0);
    });

    it('accepts a file exactly at the configured limit', async () => {
      // 10 frames at 128 kbps / 44.1 kHz is exactly 4170 bytes.
      const exact = synthesizeMp3({ frames: 10 });
      expect(exact.length).toBe(4170);

      const bounded = await buildTestHarness({ MAX_UPLOAD_BYTES: exact.length });
      try {
        await bounded.truncate();
        const response = await bounded.app.inject(uploadRequest(exact));
        expect(response.statusCode).toBe(201);
      } finally {
        await bounded.close();
      }
    });

    it('rejects a file one byte over the limit', async () => {
      const exact = synthesizeMp3({ frames: 10 });
      const bounded = await buildTestHarness({ MAX_UPLOAD_BYTES: exact.length - 1 });
      try {
        await bounded.truncate();
        const response = await bounded.app.inject(uploadRequest(exact));
        expect(response.statusCode).toBe(413);
        expect(response.json().error.code).toBe('FILE_TOO_LARGE');
        expect(await bounded.db.upload.count()).toBe(0);
        expect(await bounded.storedFiles()).toHaveLength(0);
      } finally {
        await bounded.close();
      }
    });
  });
});
