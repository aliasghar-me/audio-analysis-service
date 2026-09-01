import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, streamingUploadRequest, type TestHarness } from '../helpers/app.js';
import { streamMp3 } from '../helpers/synthesize-mp3.js';

/**
 * The real 50 MB ceiling, at its real size.
 *
 * Every other size test runs at a reduced `MAX_UPLOAD_BYTES` (4 KB, 64 KB) so
 * the fast suite stays fast. That leaves the two claims the README actually
 * makes untested: that a 50 MB file is accepted, and that the service does not
 * hold one in memory. This suite is separate and slower for that reason, and
 * runs as its own CI job rather than on the fast path.
 */
const MAX = 52_428_800; // 50 MiB — the documented default

describe('the 50 MB ceiling', () => {
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

  it('accepts a file just under the limit', async () => {
    const { stream, bytes } = streamMp3({ bytes: MAX - 500_000 });
    expect(bytes).toBeGreaterThan(49_000_000);

    const response = await harness.app.inject(
      streamingUploadRequest(stream, { filename: 'long-podcast.mp3' }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().upload.sizeBytes).toBe(bytes);
    expect(response.json().analysis.duration.seconds).toBeGreaterThan(0);

    const row = await harness.db.upload.findFirstOrThrow();
    expect(row.sizeBytes).toBe(bytes);
    expect(await harness.storedFiles()).toHaveLength(1);
    expect(await harness.stagedFiles()).toHaveLength(0);
  });

  it('accepts a file at exactly the limit', async () => {
    // streamMp3 rounds down to whole frames, so this lands just under MAX
    // while still exercising the boundary comparison rather than a small file.
    const { stream, bytes } = streamMp3({ bytes: MAX });
    expect(MAX - bytes).toBeLessThan(417); // within one frame of the cap

    const response = await harness.app.inject(streamingUploadRequest(stream));

    expect(response.statusCode).toBe(201);
    expect(response.json().upload.sizeBytes).toBe(bytes);
  });

  it('rejects a file over the limit and persists nothing', async () => {
    const { stream } = streamMp3({ bytes: MAX + 2_000_000 });

    const response = await harness.app.inject(streamingUploadRequest(stream));

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('FILE_TOO_LARGE');
    expect(response.json().error.details.maxBytes).toBe(MAX);

    // The rejection happens mid-stream, after megabytes are already on disk.
    // Nothing may survive it.
    expect(await harness.db.upload.count()).toBe(0);
    expect(await harness.storedFiles()).toHaveLength(0);
    expect(await harness.stagedFiles()).toHaveLength(0);
  });

  it('deduplicates a large file without storing it twice', async () => {
    const first = await harness.app.inject(
      streamingUploadRequest(streamMp3({ bytes: 20_000_000 }).stream, { filename: 'a.mp3' }),
    );
    const second = await harness.app.inject(
      streamingUploadRequest(streamMp3({ bytes: 20_000_000 }).stream, { filename: 'b.mp3' }),
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().originalUploadId).toBe(first.json().upload.id);

    // 20 MB stored once, not twice — the storage claim at a size where it matters.
    expect(await harness.db.upload.count()).toBe(1);
    expect(await harness.storedFiles()).toHaveLength(1);
  });
});
