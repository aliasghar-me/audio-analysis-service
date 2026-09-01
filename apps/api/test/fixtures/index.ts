import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * A real, LAME-encoded, VBR, ID3-tagged MP3, dedicated to the public domain
 * under CC0. See README.md in this directory for provenance and for what it
 * covers that the synthetic generator cannot.
 */
export const REAL_MP3 = {
  filename: 'david-graeber-voice-cc0.mp3',
  sha256: '0680d1877d133441f6b8fdd1369e6d7d49c46a3925a3a23f1d0561db0d2bbd89',
  sizeBytes: 222_928,
  /** Measured, not asserted from the header: LAME wrote a VBR stream. */
  expected: {
    codec: 'MPEG 1 Layer 3',
    encodingMode: 'VBR' as const,
    sampleRateHz: 48_000,
    channels: 1,
    /** Fractional, because a VBR average is. Stored rounded. */
    bitrateBps: 96_227.979,
    durationMs: 18_528,
    tool: 'LAME 3.99r',
  },
} as const;

export function readRealMp3(): Buffer {
  return readFileSync(path.join(fixturesDir, REAL_MP3.filename));
}

export function realMp3Path(): string {
  return path.join(fixturesDir, REAL_MP3.filename);
}
