import { describe, expect, it } from 'vitest';
import {
  mpegFrameBytes,
  readAudioFacts,
  resolveDurationMs,
  storableBitrate,
  toEncodingMode,
  toFacts,
} from './metadata.js';
import { readAudioFactsFromBuffer } from '../../test/helpers/audio.js';
import { frameSize } from '../../test/helpers/synthesize-mp3.js';
import type { IAudioMetadata } from 'music-metadata';
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

  it.each([
    [
      'MPEG-2 at 22.05 kHz',
      { sampleRate: 22_050 as const, bitrateKbps: 64 as const },
      22_050,
      64_000,
    ],
    ['MPEG-2 at 16 kHz', { sampleRate: 16_000 as const, bitrateKbps: 32 as const }, 16_000, 32_000],
    [
      'MPEG-2.5 at 11.025 kHz',
      { sampleRate: 11_025 as const, bitrateKbps: 32 as const },
      11_025,
      32_000,
    ],
    ['MPEG-2.5 at 8 kHz', { sampleRate: 8_000 as const, bitrateKbps: 16 as const }, 8_000, 16_000],
  ])('reads %s', async (_label, opts, sampleRateHz, bitrateBps) => {
    // These rates are unreachable on MPEG-1, and they are where the two lowest
    // sample-rate scoring tiers live.
    const facts = await readAudioFactsFromBuffer(synthesizeMp3({ ...opts, frames: 400 }));

    expect(facts.sampleRateHz).toBe(sampleRateHz);
    expect(facts.bitrateBps).toBe(bitrateBps);
    expect(facts.codec).toMatch(/Layer 3/);
    expect(facts.durationMs).toBeCloseTo(expectedDurationMs(400, sampleRateHz), 0);
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

/** A parse result with only the fields these helpers read. */
function meta(format: Record<string, unknown>): IAudioMetadata {
  return { format, common: {}, native: {}, quality: { warnings: [] } } as unknown as IAudioMetadata;
}

describe('toEncodingMode', () => {
  it.each([
    ['CBR', 'CBR'],
    ['VBR', 'VBR'],
    ['VBR-ish label', 'VBR'],
    ['V0', 'VBR'],
    ['V2', 'VBR'],
    ['V9', 'VBR'],
  ])('maps %s to %s', (profile, expected) => {
    expect(toEncodingMode(profile)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['an unrecognised label', 'ABR'],
    ['a lone V', 'V'],
    // The V-preset pattern is anchored: a V and a digit somewhere in the
    // middle of another label is not a LAME preset.
    ['a V-digit that is not a prefix', 'AV2'],
    ['a V-digit at the end', 'preset-V2x'.slice(0, 8) + 'V2'],
  ])('leaves %s null rather than guessing', (_label, profile) => {
    expect(toEncodingMode(profile)).toBeNull();
  });
});

describe('resolveDurationMs', () => {
  it('prefers the parser own duration, and marks it authoritative', () => {
    expect(
      resolveDurationMs(meta({ duration: 12.5, numberOfSamples: 999, sampleRate: 1 }), 0),
    ).toEqual({ durationMs: 12_500, estimated: false });
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a non-number', 'later' as unknown as number],
  ])('falls through when the duration is %s', (_label, duration) => {
    // Tier two: sample count over sample rate, still authoritative.
    expect(
      resolveDurationMs(meta({ duration, numberOfSamples: 44_100, sampleRate: 44_100 }), 0),
    ).toEqual({ durationMs: 1000, estimated: false });
  });

  it('falls back to a CBR estimate, and flags it as estimated', () => {
    // 16000 bytes at 128 kbps = 1 second. The flag is the point: this number
    // is derived from the size, so nothing may use it to judge the size.
    expect(resolveDurationMs(meta({ bitrate: 128_000 }), 16_000)).toEqual({
      durationMs: 1000,
      estimated: true,
    });
  });

  it.each([
    ['nothing at all', {}, 0],
    ['a bitrate but no bytes', { bitrate: 128_000 }, 0],
    ['bytes but no bitrate', {}, 16_000],
    ['a zero bitrate', { bitrate: 0 }, 16_000],
    ['a sample rate but no sample count', { sampleRate: 44_100 }, 0],
  ])('gives up on %s', (_label, format, sizeBytes) => {
    expect(resolveDurationMs(meta(format), sizeBytes)).toBeNull();
  });
});

describe('mpegFrameBytes', () => {
  it.each([
    ['MPEG-1 128 kbps / 44.1 kHz', 'MPEG 1 Layer 3', 128_000, 44_100, 417],
    ['MPEG-1 320 kbps / 48 kHz', 'MPEG 1 Layer 3', 320_000, 48_000, 960],
    ['MPEG-2 64 kbps / 22.05 kHz', 'MPEG 2 Layer 3', 64_000, 22_050, 208],
    ['MPEG-2.5 32 kbps / 11.025 kHz', 'MPEG 2.5 Layer 3', 32_000, 11_025, 208],
    // No space after MPEG: the version pattern allows it, and a parser that
    // spells the codec that way must not silently fall back to MPEG-2 sizing.
    ['a codec string with no space', 'MPEG1 Layer 3', 128_000, 44_100, 417],
  ])('%s -> %i bytes', (_label, codec, bitrate, rate, expected) => {
    expect(mpegFrameBytes(codec, bitrate, rate)).toBe(expected);
  });

  it('agrees with the frame size the test generator emits', () => {
    // If these two ever disagree, one of them is wrong and every audio
    // assertion built on the generator is suspect.
    for (const [codec, kbps, rate] of [
      ['MPEG 1 Layer 3', 128, 44_100],
      ['MPEG 1 Layer 3', 320, 48_000],
      ['MPEG 2 Layer 3', 64, 22_050],
      ['MPEG 2.5 Layer 3', 32, 11_025],
    ] as const) {
      expect(mpegFrameBytes(codec, kbps * 1000, rate)).toBe(frameSize(kbps, rate));
    }
  });

  it.each([
    ['no codec', undefined, 128_000, 44_100],
    ['an unparseable codec', 'Opus', 128_000, 44_100],
    ['no bitrate', 'MPEG 1 Layer 3', null, 44_100],
    ['no sample rate', 'MPEG 1 Layer 3', 128_000, null],
    ['a zero bitrate', 'MPEG 1 Layer 3', 0, 44_100],
    ['a zero sample rate', 'MPEG 1 Layer 3', 128_000, 0],
    ['a NaN bitrate', 'MPEG 1 Layer 3', Number.NaN, 44_100],
  ])('returns null given %s, so nothing is rejected for being unmeasurable', (_l, c, b, r) => {
    expect(mpegFrameBytes(c, b, r)).toBeNull();
  });
});

describe('toFacts', () => {
  const ok = { container: 'MPEG', codec: 'MPEG 1 Layer 3', duration: 2, bitrate: 128_000 };

  it('builds facts from a usable parse result', () => {
    // 100 frames' worth. A size below one frame is now rejected outright, and
    // 100 bytes of 128 kbps audio was never a realistic fixture.
    const facts = toFacts(
      meta({ ...ok, sampleRate: 44_100, numberOfChannels: 2, codecProfile: 'CBR' }),
      41_700,
    );
    expect(facts).toEqual({
      durationMs: 2000,
      durationIsEstimated: false,
      bitrateBps: 128_000,
      sampleRateHz: 44_100,
      channels: 2,
      codec: 'MPEG 1 Layer 3',
      encodingMode: 'CBR',
    });
  });

  it('nulls the optional fields the parser could not determine', () => {
    const facts = toFacts(meta(ok), 100);
    expect(facts.sampleRateHz).toBeNull();
    expect(facts.channels).toBeNull();
    expect(facts.encodingMode).toBeNull();
  });

  it('nulls an unreported bitrate rather than defaulting it to zero', () => {
    // Duration comes from the parser here, so the file is usable even though
    // no bitrate was reported. A zero would score as the worst possible file.
    const facts = toFacts(meta({ container: 'MPEG', codec: 'MPEG 1 Layer 3', duration: 2 }), 100);
    expect(facts.bitrateBps).toBeNull();
    expect(facts.durationMs).toBe(2000);
  });

  it.each([
    ['a non-MPEG container', { ...ok, container: 'WAVE' }, 'not_mpeg'],
    ['no container at all', { ...ok, container: undefined }, 'not_mpeg'],
    ['MPEG Layer I', { ...ok, codec: 'MPEG 1 Layer 1' }, 'not_layer_3'],
    ['MPEG Layer II', { ...ok, codec: 'MPEG 1 Layer 2' }, 'not_layer_3'],
    ['no codec', { ...ok, codec: undefined }, 'not_layer_3'],
    ['no resolvable duration', { container: 'MPEG', codec: 'MPEG 1 Layer 3' }, 'no_duration'],
    ['a zero duration', { container: 'MPEG', codec: 'MPEG 1 Layer 3', duration: 0 }, 'no_duration'],
  ])('rejects %s', (_label, format, reason) => {
    expect(() => toFacts(meta(format), 0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO' }),
    );
    try {
      toFacts(meta(format), 0);
    } catch (error) {
      expect((error as AppError).details).toEqual({ reason });
    }
  });
});

describe('toFacts and files too small to decode', () => {
  const header = {
    container: 'MPEG',
    codec: 'MPEG 1 Layer 3',
    bitrate: 320_000,
    sampleRate: 48_000,
  };

  it('rejects a file smaller than one frame', () => {
    // 320 kbps at 48 kHz is a 960-byte frame. 400 bytes is a readable header
    // and no decodable audio, and previously scored 10/10.
    expect(() => toFacts(meta(header), 400)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIO' }),
    );
    try {
      toFacts(meta(header), 400);
    } catch (error) {
      expect((error as AppError).details).toEqual({ reason: 'incomplete_frame' });
    }
  });

  it('accepts a file of exactly one frame', () => {
    expect(toFacts(meta(header), 960).durationMs).toBeGreaterThan(0);
  });

  it('marks a size-derived duration as estimated', () => {
    const facts = toFacts(meta(header), 96_000);
    expect(facts.durationIsEstimated).toBe(true);
  });

  it('does not reject a short file whose size cannot be measured', () => {
    // No bitrate means no frame size, and a file must never be rejected for
    // failing a measurement that could not be taken.
    const unmeasurable = { container: 'MPEG', codec: 'MPEG 1 Layer 3', duration: 2 };
    expect(toFacts(meta(unmeasurable), 10).durationMs).toBe(2000);
  });
});

describe('readAudioFacts', () => {
  it('reads a real file from disk', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'meta-'));
    const file = path.join(dir, 'a.mp3');
    const bytes = synthesizeMp3({ frames: 200 });
    await writeFile(file, bytes);

    const facts = await readAudioFacts(file, bytes.length);
    expect(facts.bitrateBps).toBe(128_000);
  });

  it('reports a file it cannot open as invalid audio, not as a crash', async () => {
    await expect(readAudioFacts('/nonexistent/definitely/not/here.mp3', 10)).rejects.toMatchObject({
      code: 'INVALID_AUDIO',
      details: { reason: 'parse_failed' },
    });
  });

  it('keeps the underlying failure as the error cause, for the log', () => {
    // The public message is deliberately generic; the real reason has to
    // survive somewhere, or a genuine filesystem problem becomes unloggable.
    return readAudioFacts('/nonexistent/definitely/not/here.mp3', 10).catch((error: AppError) => {
      expect(error.cause).toBeDefined();
      expect(String(error.cause)).toMatch(/ENOENT|no such file/i);
    });
  });
});

describe('storableBitrate', () => {
  it('rounds a fractional VBR average', () => {
    // The measured value from the committed LAME V2 fixture.
    expect(storableBitrate(96_227.979)).toBe(96_228);
  });

  it('leaves an integer CBR rate alone', () => {
    expect(storableBitrate(128_000)).toBe(128_000);
  });

  it('keeps an unknown bitrate null rather than inventing a zero', () => {
    expect(storableBitrate(null)).toBeNull();
  });
});
