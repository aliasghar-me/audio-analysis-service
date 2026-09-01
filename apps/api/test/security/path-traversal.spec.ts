import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

/**
 * P0: nothing a client sends may influence where bytes land on disk.
 */

describe('filenames cannot influence where bytes land', () => {
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

  it.each([
    ['posix traversal', '../../etc/passwd.mp3', 'passwd.mp3'],
    ['deep traversal', '../../../../../../etc/shadow.mp3', 'shadow.mp3'],
    ['windows traversal', '..\\..\\windows\\system32.mp3', 'system32.mp3'],
    ['an absolute path', '/etc/passwd.mp3', 'passwd.mp3'],
    ['a nested path', 'dir/sub/track.mp3', 'track.mp3'],
  ])('reduces %s to a bare basename', async (_label, filename, expected) => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 200 }), { filename }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().upload.filename).toBe(expected);

    // The stored path is derived from the hash alone, so nothing the client
    // sent can steer it.
    const stored = await harness.storedFiles();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain('..');
    expect(path.isAbsolute(stored[0]!)).toBe(false);
    expect(stored[0]).toBe(
      path.join(
        response.json().upload.contentHash.slice(0, 2),
        response.json().upload.contentHash.slice(2, 4),
        `${response.json().upload.contentHash}.mp3`,
      ),
    );
  });

  it.each([
    ['accented latin', 'chanson-café.mp3'],
    ['arabic', 'أغنية.mp3'],
    ['chinese', '歌曲.mp3'],
    ['emoji', '🎵🔥.mp3'],
    ['an apostrophe', "it's.mp3"],
    ['an ampersand', 'a&b.mp3'],
    ['a hash', 'a#b.mp3'],
    ['a percent sequence', 'a%20b.mp3'],
    ['a question mark', 'a?b.mp3'],
    ['no extension at all', 'recording'],
  ])('stores %s unchanged', async (_label, filename) => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 210 }), { filename }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().upload.filename).toBe(filename);
  });

  it.each([
    ['a SQL injection attempt', "'; DROP TABLE uploads;--.mp3"],
    ['a shell substitution', 'a$(id).mp3'],
    ['backticks', 'a`whoami`.mp3'],
    ['a pipe', 'a|b.mp3'],
  ])('stores %s literally, and the table survives', async (_label, filename) => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 220 }), { filename }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().upload.filename).toBe(filename);
    // Nothing is ever interpolated into SQL or handed to a shell — there is no
    // shell in this service at all, which is one of the quieter benefits of
    // parsing MP3 headers in-process instead of spawning ffprobe.
    expect(await harness.db.upload.count()).toBe(1);
  });

  it('clamps an absurdly long filename to 255 characters', async () => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 230 }), { filename: `${'a'.repeat(400)}.mp3` }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().upload.filename).toHaveLength(255);
  });
});
