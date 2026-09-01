import { describe, expect, it } from 'vitest';
import { expectedDurationMs, frameSize, synthesizeMp3 } from './synthesize-mp3.js';

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
});
