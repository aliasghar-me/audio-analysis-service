import { describe, expect, it } from 'vitest';
import { readAudioFactsFromBuffer } from './metadata.js';
import { AppError } from '../http/errors.js';
import { expectedDurationMs, synthesizeMp3 } from '../../test/helpers/synthesize-mp3.js';

describe('readAudioFactsFromBuffer', () => {
  it('reads the header of a 128 kbps / 44.1 kHz / stereo file', async () => {
    const facts = await readAudioFactsFromBuffer(synthesizeMp3({ frames: 1200 }));

    expect(facts.bitrateBps).toBe(128_000);
    expect(facts.sampleRateHz).toBe(44_100);
    expect(facts.channels).toBe(2);
    expect(facts.codec).toMatch(/Layer 3/);
    expect(facts.encodingMode).toBe('CBR');
    expect(facts.durationMs).toBeCloseTo(expectedDurationMs(1200, 44_100), 3);
  });

  it('reads a 320 kbps / 48 kHz / mono file', async () => {
    const facts = await readAudioFactsFromBuffer(
      synthesizeMp3({ bitrateKbps: 320, sampleRate: 48_000, channels: 1, frames: 300 }),
    );

    expect(facts.bitrateBps).toBe(320_000);
    expect(facts.sampleRateHz).toBe(48_000);
    expect(facts.channels).toBe(1);
    expect(facts.durationMs).toBeCloseTo(expectedDurationMs(300, 48_000), 3);
  });

  it('sees past an ID3v2 tag to the frames behind it', async () => {
    const facts = await readAudioFactsFromBuffer(synthesizeMp3({ frames: 100, withId3: true }));
    expect(facts.durationMs).toBeCloseTo(expectedDurationMs(100, 44_100), 3);
  });

  it.each([
    ['plain text', () => Buffer.from('this is definitely not audio at all')],
    ['an empty buffer', () => Buffer.alloc(0)],
    // An ID3 header passes the cheap magic-byte gate; this is the step that
    // actually rejects it.
    [
      'an ID3 header with nothing behind it',
      () =>
        Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10)]),
    ],
    ['a truncated frame header', () => Buffer.from([0xff, 0xfb])],
  ])('rejects %s as INVALID_AUDIO', async (_label, build) => {
    await expect(readAudioFactsFromBuffer(build())).rejects.toMatchObject({
      code: 'INVALID_AUDIO',
    });
    await expect(readAudioFactsFromBuffer(build())).rejects.toBeInstanceOf(AppError);
  });

  it('does not leak the parser message to the client', async () => {
    const error = await readAudioFactsFromBuffer(Buffer.from('nope')).catch((e: AppError) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toBe('The uploaded file is not a valid MP3 audio file.');
  });
});
