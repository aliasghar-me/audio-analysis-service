import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { readRealMp3, REAL_MP3 } from '../fixtures/index.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

/**
 * The upload flow against a real LAME encode rather than hand-built frames.
 *
 * The synthetic generator covers the shape of the pipeline; this covers the
 * things only a file produced by an actual encoder has — a VBR stream, a
 * fractional average bitrate, and an ID3v2.3 tag written by a real tagger.
 */
describe('uploading a real CC0 MP3', () => {
  let harness: TestHarness;
  const mp3 = readRealMp3();

  beforeAll(async () => {
    harness = await buildTestHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.truncate();
  });

  it('analyses and stores it', async () => {
    const response = await harness.app.inject(uploadRequest(mp3, { filename: REAL_MP3.filename }));

    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.upload.sizeBytes).toBe(REAL_MP3.sizeBytes);
    expect(body.upload.contentHash).toBe(REAL_MP3.sha256);

    expect(body.analysis.duration.formatted).toBe('00:19');
    expect(body.analysis.duration.isOutlier).toBe(false);

    expect(body.analysis.format).toMatchObject({
      codec: REAL_MP3.expected.codec,
      sampleRateHz: REAL_MP3.expected.sampleRateHz,
      channels: REAL_MP3.expected.channels,
      encodingMode: 'VBR',
    });

    expect(body.analysis.quality.score).toBe(7);
  });

  it('stores the VBR average bitrate as a rounded integer', async () => {
    // The parsed value is 96227.979… — the column is an integer. This asserts
    // the service rounds it deliberately rather than leaving the database
    // driver to truncate it as a side effect.
    const response = await harness.app.inject(uploadRequest(mp3));
    const returned = response.json().analysis.format.bitrateBps;

    expect(returned).toBe(Math.round(REAL_MP3.expected.bitrateBps));
    expect(Number.isInteger(returned)).toBe(true);

    const row = await harness.db.upload.findFirstOrThrow();
    expect(row.bitrateBps).toBe(returned);
  });

  it('serves the real bytes back unchanged', async () => {
    const created = await harness.app.inject(uploadRequest(mp3));
    const { id } = created.json().upload;

    const file = await harness.app.inject({ method: 'GET', url: `/api/uploads/${id}/file` });

    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.length).toBe(REAL_MP3.sizeBytes);
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(REAL_MP3.sha256);
  });

  it('detects it as a duplicate under a different name, like any other file', async () => {
    const first = await harness.app.inject(uploadRequest(mp3, { filename: 'interview.mp3' }));
    const second = await harness.app.inject(uploadRequest(mp3, { filename: 'INTERVIEW copy.MP3' }));

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().originalUploadId).toBe(first.json().upload.id);
    expect(await harness.db.upload.count()).toBe(1);
    expect(await harness.storedFiles()).toHaveLength(1);
  });

  it('is not confused with a synthetic file of the same nominal parameters', async () => {
    // Same sample rate and channel count, different bytes: two uploads, and the
    // real one is correctly identified as VBR while the synthetic one is CBR.
    const real = await harness.app.inject(uploadRequest(mp3));
    const fake = await harness.app.inject(
      uploadRequest(synthesizeMp3({ sampleRate: 48_000, channels: 1, frames: 800 })),
    );

    expect(real.json().analysis.format.encodingMode).toBe('VBR');
    expect(fake.json().analysis.format.encodingMode).toBe('CBR');
    expect(await harness.db.upload.count()).toBe(2);
  });
});
