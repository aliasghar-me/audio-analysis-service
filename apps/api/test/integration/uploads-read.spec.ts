import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

describe('reading uploads back', () => {
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

  async function seed(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const response = await harness.app.inject(
        uploadRequest(synthesizeMp3({ frames: 1200 + i }), { filename: `track-${i}.mp3` }),
      );
      expect(response.statusCode).toBe(201);
      ids.push(response.json().upload.id);
    }
    return ids;
  }

  it('lists uploads newest first', async () => {
    const ids = await seed(3);
    const response = await harness.app.inject({ method: 'GET', url: '/api/uploads' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { upload: { id: string } }) => item.upload.id)).toEqual(
      [...ids].reverse(),
    );
    expect(body.nextCursor).toBeNull();
  });

  it('paginates by keyset without overlap', async () => {
    const ids = await seed(3);

    const page1 = await harness.app.inject({ method: 'GET', url: '/api/uploads?limit=2' });
    const body1 = page1.json();
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await harness.app.inject({
      method: 'GET',
      url: `/api/uploads?limit=2&cursor=${body1.nextCursor}`,
    });
    const body2 = page2.json();

    expect(body2.items).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();

    const seen = [...body1.items, ...body2.items].map(
      (item: { upload: { id: string } }) => item.upload.id,
    );
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual([...ids].reverse());
  });

  it('rejects a nonsense limit', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/uploads?limit=500' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns one upload by id', async () => {
    const [id] = await seed(1);
    const response = await harness.app.inject({ method: 'GET', url: `/api/uploads/${id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().upload.id).toBe(id);
    expect(response.json().analysis.quality.basis).toBe('encoding');
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/uploads/0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('UPLOAD_NOT_FOUND');

    const malformed = await harness.app.inject({ method: 'GET', url: '/api/uploads/not-a-uuid' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('serves the stored bytes back unchanged', async () => {
    const mp3 = synthesizeMp3({ frames: 1200 });
    const created = await harness.app.inject(uploadRequest(mp3, { filename: 'midnight.mp3' }));
    const { id, contentHash } = created.json().upload;

    const response = await harness.app.inject({ method: 'GET', url: `/api/uploads/${id}/file` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.headers['etag']).toBe(`"${contentHash}"`);
    expect(response.headers['content-disposition']).toContain('midnight.mp3');

    // Round-trip fidelity: what comes out hashes to what went in.
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(contentHash);
  });

  it('reports a missing file as gone, not as missing metadata', async () => {
    const created = await harness.app.inject(uploadRequest(synthesizeMp3({ frames: 1200 })));
    const { id, contentHash } = created.json().upload;

    await rm(
      path.join(
        harness.storageDir,
        'audio',
        contentHash.slice(0, 2),
        contentHash.slice(2, 4),
        `${contentHash}.mp3`,
      ),
    );

    const file = await harness.app.inject({ method: 'GET', url: `/api/uploads/${id}/file` });
    expect(file.statusCode).toBe(410);
    expect(file.json().error.code).toBe('FILE_GONE');

    // The metadata endpoint still works: the analysis lives in the row and is
    // never recomputed from the bytes.
    const metadata = await harness.app.inject({ method: 'GET', url: `/api/uploads/${id}` });
    expect(metadata.statusCode).toBe(200);
  });

  it('reports health with the database attached', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'up' });
  });
});
