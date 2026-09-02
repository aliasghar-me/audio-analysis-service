import { parseFile, type IAudioMetadata } from 'music-metadata';
import { AppError } from '../http/errors.js';

/**
 * The facts the rest of the pipeline needs, extracted from MPEG frame headers.
 *
 * Everything here comes from the file's own headers rather than from decoding
 * audio, which is why no ffmpeg or native dependency is required.
 */
export interface AudioFacts {
  durationMs: number;
  /**
   * True when the duration had to be derived from the file size and the
   * declared bitrate rather than read from the stream. It matters downstream:
   * a size-derived duration cannot be used to judge whether the size is
   * plausible, because that comparison would be circular.
   */
  durationIsEstimated: boolean;
  bitrateBps: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  codec: string;
  encodingMode: 'CBR' | 'VBR' | null;
}

export interface ResolvedDuration {
  durationMs: number;
  estimated: boolean;
}

function invalidAudio(reason: string, cause?: unknown): AppError {
  return new AppError(
    'INVALID_AUDIO',
    'The uploaded file is not a valid MP3 audio file.',
    { reason },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * music-metadata reports a profile like `CBR`, `VBR` or a LAME preset (`V2`).
 * Anything it cannot determine stays null rather than being guessed at.
 *
 * Exported for its own tests: forging an MP3 that provokes each profile string
 * out of the parser would test the parser, not this mapping.
 */
export function toEncodingMode(profile: string | undefined): 'CBR' | 'VBR' | null {
  if (!profile) return null;
  if (profile === 'CBR') return 'CBR';
  if (profile.includes('VBR') || /^V\d/.test(profile)) return 'VBR';
  return null;
}

/**
 * Resolve a duration, in milliseconds.
 *
 * Three tiers, because a real-world MP3 with a stripped Xing header reaches
 * tier three and there is no reason to fail on a file every player can play:
 *
 *   1. the parser's own duration
 *   2. sample count over sample rate
 *   3. a CBR estimate from the payload size and the declared bitrate
 */
export function resolveDurationMs(
  metadata: IAudioMetadata,
  sizeBytes: number,
): ResolvedDuration | null {
  const { duration, numberOfSamples, sampleRate, bitrate } = metadata.format;

  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    return { durationMs: duration * 1000, estimated: false };
  }

  if (numberOfSamples && sampleRate) {
    return { durationMs: (numberOfSamples / sampleRate) * 1000, estimated: false };
  }

  if (bitrate && bitrate > 0 && sizeBytes > 0) {
    // Derived from the size, so anything that later compares the size against
    // this number is comparing a value with itself.
    return { durationMs: ((sizeBytes * 8) / bitrate) * 1000, estimated: true };
  }

  return null;
}

/**
 * The size of one MPEG Layer III frame, in bytes.
 *
 * The version comes from the codec string music-metadata already returns
 * (`MPEG 1 Layer 3`, `MPEG 2 Layer 3`, `MPEG 2.5 Layer 3`) and decides the
 * coefficient: Layer III codes 1152 samples per frame on MPEG-1 and 576 below
 * it, so the byte formula halves from 144 to 72.
 *
 * Returns null when anything needed is unknown — a file we cannot measure must
 * not be rejected for failing a measurement.
 */
export function mpegFrameBytes(
  codec: string | undefined,
  bitrateBps: number | null,
  sampleRateHz: number | null,
): number | null {
  // `!bitrateBps` already rejects 0, null and NaN, so an explicit `<= 0` after
  // it would be dead. A negative would yield a negative frame size, and
  // `sizeBytes < negative` is false, so nothing is rejected on bad input.
  if (!codec || !bitrateBps || !sampleRateHz) return null;
  const version = /MPEG\s*([\d.]+)/i.exec(codec)?.[1];
  if (version === undefined) return null;
  const coefficient = version === '1' ? 144 : 72;
  return Math.floor((coefficient * bitrateBps) / sampleRateHz);
}

/**
 * Turn a parse result into `AudioFacts`, or into one documented 400.
 *
 * Note that a malformed file does not necessarily throw — music-metadata
 * returns an empty format for unrecognised bytes — so the container check below
 * is doing real work, not defensive padding. It is also what stops a FLAC or
 * WAV renamed `.mp3` from being accepted.
 */
export function toFacts(metadata: IAudioMetadata, sizeBytes: number): AudioFacts {
  const { container, codec } = metadata.format;

  if (container !== 'MPEG') {
    throw invalidAudio('not_mpeg');
  }
  if (!codec || !/Layer 3/i.test(codec)) {
    // MPEG Layer I and Layer II are valid MPEG audio but they are not MP3.
    throw invalidAudio('not_layer_3');
  }

  const bitrateBps = metadata.format.bitrate ?? null;
  const sampleRateHz = metadata.format.sampleRate ?? null;

  // A file too small to hold a single frame carries a readable header and no
  // decodable audio. Every player produces silence from it, and accepting it
  // means storing a fragment and reporting a duration measured in milliseconds.
  const frameBytes = mpegFrameBytes(codec, bitrateBps, sampleRateHz);
  if (frameBytes !== null && sizeBytes < frameBytes) {
    throw invalidAudio('incomplete_frame');
  }

  const resolved = resolveDurationMs(metadata, sizeBytes);
  if (resolved === null || resolved.durationMs <= 0) {
    throw invalidAudio('no_duration');
  }

  return {
    durationMs: resolved.durationMs,
    durationIsEstimated: resolved.estimated,
    bitrateBps,
    sampleRateHz,
    channels: metadata.format.numberOfChannels ?? null,
    codec,
    encodingMode: toEncodingMode(metadata.format.codecProfile),
  };
}

/** Read the audio facts of a file on disk. */
export async function readAudioFacts(filePath: string, sizeBytes: number): Promise<AudioFacts> {
  let metadata: IAudioMetadata;
  try {
    metadata = await parseFile(filePath, { duration: true });
  } catch (cause) {
    // The library's message can contain a filesystem path, so it goes to the
    // log via `cause` and never into the response.
    throw invalidAudio('parse_failed', cause);
  }
  return toFacts(metadata, sizeBytes);
}

/**
 * The average bitrate as an integer, for the column that stores it.
 *
 * A real VBR file reports a fractional average (a LAME V2 encode measures
 * 96227.979… bps). Rounding here is an explicit decision rather than something
 * delegated to whatever the database driver happens to do with a float; the
 * quality score keeps the unrounded value, where the precision is harmless.
 */
export function storableBitrate(bitrateBps: number | null): number | null {
  return bitrateBps === null ? null : Math.round(bitrateBps);
}
