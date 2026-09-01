import { Readable } from 'node:stream';

/**
 * A minimal, valid MPEG Layer III CBR file generator.
 *
 * There is no MP3 encoder on the machines this repo is developed on (no ffmpeg,
 * lame or sox), and committing a binary blob of unclear provenance to a test
 * suite is worse than generating one. Every field the analysis pipeline reads —
 * bitrate, sample rate, channel mode, duration — lives in the 4-byte frame
 * header, so a synthetic file exercises the real sniff, hash, parse, score and
 * store path end to end.
 *
 * What it does not exercise: real encoder output, VBR, or a tag written by a
 * real tagger. That gap is covered by test/fixtures/david-graeber-voice-cc0.mp3,
 * a genuine CC0-licensed LAME encode — see the README in that directory.
 *
 * MPEG Layer III frame header, 4 bytes, big-endian:
 *
 *   byte 0  11111111                     sync (first 8 of 11 bits)
 *   byte 1  111 vv 01 1                  sync(3) | version | layer 01=III |
 *                                        protection 1=no CRC
 *   byte 2  bbbb ss p x                  bitrate index | sample-rate index |
 *                                        padding | private
 *   byte 3  cc ee o g m mm               channel mode | mode extension |
 *                                        copyright | original | emphasis
 *
 * The version field is what makes the low sample rates reachable, and it
 * changes three things at once — the rate table, the bitrate table, and the
 * number of samples a frame codes. Getting one right and the other two wrong
 * yields a file that parses with a plausible but wrong duration, which is what
 * this table exists to prevent:
 *
 *   version  byte1  sample rates (idx 0/1/2)  samples/frame  frame size
 *   MPEG-1   0xFB   44100 / 48000 / 32000     1152           floor(144*br/sr)
 *   MPEG-2   0xF3   22050 / 24000 / 16000      576           floor( 72*br/sr)
 *   MPEG-2.5 0xE3   11025 / 12000 /  8000      576           floor( 72*br/sr)
 */

export type MpegVersion = 1 | 2 | 2.5;

/** MPEG-1 Layer III bitrate index -> kbps. Index 0 is "free", 15 is invalid. */
const MPEG1_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;

/** MPEG-2 and MPEG-2.5 Layer III use an entirely different bitrate table. */
const MPEG2_BITRATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] as const;

const SAMPLE_RATES: Record<MpegVersion, readonly number[]> = {
  1: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  2.5: [11_025, 12_000, 8_000],
};

/** Layer III codes 1152 samples per frame on MPEG-1, 576 on MPEG-2 and 2.5. */
export const SAMPLES_PER_FRAME = 1152;

export function samplesPerFrame(version: MpegVersion): number {
  return version === 1 ? 1152 : 576;
}

export type Mp3BitrateKbps = (typeof MPEG1_BITRATES)[number] | (typeof MPEG2_BITRATES)[number];
export type Mp3SampleRate =
  44_100 | 48_000 | 32_000 | 22_050 | 24_000 | 16_000 | 11_025 | 12_000 | 8_000;

export interface SynthesizeMp3Options {
  bitrateKbps?: Mp3BitrateKbps;
  sampleRate?: Mp3SampleRate;
  /** Number of audio frames. 100 frames at 44.1 kHz is ~2.6 s. */
  frames?: number;
  channels?: 1 | 2;
  /** Prefix an empty ID3v2.3 tag, as most real-world files carry. */
  withId3?: boolean;
  padding?: boolean;
  /** Defaults to whichever version codes the sample rate. */
  mpegVersion?: MpegVersion;
}

function bitrateTable(version: MpegVersion): readonly number[] {
  return version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES;
}

/** The version that codes a sample rate. Each rate appears in exactly one table. */
export function versionForSampleRate(sampleRate: number): MpegVersion {
  for (const version of [1, 2, 2.5] as const) {
    if (SAMPLE_RATES[version].includes(sampleRate)) return version;
  }
  throw new Error(`No MPEG version codes a sample rate of ${sampleRate}`);
}

/** Bytes in one frame, header included. */
export function frameSize(
  bitrateKbps: number,
  sampleRate: number,
  padding = false,
  version: MpegVersion = versionForSampleRate(sampleRate),
): number {
  const coefficient = version === 1 ? 144 : 72;
  return Math.floor((coefficient * bitrateKbps * 1000) / sampleRate) + (padding ? 1 : 0);
}

/** Exact duration of a file with this many frames, in milliseconds. */
export function expectedDurationMs(
  frames: number,
  sampleRate: number,
  version: MpegVersion = versionForSampleRate(sampleRate),
): number {
  return (frames * samplesPerFrame(version) * 1000) / sampleRate;
}

