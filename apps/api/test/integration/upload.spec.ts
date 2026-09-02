import { createHash } from 'node:crypto';
import FormData from 'form-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { expectedDurationMs, synthesizeMp3 } from '../helpers/synthesize-mp3.js';

describe('POST /api/upload', () => {
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

  it('analyses a valid MP3 and stores it', async () => {
    // 1200 frames at 44.1 kHz is 31.35 s — comfortably inside the outlier window.
    const mp3 = synthesizeMp3({ frames: 1200 });
    const response = await harness.app.inject(uploadRequest(mp3, { filename: 'midnight.mp3' }));

    expect(response.statusCode).toBe(201);
    const body = response.json();

    expect(body.duplicate).toBe(false);
    expect(body.originalUploadId).toBeNull();
    expect(body.upload.filename).toBe('midnight.mp3');
    expect(body.upload.sizeBytes).toBe(mp3.length);

    // The hash is computed here independently of the service.
    expect(body.upload.contentHash).toBe(createHash('sha256').update(mp3).digest('hex'));

    expect(body.analysis.duration.seconds).toBeCloseTo(expectedDurationMs(1200, 44_100) / 1000, 1);
    expect(body.analysis.duration.formatted).toBe('00:31');
    expect(body.analysis.duration.isOutlier).toBe(false);
    expect(body.analysis.duration.outlierPolicy).toEqual({ minSeconds: 5, maxSeconds: 600 });

    expect(body.analysis.format).toMatchObject({
      bitrateBps: 128_000,
      sampleRateHz: 44_100,
      channels: 2,
      encodingMode: 'CBR',
    });

    expect(body.analysis.quality.score).toBeGreaterThanOrEqual(1);
    expect(body.analysis.quality.score).toBeLessThanOrEqual(10);
    expect(body.analysis.quality.basis).toBe('encoding');
    expect(body.analysis.quality.breakdown.total).toBeTypeOf('number');

    expect(response.headers['location']).toBe(`/api/uploads/${body.upload.id}`);

    // One row, one file, nothing left in the staging directory.
    expect(await harness.db.upload.count()).toBe(1);
    expect(await harness.storedFiles()).toHaveLength(1);
  });

  it('never returns the internal storage path', async () => {
    const response = await harness.app.inject(uploadRequest(synthesizeMp3({ frames: 1200 })));
    expect(response.body).not.toContain('storagePath');
    expect(response.body).not.toContain(harness.storageDir);
  });

  it('flags a very short file as a duration outlier', async () => {
    // 100 frames is 2.6 s, under the 5 s floor.
    const response = await harness.app.inject(uploadRequest(synthesizeMp3({ frames: 100 })));
    expect(response.statusCode).toBe(201);
    expect(response.json().analysis.duration.isOutlier).toBe(true);
  });

  it('flags a very long file as a duration outlier', async () => {
    // 25 000 frames is 653 s, over the 600 s ceiling.
    const response = await harness.app.inject(uploadRequest(synthesizeMp3({ frames: 25_000 })));
    expect(response.statusCode).toBe(201);
    expect(response.json().analysis.duration.isOutlier).toBe(true);
    expect(response.json().analysis.duration.formatted).toBe('10:53');
  });

  it('scores a better encoding higher than a worse one', async () => {
    const good = await harness.app.inject(
      uploadRequest(synthesizeMp3({ bitrateKbps: 320, sampleRate: 48_000, frames: 1200 })),
    );
    const poor = await harness.app.inject(
      uploadRequest(
        synthesizeMp3({ bitrateKbps: 64, sampleRate: 32_000, channels: 1, frames: 1200 }),
      ),
    );

    expect(good.json().analysis.quality.score).toBeGreaterThan(poor.json().analysis.quality.score);
  });

  it('reads past an ID3 tag', async () => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 1200, withId3: true })),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().analysis.format.bitrateBps).toBe(128_000);
  });

  it('accepts real MP3 bytes regardless of what the client calls them', async () => {
    // The filename and the Content-Type both lie. The content decides.
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 1200 }), {
        filename: 'resume.pdf',
        contentType: 'application/pdf',
      }),
    );
    expect(response.statusCode).toBe(201);
  });

  it('stores a filename stripped of any directory component', async () => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 1200 }), { filename: '../../etc/passwd.mp3' }),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().upload.filename).toBe('passwd.mp3');

    // And the path on disk came from the hash, not from any of that.
    const [stored] = await harness.storedFiles();
    expect(stored).toBe(
      `${response.json().upload.contentHash.slice(0, 2)}/` +
        `${response.json().upload.contentHash.slice(2, 4)}/` +
        `${response.json().upload.contentHash}.mp3`,
    );
  });
});

