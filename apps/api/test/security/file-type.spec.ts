import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';

/**
 * P0: the file must be an MP3 because its bytes say so, never because its name
 * or its declared Content-Type says so.
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
