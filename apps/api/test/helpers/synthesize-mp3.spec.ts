import { describe, expect, it } from 'vitest';
import {
  expectedDurationMs,
  frameSize,
  samplesPerFrame,
  streamMp3,
  synthesizeMp3,
  versionForSampleRate,
} from './synthesize-mp3.js';

/**
 * The generator is test infrastructure, so it gets tested itself: if the frame
 * headers are wrong, every audio assertion downstream is meaningless.
 */
describe('synthesizeMp3', () => {
  it('emits the documented header for 128 kbps / 44.1 kHz / stereo', () => {
    const mp3 = synthesizeMp3({ frames: 1 });
    // FF FB = sync, MPEG-1, Layer III, no CRC.  90 = bitrate index 9 (128 kbps),
    // sample-rate index 0 (44.1 kHz), no padding.  00 = stereo, no flags.
    expect([...mp3.subarray(0, 4)]).toEqual([0xff, 0xfb, 0x90, 0x00]);
  });

  it('emits the documented header for 320 kbps / 48 kHz / mono', () => {
    const mp3 = synthesizeMp3({ bitrateKbps: 320, sampleRate: 48_000, channels: 1, frames: 1 });
    // E4 = bitrate index 14 (320 kbps), sample-rate index 1 (48 kHz).
    // C0 = channel mode 11 (mono).
    expect([...mp3.subarray(0, 4)]).toEqual([0xff, 0xfb, 0xe4, 0xc0]);
  });

  it('computes frame size as floor(144 * bitrate / sampleRate) + padding', () => {
    expect(frameSize(128, 44_100)).toBe(417);
    expect(frameSize(128, 44_100, true)).toBe(418);
    expect(frameSize(320, 48_000)).toBe(960);
  });

  it('produces exactly frames * frameSize bytes', () => {
    expect(synthesizeMp3({ frames: 50 }).length).toBe(50 * 417);
    expect(synthesizeMp3({ bitrateKbps: 320, sampleRate: 48_000, frames: 7 }).length).toBe(7 * 960);
  });

  it('starts every frame on a sync byte', () => {
    const frames = 20;
    const mp3 = synthesizeMp3({ frames });
    for (let i = 0; i < frames; i += 1) {
      expect(mp3[i * 417]).toBe(0xff);
    }
  });

  it('prefixes a syncsafe ID3v2 tag on request', () => {
    const withTag = synthesizeMp3({ frames: 1, withId3: true });
    expect(withTag.subarray(0, 3).toString('latin1')).toBe('ID3');
    // 10-byte header + 128-byte payload, then the audio.
    expect(withTag.length).toBe(10 + 128 + 417);
    for (const byte of withTag.subarray(6, 10)) {
      expect(byte).toBeLessThan(0x80); // syncsafe: never looks like a frame sync
    }
  });

  it('derives duration from the frame count at 1152 samples per frame', () => {
    expect(expectedDurationMs(1200, 44_100)).toBeCloseTo(31_346.94, 1);
    expect(expectedDurationMs(300, 48_000)).toBe(7_200);
  });

  it('refuses a bitrate MPEG-1 Layer III cannot express', () => {
    // @ts-expect-error deliberately outside the allowed union
    expect(() => synthesizeMp3({ bitrateKbps: 123 })).toThrow(/not valid for MPEG-1 Layer III/);
  });

  describe('MPEG-2 and MPEG-2.5', () => {
    it('emits the documented header for MPEG-2 at 22.05 kHz', () => {
      const mp3 = synthesizeMp3({ sampleRate: 22_050, bitrateKbps: 64, frames: 1 });
      // F3 = sync, version 10 (MPEG-2), layer 01, no CRC.
      // 80 = bitrate index 8 (64 kbps in the MPEG-2 table), rate index 0.
      expect([...mp3.subarray(0, 4)]).toEqual([0xff, 0xf3, 0x80, 0x00]);
    });

    it('emits the documented header for MPEG-2.5 at 11.025 kHz', () => {
      const mp3 = synthesizeMp3({ sampleRate: 11_025, bitrateKbps: 32, frames: 1, channels: 1 });
      // E3 = version 00 (MPEG-2.5).  40 = bitrate index 4 (32 kbps), rate 0.
      // C0 = mono.
      expect([...mp3.subarray(0, 4)]).toEqual([0xff, 0xe3, 0x40, 0xc0]);
    });

    it('uses the 72x frame-size coefficient, not 144x', () => {
      // Halving the coefficient is the whole difference, and getting it wrong
      // produces frames that still parse but with a doubled duration.
      expect(frameSize(64, 22_050)).toBe(208);
      expect(frameSize(32, 16_000)).toBe(144);
      expect(frameSize(32, 11_025)).toBe(208);
      expect(frameSize(16, 8_000)).toBe(144);
    });

    it('codes 576 samples per frame, not 1152', () => {
      expect(samplesPerFrame(1)).toBe(1152);
      expect(samplesPerFrame(2)).toBe(576);
      expect(samplesPerFrame(2.5)).toBe(576);
      expect(expectedDurationMs(400, 22_050)).toBeCloseTo(10_449, 0);
      expect(expectedDurationMs(400, 44_100)).toBeCloseTo(10_449, 0);
    });

    it('picks the version from the sample rate', () => {
      expect(versionForSampleRate(44_100)).toBe(1);
      expect(versionForSampleRate(32_000)).toBe(1);
      expect(versionForSampleRate(22_050)).toBe(2);
      expect(versionForSampleRate(16_000)).toBe(2);
      expect(versionForSampleRate(11_025)).toBe(2.5);
      expect(versionForSampleRate(8_000)).toBe(2.5);
      expect(() => versionForSampleRate(96_000)).toThrow(/No MPEG version/);
    });

    it('refuses a bitrate the version cannot express', () => {
      // 320 kbps exists in the MPEG-1 table and not in the MPEG-2 one.
      expect(() => synthesizeMp3({ sampleRate: 22_050, bitrateKbps: 320 })).toThrow(
        /not valid for MPEG-2/,
      );
      // 8 kbps is the reverse case.
      expect(() => synthesizeMp3({ sampleRate: 44_100, bitrateKbps: 8 })).toThrow(
        /not valid for MPEG-1/,
      );
    });

    it('defaults the bitrate per version', () => {
      expect(synthesizeMp3({ frames: 1 }).length).toBe(417); // MPEG-1 128 kbps
      expect(synthesizeMp3({ sampleRate: 22_050, frames: 1 }).length).toBe(208); // MPEG-2 64 kbps
    });
  });

  describe('streamMp3', () => {
    it('streams the same bytes the buffer generator would produce', async () => {
      const { stream, bytes } = streamMp3({ bytes: 417 * 10 });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const streamed = Buffer.concat(chunks);

      expect(bytes).toBe(417 * 10);
      expect(streamed).toEqual(synthesizeMp3({ frames: 10 }));
    });

    it('rounds down to a whole number of frames', () => {
      const { bytes } = streamMp3({ bytes: 417 * 10 + 200 });
      expect(bytes).toBe(417 * 10);
    });

    it('emits a single frame without batching', async () => {
      const { stream, bytes } = streamMp3({ bytes: 417 });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(bytes).toBe(417);
      expect(Buffer.concat(chunks)).toEqual(synthesizeMp3({ frames: 1 }));
    });
  });
});
