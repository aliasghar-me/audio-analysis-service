/**
 * A transparent, auditable encoding-quality score.
 *
 * This measures how much bandwidth an encoder was given and whether the bytes
 * on disk are consistent with what the header claims. It does NOT measure
 * perceived quality: a pristine 320 kbps encode of a clipped, hissy master
 * scores 10, and a 96 kbps encode of a flawless master scores 6. Detecting the
 * difference needs DSP or a trained model, both of which the brief rules out.
 *
 * The implementation is a point table rather than a tuned formula on purpose —
 * every number a caller sees can be explained by pointing at a row, and the
 * per-component breakdown is returned (and stored) alongside the score.
 */
export interface QualityInput {
  bitrateBps: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  encodingMode: 'CBR' | 'VBR' | null;
  sizeBytes: number;
  durationMs: number;
  /**
   * Whether `durationMs` was derived from `sizeBytes`. Optional, defaulting to
   * false, so callers holding an authoritative duration need say nothing.
   */
  durationIsEstimated?: boolean;
}

export interface QualityBreakdown {
  bitrate: number;
  sampleRate: number;
  channels: number;
  encodingMode: number;
  consistency: number;
  total: number;
}

export interface QualityResult {
  score: number;
  breakdown: QualityBreakdown;
}

export const QUALITY_SCORE_MAX = 10;

/**
 * Bitrate, max 4 points — the heaviest weight, because for a fixed codec the
 * bit budget is the single best available proxy for how much of the signal
 * survived encoding.
 */
function scoreBitrate(bitrateBps: number | null): number {
  if (bitrateBps === null) return 1.5; // neutral-low: absence of evidence, not evidence of absence
  const kbps = bitrateBps / 1000;
  if (kbps >= 320) return 4;
  if (kbps >= 256) return 3.5;
  if (kbps >= 192) return 3;
  if (kbps >= 160) return 2.5;
  if (kbps >= 128) return 2;
  if (kbps >= 96) return 1.25;
  if (kbps >= 64) return 0.75;
  return 0.25;
}

/**
 * Sample rate, max 3 points — it caps reproducible bandwidth outright
 * (Nyquist). 44.1 kHz is the CD baseline; below 32 kHz the treble is audibly
 * gone no matter how many bits you spend.
 */
function scoreSampleRate(sampleRateHz: number | null): number {
  if (sampleRateHz === null) return 1.5;
  if (sampleRateHz >= 48_000) return 3;
  if (sampleRateHz >= 44_100) return 2.5;
  if (sampleRateHz >= 32_000) return 1.5;
  if (sampleRateHz >= 22_050) return 1;
  return 0.5;
}

/**
 * Channels, max 1 point. Mono is not a defect — it is correct for speech — so
 * the weight is deliberately small. For a music file it is information that
 * simply is not there.
 */
function scoreChannels(channels: number | null): number {
  if (channels === null) return 0.75;
  return channels >= 2 ? 1 : 0.5;
}

/**
 * Encoding mode, max 1 point. At an equal average bitrate, VBR spends bits on
 * the passages that need them. A small weight, because the effect is small next
 * to the bitrate itself.
 */
function scoreEncodingMode(mode: 'CBR' | 'VBR' | null): number {
  if (mode === 'VBR') return 1;
  if (mode === 'CBR') return 0.75;
  return 0.5;
}

/**
 * Consistency, max 1 point — the only component that looks at the file rather
 * than the header, and so the only one that can catch a lie. A file whose bytes
 * do not match its declared bitrate is truncated, padded, or mis-declared.
 *
 * The bands are wide on the upside because ID3 tags and embedded cover art
 * legitimately add hundreds of kilobytes that carry no audio.
 */
function scoreConsistency(input: QualityInput): number {
  if (input.bitrateBps === null || input.durationMs <= 0) return 0.75;

  // If the duration was itself computed as sizeBytes x 8 / bitrate, then
  // actual = sizeBytes / (sizeBytes x 8 / bitrate) = bitrate / 8 = expected,
  // and the ratio is exactly 1.0 for every possible file. The check would score
  // a truncated fragment as perfectly consistent, so it says nothing instead.
  if (input.durationIsEstimated === true) return 0.75;

  const actualBytesPerSecond = input.sizeBytes / (input.durationMs / 1000);
  const expectedBytesPerSecond = input.bitrateBps / 8;
  if (expectedBytesPerSecond <= 0) return 0.75;

  const ratio = actualBytesPerSecond / expectedBytesPerSecond;
  if (ratio >= 0.85 && ratio <= 1.35) return 1; // normal: frame headers plus modest tags
  if (ratio >= 0.6 && ratio <= 1.8) return 0.5; // large embedded art, or a wide VBR spread
  return 0; // the declared bitrate does not describe these bytes
}

export function scoreQuality(input: QualityInput): QualityResult {
  const bitrate = scoreBitrate(input.bitrateBps);
  const sampleRate = scoreSampleRate(input.sampleRateHz);
  const channels = scoreChannels(input.channels);
  const encodingMode = scoreEncodingMode(input.encodingMode);
  const consistency = scoreConsistency(input);

  const total = bitrate + sampleRate + channels + encodingMode + consistency;

  // Clamped to 1, never 0: the worst real file is still a file, and the brief
  // asks for a 1-10 scale.
  const score = Math.min(QUALITY_SCORE_MAX, Math.max(1, Math.round(total)));

  return {
    score,
    breakdown: {
      bitrate,
      sampleRate,
      channels,
      encodingMode,
      consistency,
      total: Number(total.toFixed(2)),
    },
  };
}
