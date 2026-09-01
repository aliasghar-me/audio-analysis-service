import type { Upload } from '../generated/client.js';
import type { OutlierPolicy } from '../audio/duration.js';
import { formatDuration } from '../audio/duration.js';
import { QUALITY_SCORE_MAX, type QualityBreakdown } from '../audio/quality.js';

/**
 * The one place a database row becomes API JSON.
 *
 * Having a single function own the contract means `storagePath` cannot leak by
 * accident — a route returning a raw Prisma row would hand clients the internal
 * filesystem layout — and the duplicate response is provably the same shape as
 * the original one, because it is built by the same code.
 */

export interface UploadSummary {
  id: string;
  filename: string;
  contentHash: string;
  sizeBytes: number;
  /** How many times these exact bytes were submitted again after the first. */
  duplicateCount: number;
  createdAt: string;
  lastUploadedAt: string;
}

export interface AnalysisView {
  duration: {
    ms: number;
    seconds: number;
    formatted: string;
    isOutlier: boolean;
    outlierPolicy: OutlierPolicy;
  };
  quality: {
    score: number;
    max: number;
    /** Named so nobody mistakes this for a perceptual measure. */
    basis: 'encoding';
    breakdown: QualityBreakdown;
  };
  format: {
    codec: string | null;
    bitrateBps: number | null;
    sampleRateHz: number | null;
    channels: number | null;
    encodingMode: string | null;
  };
}

export interface UploadView {
  upload: UploadSummary;
  analysis: AnalysisView;
}

export interface UploadResult extends UploadView {
  /** True when these bytes were already on record. */
  duplicate: boolean;
  /** The name this request used, which for a duplicate is usually not
   *  `upload.filename` — that difference is the feature. */
  submittedFilename: string;
  /** The upload these bytes already belong to, or null when they are new. */
  originalUploadId: string | null;
}

export function toUploadSummary(row: Upload): UploadSummary {
  return {
    id: row.id,
    filename: row.originalName,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    duplicateCount: row.duplicateCount,
    createdAt: row.createdAt.toISOString(),
    lastUploadedAt: row.lastUploadedAt.toISOString(),
  };
}

export function toAnalysisView(row: Upload, policy: OutlierPolicy): AnalysisView {
  return {
    duration: {
      ms: row.durationMs,
      seconds: Number((row.durationMs / 1000).toFixed(3)),
      formatted: formatDuration(row.durationMs),
      isOutlier: row.isOutlier,
      outlierPolicy: policy,
    },
    quality: {
      score: row.qualityScore,
      max: QUALITY_SCORE_MAX,
      basis: 'encoding',
      breakdown: row.qualityBreakdown as unknown as QualityBreakdown,
    },
    format: {
      codec: row.codec,
      bitrateBps: row.bitrateBps,
      sampleRateHz: row.sampleRateHz,
      channels: row.channels,
      encodingMode: row.encodingMode,
    },
  };
}

export function toUploadView(row: Upload, policy: OutlierPolicy): UploadView {
  return { upload: toUploadSummary(row), analysis: toAnalysisView(row, policy) };
}

export function toUploadResult(
  row: Upload,
  policy: OutlierPolicy,
  options: { duplicate: boolean; submittedFilename: string },
): UploadResult {
  return {
    duplicate: options.duplicate,
    submittedFilename: options.submittedFilename,
    originalUploadId: options.duplicate ? row.id : null,
    ...toUploadView(row, policy),
  };
}
