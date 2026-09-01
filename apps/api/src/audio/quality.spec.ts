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
