/**
 * A minimal, valid MPEG-1 Layer III CBR file generator.
 *
 * There is no MP3 encoder on the machines this repo is developed on (no ffmpeg,
 * lame or sox), and committing a binary blob of unclear provenance to a test
 * suite is worse than generating one. Every field the analysis pipeline reads —
 * bitrate, sample rate, channel mode, duration — lives in the 4-byte frame
 * header, so a synthetic file exercises the real sniff, hash, parse, score and
 * store path end to end.
 *
 * What it does not exercise: real encoder output, the VBR/Xing path, ID3 cover
 * art. That limitation is stated in the README rather than papered over.
 *
 * MPEG-1 Layer III frame header, 4 bytes, big-endian:
 *
 *   byte 0  11111111                     sync (first 8 of 11 bits)
 *   byte 1  111 11 01 1                  sync(3) | version 11=MPEG-1 |
 *                                        layer 01=Layer III | protection 1=no CRC
 *   byte 2  bbbb ss p x                  bitrate index | sample-rate index |
 *                                        padding | private
 *   byte 3  cc ee o g m mm               channel mode | mode extension |
 *                                        copyright | original | emphasis
 */

/** MPEG-1 Layer III bitrate index -> kbps. Index 0 is "free", 15 is invalid. */
const BITRATE_INDEX: ReadonlyMap<number, number> = new Map([
  [32, 1],
  [40, 2],
  [48, 3],
  [56, 4],
  [64, 5],
  [80, 6],
  [96, 7],
  [112, 8],
  [128, 9],
  [160, 10],
  [192, 11],
  [224, 12],
  [256, 13],
  [320, 14],
]);

/** MPEG-1 sample-rate index. 3 is reserved. */
const SAMPLE_RATE_INDEX: ReadonlyMap<number, number> = new Map([
  [44_100, 0],
  [48_000, 1],
  [32_000, 2],
]);

/** Layer III always codes 1152 samples per frame. */
export const SAMPLES_PER_FRAME = 1152;

export type Mp3BitrateKbps =
  32 | 40 | 48 | 56 | 64 | 80 | 96 | 112 | 128 | 160 | 192 | 224 | 256 | 320;
export type Mp3SampleRate = 44_100 | 48_000 | 32_000;

export interface SynthesizeMp3Options {
  bitrateKbps?: Mp3BitrateKbps;
  sampleRate?: Mp3SampleRate;
  /** Number of audio frames. 100 frames at 44.1 kHz is ~2.6 s. */
  frames?: number;
  channels?: 1 | 2;
  /** Prefix an empty ID3v2.3 tag, as most real-world files carry. */
  withId3?: boolean;
  padding?: boolean;
}

/** Bytes in one frame, header included. */
export function frameSize(bitrateKbps: number, sampleRate: number, padding = false): number {
  return Math.floor((144 * bitrateKbps * 1000) / sampleRate) + (padding ? 1 : 0);
}

/** Exact duration of a file with this many frames, in milliseconds. */
export function expectedDurationMs(frames: number, sampleRate: number): number {
  return (frames * SAMPLES_PER_FRAME * 1000) / sampleRate;
}

function lookup(table: ReadonlyMap<number, number>, key: number, what: string): number {
  const value = table.get(key);
  if (value === undefined) {
    throw new Error(`${what} ${key} is not valid for MPEG-1 Layer III`);
  }
  return value;
}

function frameHeader(opts: Required<Omit<SynthesizeMp3Options, 'withId3' | 'frames'>>): Buffer {
  const bitrateIndex = lookup(BITRATE_INDEX, opts.bitrateKbps, 'bitrate');
  const sampleRateIndex = lookup(SAMPLE_RATE_INDEX, opts.sampleRate, 'sample rate');
  // 00 = stereo, 11 = mono. Joint stereo and dual channel are not needed here.
  const channelMode = opts.channels === 1 ? 0b11 : 0b00;

  return Buffer.from([
    0xff,
    0b1111_1011, // sync | MPEG-1 | Layer III | no CRC
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

export function synthesizeMp3(options: SynthesizeMp3Options = {}): Buffer {
  const bitrateKbps = options.bitrateKbps ?? 128;
  const sampleRate = options.sampleRate ?? 44_100;
  const frames = options.frames ?? 100;
  const channels = options.channels ?? 2;
  const padding = options.padding ?? false;

  const header = frameHeader({ bitrateKbps, sampleRate, channels, padding });
  const size = frameSize(bitrateKbps, sampleRate, padding);

  // The payload is zeroed. No metadata parser decodes audio to read a header —
  // they walk the chain of frame headers — so its content is irrelevant.
  const frame = Buffer.concat([header, Buffer.alloc(size - header.length)]);
  const audio = Buffer.concat(Array.from({ length: frames }, () => frame));

  return options.withId3 ? Buffer.concat([id3Tag(), audio]) : audio;
}
