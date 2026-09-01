import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

describe('duplicate detection', () => {
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

  it('detects the same bytes under a completely different name', async () => {
    const mp3 = synthesizeMp3({ frames: 1200 });

    const first = await harness.app.inject(uploadRequest(mp3, { filename: 'midnight-drive.mp3' }));
    expect(first.statusCode).toBe(201);

    const second = await harness.app.inject(
      uploadRequest(mp3, {
        filename: 'Copy of MIDNIGHT DRIVE (2).MP3',
        contentType: 'application/octet-stream',
      }),
    );

    // Not 201: nothing was created. Not 409: this is a success, and the body
    // carries the full analysis.
    expect(second.statusCode).toBe(200);

    const body = second.json();
    expect(body.duplicate).toBe(true);
    expect(body.originalUploadId).toBe(first.json().upload.id);
    expect(body.upload.id).toBe(first.json().upload.id);
    // The original name is what is on record; the submitted one is echoed back.
    // This pair of fields is the requirement "filenames must not matter", made
    // visible in a single response body.
    expect(body.upload.filename).toBe('midnight-drive.mp3');
    expect(body.submittedFilename).toBe('Copy of MIDNIGHT DRIVE (2).MP3');
    expect(body.upload.duplicateCount).toBe(1);

    // The stored analysis is returned verbatim, not recomputed.
    expect(body.analysis).toEqual(first.json().analysis);

    // And crucially: one row, one file.
    expect(await harness.db.upload.count()).toBe(1);
    expect(await harness.storedFiles()).toHaveLength(1);
  });

  it('keeps exactly one copy no matter how many times it is uploaded', async () => {
    const mp3 = synthesizeMp3({ frames: 1200 });

    for (let i = 0; i < 5; i += 1) {
      await harness.app.inject(uploadRequest(mp3, { filename: `take-${i}.mp3` }));
    }

    expect(await harness.db.upload.count()).toBe(1);
    expect(await harness.storedFiles()).toHaveLength(1);

    const row = await harness.db.upload.findFirstOrThrow();
    expect(row.duplicateCount).toBe(4);
    expect(row.originalName).toBe('take-0.mp3');
  });

  it.each([
    ['the same name again', 'midnight-drive.mp3', 'audio/mpeg'],
    ['a different case', 'MIDNIGHT-DRIVE.MP3', 'audio/mpeg'],
    ['a unicode name', '歌曲-副本.mp3', 'audio/mpeg'],
    ['an emoji name', '🎵.mp3', 'audio/mpeg'],
    ['a different declared type', 'blob.bin', 'application/octet-stream'],
  ])('detects the same bytes submitted under %s', async (_label, filename, contentType) => {
    const mp3 = synthesizeMp3({ frames: 900 });
    const first = await harness.app.inject(uploadRequest(mp3, { filename: 'midnight-drive.mp3' }));
    expect(first.statusCode).toBe(201);

    const second = await harness.app.inject(uploadRequest(mp3, { filename, contentType }));

    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().originalUploadId).toBe(first.json().upload.id);
    expect(await harness.db.upload.count()).toBe(1);
    expect(await harness.storedFiles()).toHaveLength(1);
  });

  it('treats different content under the same filename as two uploads', async () => {
    const name = 'track.mp3';
    const a = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 1200 }), { filename: name }),
    );
    const b = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 1201 }), { filename: name }),
    );

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().upload.id).not.toBe(a.json().upload.id);
    expect(await harness.db.upload.count()).toBe(2);
    expect(await harness.storedFiles()).toHaveLength(2);
  });

  it('does not treat a near-identical re-encode as a duplicate', async () => {
    // Same audio content, different encoding parameters: byte-different, and
    // therefore correctly not a duplicate under an exact-match rule.
    const a = await harness.app.inject(
      uploadRequest(synthesizeMp3({ bitrateKbps: 128, frames: 1200 })),
    );
    const b = await harness.app.inject(
      uploadRequest(synthesizeMp3({ bitrateKbps: 192, frames: 1200 })),
    );

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(await harness.db.upload.count()).toBe(2);
  });

  it('survives concurrent uploads of identical bytes', async () => {
    const mp3 = synthesizeMp3({ frames: 1200 });

    // All ten race past the findUnique fast path. The unique constraint on
    // contentHash — not that lookup — is what makes this safe, and this is the
    // test that proves it.
    const CONCURRENCY = 10;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        harness.app.inject(uploadRequest(mp3, { filename: `racer-${i}.mp3` })),
      ),
    );

    const created = responses.filter((r) => r.statusCode === 201);
    const duplicates = responses.filter((r) => r.statusCode === 200);

    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(CONCURRENCY - 1);
    // Never a 500: a lost race is an expected outcome, not a server fault.
    expect(responses.filter((r) => r.statusCode >= 500)).toHaveLength(0);

    const ids = new Set(responses.map((r) => r.json().upload.id));
    expect(ids.size).toBe(1);

    expect(await harness.db.upload.count()).toBe(1);
    expect(await harness.storedFiles()).toHaveLength(1);

    const row = await harness.db.upload.findFirstOrThrow();
    expect(row.duplicateCount).toBe(CONCURRENCY - 1);
  });
});
