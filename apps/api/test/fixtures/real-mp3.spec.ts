import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseBuffer } from 'music-metadata';
import { readAudioFactsFromBuffer } from '../../src/audio/metadata.js';
import { formatDuration, isDurationOutlier } from '../../src/audio/duration.js';
import { scoreQuality } from '../../src/audio/quality.js';
import { isMp3 } from '../../src/audio/sniff.js';
import { readRealMp3, REAL_MP3 } from './index.js';

/**
 * Everything the hand-built generator cannot prove.
 *
 * These run against a real LAME encode rather than frames this repository
 * assembled itself, so they are the check that the synthetic fixtures have not
 * quietly drifted into testing our own assumptions back at us.
 */
describe('the real CC0 MP3 fixture', () => {
  const mp3 = readRealMp3();

  it('is the file the provenance record describes', () => {
    // If someone swaps or corrupts the fixture, every assertion below would
    // silently start meaning something else. Fail here instead.
    expect(mp3.length).toBe(REAL_MP3.sizeBytes);
    expect(createHash('sha256').update(mp3).digest('hex')).toBe(REAL_MP3.sha256);
  });

  it('was produced by a real encoder', async () => {
    const metadata = await parseBuffer(new Uint8Array(mp3), { mimeType: 'audio/mpeg' });
    expect(metadata.format.tool).toBe(REAL_MP3.expected.tool);
    expect(metadata.format.tagTypes).toContain('ID3v2.3');
  });

  it('passes the magic-byte gate via its ID3 tag', () => {
    expect(isMp3(Uint8Array.from(mp3.subarray(0, 16)))).toBe(true);
  });

  it('is recognised as VBR from a LAME preset profile', async () => {
    // music-metadata reports `V2` here, not the literal string 'VBR'. Every
    // synthetic fixture is CBR, so this is the only test covering that branch.
    const metadata = await parseBuffer(new Uint8Array(mp3), { mimeType: 'audio/mpeg' });
    expect(metadata.format.codecProfile).toMatch(/^V\d/);

    const facts = await readAudioFactsFromBuffer(mp3);
    expect(facts.encodingMode).toBe('VBR');
  });

  it('reports a fractional average bitrate', async () => {
    const facts = await readAudioFactsFromBuffer(mp3);
    expect(facts.bitrateBps).toBeCloseTo(REAL_MP3.expected.bitrateBps, 1);
    // The point of this assertion: it is NOT an integer, which is what the
    // synthetic CBR fixtures always produce.
    expect(Number.isInteger(facts.bitrateBps)).toBe(false);
  });

  it('reads the rest of the header correctly', async () => {
    const facts = await readAudioFactsFromBuffer(mp3);
    expect(facts.codec).toBe(REAL_MP3.expected.codec);
    expect(facts.sampleRateHz).toBe(REAL_MP3.expected.sampleRateHz);
    expect(facts.channels).toBe(REAL_MP3.expected.channels);
    expect(facts.durationMs).toBeCloseTo(REAL_MP3.expected.durationMs, 0);
  });

  it('flows through the analysis functions to a sensible verdict', async () => {
    const facts = await readAudioFactsFromBuffer(mp3);

    expect(formatDuration(facts.durationMs)).toBe('00:19');
    expect(isDurationOutlier(facts.durationMs, { minSeconds: 5, maxSeconds: 600 })).toBe(false);

    const { score, breakdown } = scoreQuality({
      bitrateBps: facts.bitrateBps,
      sampleRateHz: facts.sampleRateHz,
      channels: facts.channels,
      encodingMode: facts.encodingMode,
      sizeBytes: mp3.length,
      durationMs: facts.durationMs,
    });

    // A middling real-world file: 96 kbps VBR mono at 48 kHz.
    expect(score).toBe(7);
    expect(breakdown.encodingMode).toBe(1); // the VBR credit
    expect(breakdown.channels).toBe(0.5); // mono
    // The consistency check has to survive a 200 KB file with a real ID3 tag
    // and a VBR average, which is the case most likely to trip a naive ratio.
    expect(breakdown.consistency).toBe(1);
  });
});
