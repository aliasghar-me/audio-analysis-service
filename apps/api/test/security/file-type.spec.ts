import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

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

describe('MPEG-2 and MPEG-2.5 are accepted end to end', () => {
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
    ['MPEG-2 at 22.05 kHz', { sampleRate: 22_050 as const, bitrateKbps: 64 as const }, 22_050],
    ['MPEG-2 at 16 kHz', { sampleRate: 16_000 as const, bitrateKbps: 32 as const }, 16_000],
    ['MPEG-2.5 at 11.025 kHz', { sampleRate: 11_025 as const, bitrateKbps: 32 as const }, 11_025],
    ['MPEG-2.5 at 8 kHz', { sampleRate: 8_000 as const, bitrateKbps: 16 as const }, 8_000],
  ])('accepts %s and scores it', async (_label, opts, sampleRateHz) => {
    // The sniffer accepts the 0xF3 / 0xE3 version bits in isolation; this is
    // the proof that a whole file at those rates survives the real pipeline.
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ ...opts, frames: 800 }), { filename: 'lowrate.mp3' }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().analysis.format.sampleRateHz).toBe(sampleRateHz);
    expect(response.json().analysis.quality.score).toBeGreaterThanOrEqual(1);
    expect(await harness.db.upload.count()).toBe(1);
  });

  it('scores the low sample-rate tiers below CD quality, through a real parse', async () => {
    const scoreOf = async (opts: Parameters<typeof synthesizeMp3>[0]) => {
      await harness.truncate();
      const r = await harness.app.inject(uploadRequest(synthesizeMp3({ ...opts, frames: 800 })));
      return r.json().analysis.quality.breakdown.sampleRate as number;
    };

    // These two tiers were previously reachable only by passing numbers
    // straight to the scoring function; no real file had ever produced them.
    expect(await scoreOf({ sampleRate: 44_100 })).toBe(2.5);
    expect(await scoreOf({ sampleRate: 32_000 })).toBe(1.5);
    expect(await scoreOf({ sampleRate: 22_050, bitrateKbps: 64 })).toBe(1);
    expect(await scoreOf({ sampleRate: 11_025, bitrateKbps: 32 })).toBe(0.5);
  });
});
