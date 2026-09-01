import { describe, expect, it } from 'vitest';
import type { Upload } from '../generated/client.js';
import type { OutlierPolicy } from '../audio/duration.js';
import { toAnalysisView, toUploadResult, toUploadSummary, toUploadView } from './presenter.js';

/**
 * The presenter is the single place a database row becomes API JSON, which
 * makes it the single place the contract can break — and the single place
 * `storagePath` could leak.
 *
 * It had been covered only indirectly, by integration tests asserting fields on
 * a response. Mutation testing scored it at 15%: replacing whole return objects
 * with `{}` survived, because nothing asserted the mapping itself.
 */
const POLICY: OutlierPolicy = { minSeconds: 5, maxSeconds: 600 };

function row(overrides: Partial<Upload> = {}): Upload {
  return {
    id: '01a05da6-03b4-7108-8842-e182d259124f',
    contentHash: 'a'.repeat(64),
    originalName: 'midnight-drive.mp3',
    declaredMime: 'audio/mpeg',
    sizeBytes: 7_680_000,
    storagePath: 'audio/aa/aa/aaaa.mp3',
    durationMs: 192_000,
    isOutlier: false,
    qualityScore: 9,
    qualityBreakdown: {
      bitrate: 4,
      sampleRate: 3,
      channels: 1,
      encodingMode: 0.75,
      consistency: 1,
      total: 9.75,
    },
    bitrateBps: 320_000,
    sampleRateHz: 48_000,
    channels: 2,
    codec: 'MPEG 1 Layer 3',
    encodingMode: 'CBR',
    duplicateCount: 0,
    createdAt: new Date('2026-09-01T15:45:56.149Z'),
    lastUploadedAt: new Date('2026-09-02T09:00:00.000Z'),
    ...overrides,
  } as Upload;
}

describe('toUploadSummary', () => {
  it('maps every field the API promises', () => {
    expect(toUploadSummary(row())).toEqual({
      id: '01a05da6-03b4-7108-8842-e182d259124f',
      filename: 'midnight-drive.mp3',
      contentHash: 'a'.repeat(64),
      sizeBytes: 7_680_000,
      duplicateCount: 0,
      createdAt: '2026-09-01T15:45:56.149Z',
      lastUploadedAt: '2026-09-02T09:00:00.000Z',
    });
  });

  it('never exposes the storage path', () => {
    // The one assertion here that is a security property rather than a shape.
    const summary = toUploadSummary(row());
    expect(Object.keys(summary)).not.toContain('storagePath');
    expect(JSON.stringify(summary)).not.toContain('audio/aa/aa');
  });

  it('exposes the client-facing name, not the internal column name', () => {
    const summary = toUploadSummary(row({ originalName: 'renamed.mp3' }));
    expect(summary.filename).toBe('renamed.mp3');
    expect(summary).not.toHaveProperty('originalName');
  });

  it('serialises timestamps as ISO strings, not Date objects', () => {
    const summary = toUploadSummary(row());
    expect(typeof summary.createdAt).toBe('string');
    expect(typeof summary.lastUploadedAt).toBe('string');
  });

  it('carries the duplicate count through', () => {
    expect(toUploadSummary(row({ duplicateCount: 4 })).duplicateCount).toBe(4);
  });
});

