import { describe, expect, it } from 'vitest';
import { scoreQuality, type QualityInput } from './quality.js';

/** Bytes for a file whose payload exactly matches its declared bitrate. */
function consistentSize(bitrateBps: number, durationMs: number): number {
  return Math.round((bitrateBps / 8) * (durationMs / 1000));
}

function input(overrides: Partial<QualityInput> = {}): QualityInput {
  const bitrateBps = overrides.bitrateBps ?? 128_000;
  const durationMs = overrides.durationMs ?? 180_000;
  return {
    bitrateBps,
    sampleRateHz: 44_100,
    channels: 2,
    encodingMode: 'CBR',
    durationMs,
    sizeBytes: consistentSize(bitrateBps ?? 128_000, durationMs),
    ...overrides,
  };
}

describe('scoreQuality', () => {
  // These rows are the documented reference table in the README. If a weight
  // changes, this test is where the change has to be argued for.
  it.each([
    [
      '320 VBR / 48 kHz / stereo',
      { bitrateBps: 320_000, sampleRateHz: 48_000, encodingMode: 'VBR' as const },
      10,
    ],
    ['320 CBR / 44.1 kHz / stereo', { bitrateBps: 320_000 }, 9],
    ['192 CBR / 44.1 kHz / stereo', { bitrateBps: 192_000 }, 8],
    ['128 CBR / 44.1 kHz / stereo', { bitrateBps: 128_000 }, 7],
    ['64 CBR / 22.05 kHz / mono', { bitrateBps: 64_000, sampleRateHz: 22_050, channels: 1 }, 4],
    ['256 CBR / 44.1 kHz / stereo', { bitrateBps: 256_000 }, 9],
    ['160 CBR / 44.1 kHz / stereo', { bitrateBps: 160_000 }, 8],
    ['96 CBR / 44.1 kHz / stereo', { bitrateBps: 96_000 }, 7],
    ['32 CBR / 44.1 kHz / stereo', { bitrateBps: 32_000 }, 6],
  ])('%s scores %i', (_label, overrides, expected) => {
    expect(scoreQuality(input(overrides)).score).toBe(expected);
  });

  it('scores a low-bitrate, low-rate, inconsistent file at the bottom of the scale', () => {
    const result = scoreQuality({
      bitrateBps: 32_000,
      sampleRateHz: 11_025,
      channels: 1,
      encodingMode: 'CBR',
      durationMs: 180_000,
      sizeBytes: 100, // nowhere near 32 kbps of payload
    });
    expect(result.score).toBe(2);
    expect(result.breakdown.consistency).toBe(0);
  });

  it('penalises a truncated file relative to an intact one with the same header', () => {
    const intact = scoreQuality(input({ bitrateBps: 320_000 }));
    const truncated = scoreQuality(
      input({ bitrateBps: 320_000, sizeBytes: consistentSize(320_000, 180_000) / 4 }),
    );
    expect(truncated.score).toBeLessThan(intact.score);
  });

  it('tolerates embedded cover art without calling the file inconsistent', () => {
    // A 300 KB JPEG on a 3-minute 192 kbps track: bigger than the audio implies,
    // but entirely normal.
    const withArt = input({
      bitrateBps: 192_000,
      sizeBytes: consistentSize(192_000, 180_000) + 300_000,
    });
    expect(scoreQuality(withArt).breakdown.consistency).toBeGreaterThan(0);
  });

  // Asserting the rounded 1-10 score cannot see a tier boundary move: a 0.5
  // shift in one component usually rounds back to the same integer. These
  // assert the component, which is where the thresholds actually live.
  it.each([
    ['320 kbps exactly', 320_000, 4],
    ['just under 320', 319_000, 3.5],
    ['256 exactly', 256_000, 3.5],
    ['just under 256', 255_000, 3],
    ['192 exactly', 192_000, 3],
    ['just under 192', 191_000, 2.5],
    ['160 exactly', 160_000, 2.5],
    ['just under 160', 159_000, 2],
    ['128 exactly', 128_000, 2],
    ['just under 128', 127_000, 1.25],
    ['96 exactly', 96_000, 1.25],
    ['just under 96', 95_000, 0.75],
    ['64 exactly', 64_000, 0.75],
    ['just under 64', 63_000, 0.25],
    ['8 kbps', 8_000, 0.25],
  ])('scores the %s bitrate tier', (_label, bitrateBps, expected) => {
    expect(scoreQuality(input({ bitrateBps })).breakdown.bitrate).toBe(expected);
  });

  it('treats an unknown bitrate as neutral-low', () => {
    expect(scoreQuality(input({ bitrateBps: null })).breakdown.bitrate).toBe(1.5);
  });

  it.each([
    ['48 kHz exactly', 48_000, 3],
    ['just under 48 kHz', 47_999, 2.5],
    ['44.1 kHz exactly', 44_100, 2.5],
    ['just under 44.1 kHz', 44_099, 1.5],
    ['32 kHz exactly', 32_000, 1.5],
    ['just under 32 kHz', 31_999, 1],
    ['22.05 kHz exactly', 22_050, 1],
    ['just under 22.05 kHz', 22_049, 0.5],
  ])('scores the %s boundary', (_label, sampleRateHz, expected) => {
    expect(scoreQuality(input({ sampleRateHz })).breakdown.sampleRate).toBe(expected);
  });

  it.each([
    ['stereo', 2, 1],
    ['more than stereo', 6, 1],
    ['mono', 1, 0.5],
  ])('scores %s channels', (_label, channels, expected) => {
    expect(scoreQuality(input({ channels })).breakdown.channels).toBe(expected);
  });

  it('treats unknown channels as neutral, distinct from both stereo and mono', () => {
    const unknown = scoreQuality(input({ channels: null })).breakdown.channels;
    expect(unknown).toBe(0.75);
    expect(unknown).not.toBe(scoreQuality(input({ channels: 2 })).breakdown.channels);
    expect(unknown).not.toBe(scoreQuality(input({ channels: 1 })).breakdown.channels);
  });

  it.each([
    ['VBR', 'VBR' as const, 1],
    ['CBR', 'CBR' as const, 0.75],
    ['an undetermined mode', null, 0.5],
  ])('scores %s encoding', (_label, encodingMode, expected) => {
    expect(scoreQuality(input({ encodingMode })).breakdown.encodingMode).toBe(expected);
  });

  it.each([
    ['a missing bitrate', { bitrateBps: null }],
    ['a zero duration', { durationMs: 0 }],
    ['a negative duration', { durationMs: -1 }],
  ])('declines to judge consistency given %s', (_label, overrides) => {
    // Both halves of the guard matter independently: neither alone should be
    // able to stand in for the other.
    expect(scoreQuality(input(overrides)).breakdown.consistency).toBe(0.75);
  });

  it('declines to judge consistency when the duration was estimated from the size', () => {
    // The estimate is sizeBytes x 8 / bitrate, so comparing the size against it
    // is comparing a number with itself: the ratio is 1.0 for every file,
    // including a truncated one. Saying nothing is the honest answer.
    const estimated = scoreQuality(input({ durationIsEstimated: true }));
    expect(estimated.breakdown.consistency).toBe(0.75);
  });

  it('judges consistency normally when the duration is authoritative', () => {
    expect(scoreQuality(input({ durationIsEstimated: false })).breakdown.consistency).toBe(1);
    // Absent means authoritative, so existing callers are unaffected.
    expect(scoreQuality(input({})).breakdown.consistency).toBe(1);
  });

  it('still catches a truncated file whose duration is known independently', () => {
    // The case the check exists for: real duration, missing bytes.
    const truncated = scoreQuality(
      input({ bitrateBps: 320_000, durationMs: 180_000, sizeBytes: 1_000_000 }),
    );
    expect(truncated.breakdown.consistency).toBe(0);
  });

  it('still judges consistency when only one half of the guard would trip', () => {
    expect(
      scoreQuality(input({ bitrateBps: 128_000, durationMs: 180_000 })).breakdown.consistency,
    ).toBe(1);
  });

  it.each([
    ['48 kHz', 48_000, 3],
    ['44.1 kHz', 44_100, 2.5],
    ['32 kHz', 32_000, 1.5],
    ['22.05 kHz', 22_050, 1],
    ['8 kHz', 8_000, 0.5],
  ])('scores the %s sample-rate tier', (_label, sampleRateHz, expected) => {
    expect(scoreQuality(input({ sampleRateHz })).breakdown.sampleRate).toBe(expected);
  });

  it('treats an unknown sample rate as neutral-low', () => {
    expect(scoreQuality(input({ sampleRateHz: null })).breakdown.sampleRate).toBe(1.5);
  });

  it('gives no consistency credit when the declared bitrate cannot be checked', () => {
    expect(scoreQuality(input({ bitrateBps: 0 })).breakdown.consistency).toBe(0.75);
  });

  it('returns a neutral score when the parser could tell us nothing', () => {
    const result = scoreQuality({
      bitrateBps: null,
      sampleRateHz: null,
      channels: null,
      encodingMode: null,
      sizeBytes: 0,
      durationMs: 0,
    });
    expect(result.score).toBe(5);
    expect(result.breakdown.consistency).toBe(0.75);
  });

  it('always lands on an integer in [1, 10]', () => {
    const bitrates = [0, 8_000, 32_000, 64_000, 128_000, 192_000, 320_000, 999_000, null];
    const rates = [8_000, 22_050, 32_000, 44_100, 48_000, 96_000, null];
    const modes = ['CBR', 'VBR', null] as const;

    for (const bitrateBps of bitrates) {
      for (const sampleRateHz of rates) {
        for (const encodingMode of modes) {
          for (const channels of [1, 2, null]) {
            for (const sizeBytes of [0, 1, 5_000_000]) {
              const { score } = scoreQuality({
                bitrateBps,
                sampleRateHz,
                channels,
                encodingMode,
                sizeBytes,
                durationMs: 180_000,
              });
              expect(Number.isInteger(score)).toBe(true);
              expect(score).toBeGreaterThanOrEqual(1);
              expect(score).toBeLessThanOrEqual(10);
            }
          }
        }
      }
    }
  });

  it('is pure: it does not mutate its input and repeats itself', () => {
    const value = input();
    const snapshot = structuredClone(value);
    const first = scoreQuality(value);
    const second = scoreQuality(value);
    expect(value).toEqual(snapshot);
    expect(first).toEqual(second);
  });
});