describe('POST /api/upload — rejections', () => {
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

  /** Nothing should reach the database or the disk on any rejection path. */
  async function expectNothingPersisted(): Promise<void> {
    expect(await harness.db.upload.count()).toBe(0);
    expect(await harness.storedFiles()).toHaveLength(0);
  }

  it('rejects a text file wearing an .mp3 name', async () => {
    const response = await harness.app.inject(
      uploadRequest(Buffer.from('this is definitely not audio'), { filename: 'song.mp3' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_AUDIO');
    expect(response.json().error.details.reason).toBe('magic_bytes');
    await expectNothingPersisted();
  });

  it('rejects a file that looks like an MP3 but is not one', async () => {
    // An ID3 header gets past the cheap magic-byte gate; the parser catches it.
    const fake = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from([3, 0, 0, 0, 0, 0, 10]),
      Buffer.alloc(10),
    ]);
    const response = await harness.app.inject(uploadRequest(fake));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_AUDIO');
    await expectNothingPersisted();
  });

  it('rejects a file too short to sniff', async () => {
    // Three bytes: this exercises the magic-byte gate, not truncation. It was
    // once named "rejects a truncated MP3", which is why a genuinely truncated
    // file went unnoticed through 100% coverage and a 92% mutation score.
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 1200 }).subarray(0, 3)),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_AUDIO');
    await expectNothingPersisted();
  });

  it('rejects a genuinely truncated MP3 — a readable header with no full frame', async () => {
    // 320 kbps at 48 kHz is a 960-byte frame. 400 bytes carries a valid header
    // and no decodable audio; it used to be accepted and scored 10 out of 10.
    const fragment = synthesizeMp3({ bitrateKbps: 320, sampleRate: 48_000, frames: 50 }).subarray(
      0,
      400,
    );
    const response = await harness.app.inject(uploadRequest(fragment, { filename: 'cut.mp3' }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_AUDIO');
    expect(response.json().error.details.reason).toBe('incomplete_frame');
    await expectNothingPersisted();
  });

  it('accepts a file of exactly one frame', async () => {
    // The boundary the rejection sits on: one complete frame is decodable.
    const oneFrame = synthesizeMp3({ bitrateKbps: 320, sampleRate: 48_000, frames: 1 });
    expect(oneFrame.length).toBe(960);

    const response = await harness.app.inject(uploadRequest(oneFrame, { filename: 'tiny.mp3' }));
    expect(response.statusCode).toBe(201);
    // Far under the 5 s floor, so it is stored and flagged rather than refused.
    expect(response.json().analysis.duration.isOutlier).toBe(true);
  });

  it('rejects an empty file', async () => {
    const response = await harness.app.inject(uploadRequest(Buffer.alloc(0)));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('EMPTY_FILE');
    await expectNothingPersisted();
  });

  it('rejects a multipart request carrying no file at all', async () => {
    const form = new FormData();
    form.append('title', 'a field, but no file');
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/upload',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('NO_FILE');
    await expectNothingPersisted();
  });

  it('names the field it expected when the file arrives under another one', async () => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 10 }), { field: 'audio' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('NO_FILE');
    expect(response.json().error.details).toEqual({
      expectedField: 'file',
      receivedField: 'audio',
    });
    await expectNothingPersisted();
  });

  it('rejects a request that is not multipart at all', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/upload',
      payload: { hello: 'world' },
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    await expectNothingPersisted();
  });
});

describe('POST /api/upload — size limit', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    // A small cap, so the test does not have to allocate 50 MB to prove a point.
    harness = await buildTestHarness({ MAX_UPLOAD_BYTES: 65_536 });
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.truncate();
  });

  it('rejects a file over the configured limit', async () => {
    // ~83 KB of valid MP3, against a 64 KiB cap.
    const response = await harness.app.inject(uploadRequest(synthesizeMp3({ frames: 200 })));

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('FILE_TOO_LARGE');
    expect(response.json().error.details.maxBytes).toBe(65_536);
    expect(await harness.db.upload.count()).toBe(0);
    expect(await harness.storedFiles()).toHaveLength(0);
  });

  it('still accepts a file under the limit', async () => {
    const response = await harness.app.inject(uploadRequest(synthesizeMp3({ frames: 50 })));
    expect(response.statusCode).toBe(201);
  });
});