describe('toAnalysisView', () => {
  it('maps duration into all three representations', () => {
    const analysis = toAnalysisView(row(), POLICY);
    expect(analysis.duration).toEqual({
      ms: 192_000,
      seconds: 192,
      formatted: '03:12',
      isOutlier: false,
      outlierPolicy: POLICY,
    });
  });

  it('rounds seconds to milliseconds rather than truncating to whole seconds', () => {
    expect(toAnalysisView(row({ durationMs: 18_528 }), POLICY).duration.seconds).toBe(18.528);
  });

  it('echoes the policy that produced the flag', () => {
    const custom: OutlierPolicy = { minSeconds: 30, maxSeconds: 900 };
    expect(toAnalysisView(row(), custom).duration.outlierPolicy).toEqual(custom);
  });

  it('carries the outlier flag from the row rather than recomputing it', () => {
    // The stored verdict is authoritative: a duplicate must return the same
    // answer it returned the first time, even if the policy has since changed.
    expect(toAnalysisView(row({ isOutlier: true }), POLICY).duration.isOutlier).toBe(true);
  });

  it('reports the quality score with its scale and basis', () => {
    const { quality } = toAnalysisView(row(), POLICY);
    expect(quality.score).toBe(9);
    expect(quality.max).toBe(10);
    expect(quality.basis).toBe('encoding');
    expect(quality.breakdown).toEqual({
      bitrate: 4,
      sampleRate: 3,
      channels: 1,
      encodingMode: 0.75,
      consistency: 1,
      total: 9.75,
    });
  });

  it('maps the format block', () => {
    expect(toAnalysisView(row(), POLICY).format).toEqual({
      codec: 'MPEG 1 Layer 3',
      bitrateBps: 320_000,
      sampleRateHz: 48_000,
      channels: 2,
      encodingMode: 'CBR',
    });
  });

  it('passes unknown format fields through as null, never undefined', () => {
    const { format } = toAnalysisView(
      row({
        codec: null,
        bitrateBps: null,
        sampleRateHz: null,
        channels: null,
        encodingMode: null,
      }),
      POLICY,
    );
    // JSON drops undefined; a client checking `'bitrateBps' in format` must
    // still see the key.
    expect(format).toEqual({
      codec: null,
      bitrateBps: null,
      sampleRateHz: null,
      channels: null,
      encodingMode: null,
    });
    expect(JSON.parse(JSON.stringify(format))).toEqual(format);
  });
});

describe('toUploadView', () => {
  it('is the summary and the analysis together, and nothing else', () => {
    const view = toUploadView(row(), POLICY);
    expect(Object.keys(view).sort()).toEqual(['analysis', 'upload']);
    expect(view.upload).toEqual(toUploadSummary(row()));
    expect(view.analysis).toEqual(toAnalysisView(row(), POLICY));
  });
});

describe('toUploadResult', () => {
  it('reports a new upload with no original to point at', () => {
    const result = toUploadResult(row(), POLICY, {
      duplicate: false,
      submittedFilename: 'midnight-drive.mp3',
    });

    expect(result.duplicate).toBe(false);
    expect(result.originalUploadId).toBeNull();
    expect(result.submittedFilename).toBe('midnight-drive.mp3');
  });

  it('points a duplicate at the upload that already owns the bytes', () => {
    const result = toUploadResult(row({ id: 'original-id', duplicateCount: 1 }), POLICY, {
      duplicate: true,
      submittedFilename: 'Copy of MIDNIGHT (2).MP3',
    });

    expect(result.duplicate).toBe(true);
    expect(result.originalUploadId).toBe('original-id');
    // The pair that makes filename-independence visible in one response.
    expect(result.submittedFilename).toBe('Copy of MIDNIGHT (2).MP3');
    expect(result.upload.filename).toBe('midnight-drive.mp3');
  });

  it('gives a duplicate exactly the same shape as a new upload', () => {
    // A client that ignores `duplicate` still gets something it can parse.
    const created = toUploadResult(row(), POLICY, { duplicate: false, submittedFilename: 'a.mp3' });
    const duplicate = toUploadResult(row(), POLICY, {
      duplicate: true,
      submittedFilename: 'b.mp3',
    });
    expect(Object.keys(created).sort()).toEqual(Object.keys(duplicate).sort());
  });

  it('never leaks the storage path on either path', () => {
    for (const duplicate of [true, false]) {
      const json = JSON.stringify(
        toUploadResult(row(), POLICY, { duplicate, submittedFilename: 'x.mp3' }),
      );
      expect(json).not.toContain('storagePath');
      expect(json).not.toContain('audio/aa/aa');
      expect(json).not.toContain('declaredMime');
    }
  });
});