function bitrateIndexOf(value: number, version: MpegVersion): number {
  const at = bitrateTable(version).indexOf(value);
  if (at < 0) throw new Error(`bitrate ${value} is not valid for MPEG-${version} Layer III`);
  // Index 0 is "free format", so the table is 1-based on the wire.
  return at + 1;
}

function frameHeader(opts: {
  bitrateKbps: number;
  sampleRate: number;
  channels: 1 | 2;
  padding: boolean;
  version: MpegVersion;
}): Buffer {
  const { version } = opts;
  const bitrateIndex = bitrateIndexOf(opts.bitrateKbps, version);
  const sampleRateIndex = SAMPLE_RATES[version].indexOf(opts.sampleRate);
  if (sampleRateIndex < 0) {
    throw new Error(`sample rate ${opts.sampleRate} is not valid for MPEG-${version}`);
  }

  // 11 = MPEG-1, 10 = MPEG-2, 00 = MPEG-2.5 (01 is reserved).
  const versionBits = version === 1 ? 0b11 : version === 2 ? 0b10 : 0b00;
  // sync(3) | version(2) | layer 01 = Layer III | protection 1 = no CRC
  const byte1 = 0b1110_0000 | (versionBits << 3) | (0b01 << 1) | 1;
  // 00 = stereo, 11 = mono. Joint stereo and dual channel are not needed here.
  const channelMode = opts.channels === 1 ? 0b11 : 0b00;

  return Buffer.from([
    0xff,
    byte1,
    (bitrateIndex << 4) | (sampleRateIndex << 2) | (opts.padding ? 0b10 : 0),
    channelMode << 6, // mode extension, copyright, original and emphasis all 0
  ]);
}

/**
 * An empty ID3v2.3 tag: "ID3", version, flags, then a syncsafe 32-bit size.
 * Syncsafe means seven significant bits per byte, so the tag length can never
 * contain a byte that looks like a frame sync.
 */
function id3Tag(payloadBytes = 128): Buffer {
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 0x03; // major version
  header[4] = 0x00; // revision
  header[5] = 0x00; // flags
  header[6] = (payloadBytes >> 21) & 0x7f;
  header[7] = (payloadBytes >> 14) & 0x7f;
  header[8] = (payloadBytes >> 7) & 0x7f;
  header[9] = payloadBytes & 0x7f;
  return Buffer.concat([header, Buffer.alloc(payloadBytes)]);
}

function buildFrame(options: SynthesizeMp3Options) {
  const sampleRate = options.sampleRate ?? 44_100;
  const version = options.mpegVersion ?? versionForSampleRate(sampleRate);
  const bitrateKbps = options.bitrateKbps ?? (version === 1 ? 128 : 64);
  const channels = options.channels ?? 2;
  const padding = options.padding ?? false;

  const header = frameHeader({ bitrateKbps, sampleRate, channels, padding, version });
  const size = frameSize(bitrateKbps, sampleRate, padding, version);
  // The payload is zeroed. No metadata parser decodes audio to read a header —
  // they walk the chain of frame headers — so its content is irrelevant.
  return { frame: Buffer.concat([header, Buffer.alloc(size - header.length)]), size };
}

export function synthesizeMp3(options: SynthesizeMp3Options = {}): Buffer {
  const { frame } = buildFrame(options);
  const frames = options.frames ?? 100;
  const audio = Buffer.concat(Array.from({ length: frames }, () => frame));
  return options.withId3 ? Buffer.concat([id3Tag(), audio]) : audio;
}

export interface StreamMp3Options extends Omit<SynthesizeMp3Options, 'frames' | 'withId3'> {
  /** Target size. Rounded down to a whole number of frames. */
  bytes: number;
}

/**
 * The same file as a stream, for sizes that should never be held in memory.
 *
 * `synthesizeMp3({ frames: 125_000 })` would `Buffer.concat` 125,000 buffers to
 * build 50 MB — slow, and self-defeating in a test whose entire point is that
 * the service does not hold an upload in memory. This yields one pre-built
 * frame repeatedly instead.
 */
export function streamMp3(options: StreamMp3Options): { stream: Readable; bytes: number } {
  const { frame, size } = buildFrame(options);
  const frames = Math.floor(options.bytes / size);
  let remaining = frames;

  const stream = new Readable({
    read() {
      if (remaining <= 0) {
        this.push(null);
        return;
      }
      // Push in blocks rather than one frame at a time: 125,000 individual
      // pushes is a lot of event-loop churn for no benefit.
      const batch = Math.min(remaining, 256);
      remaining -= batch;
      this.push(batch === 1 ? frame : Buffer.concat(Array.from({ length: batch }, () => frame)));
    },
  });

  return { stream, bytes: frames * size };
}
