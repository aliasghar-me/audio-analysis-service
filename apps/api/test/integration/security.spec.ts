import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

/**
 * The checks that stop a plausible-looking upload from being trusted.
 *
 * Every case here sends a file the client *claims* is an MP3. The service is
 * only allowed to believe the bytes.
 */
describe('content is what decides, never the name', () => {
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

  /** A structurally valid WAV — a real audio file that is simply not an MP3. */
  function wav(): Buffer {
    const data = Buffer.alloc(2000);
    const b = Buffer.alloc(44 + data.length);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + data.length, 4);
    b.write('WAVE', 8);
    b.write('fmt ', 12);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(44_100, 24);
    b.writeUInt32LE(88_200, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(data.length, 40);
    return b;
  }

  const pad = (head: number[] | string) =>
    Buffer.concat([Buffer.from(head as never), Buffer.alloc(300)]);

  it.each([
    ['a real WAV', wav()],
    ['FLAC', pad('fLaC')],
    ['Ogg', pad('OggS')],
    [
      'MP4 / M4A',
      Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(300)]),
    ],
    // ADTS AAC starts 0xFF 0xF1 / 0xFF 0xF9 — close enough to an MPEG frame
    // sync to matter, and rejected on the reserved layer bits.
    ['AAC ADTS (FF F1)', pad([0xff, 0xf1, 0x50, 0x80])],
    ['AAC ADTS (FF F9)', pad([0xff, 0xf9, 0x50, 0x80])],
    ['JPEG', pad([0xff, 0xd8, 0xff, 0xe0])],
    ['PNG', pad([0x89, 0x50, 0x4e, 0x47])],
    ['PDF', pad('%PDF-1.7')],
    ['an ELF executable', pad([0x7f, 0x45, 0x4c, 0x46])],
    ['WebM / Matroska', pad([0x1a, 0x45, 0xdf, 0xa3])],
    ['random binary', Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 37 + 11) % 256))],
  ])('rejects %s renamed to .mp3', async (_label, body) => {
    const response = await harness.app.inject(
      uploadRequest(body, { filename: 'song.mp3', contentType: 'audio/mpeg' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_AUDIO');
    expect(await harness.db.upload.count()).toBe(0);
    expect(await harness.storedFiles()).toHaveLength(0);
    expect(await harness.stagedFiles()).toHaveLength(0);
  });
});

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

describe('responses leak nothing internal', () => {
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

  const secrets = (h: TestHarness) => [
    'storagePath',
    'storage_path',
    h.storageDir,
    'postgresql://',
    'password',
    'node_modules',
    'Error:',
    '    at ',
  ];

  it('does not expose internals on success', async () => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 240 }), { filename: 'ok.mp3' }),
    );

    expect(response.statusCode).toBe(201);
    for (const secret of secrets(harness)) {
      expect(response.body, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('does not expose a stack trace or a path when the parser rejects a file', async () => {
    const response = await harness.app.inject(
      uploadRequest(Buffer.from('this is definitely not audio'), { filename: 'x.mp3' }),
    );

    expect(response.statusCode).toBe(400);
    for (const secret of secrets(harness)) {
      expect(response.body, `leaked ${secret}`).not.toContain(secret);
    }
    // The public message stays generic; the parser's own message goes to the
    // log via `cause` and never to the client.
    expect(response.json().error.message).toBe('The uploaded file is not a valid MP3 audio file.');
  });
});
