/**
 * The API contract, as the browser sees it.
 *
 * These types are hand-mirrored from `apps/api/src/uploads/presenter.ts`. A
 * shared package would remove the duplication and add a build step, a third
 * workspace and an indirection for about thirty lines of interface — not a
 * trade worth making at this size. It is called out in the README as a known
 * cost rather than pretended away.
 */

export interface QualityBreakdown {
  bitrate: number;
  sampleRate: number;
  channels: number;
  encodingMode: number;
  consistency: number;
  total: number;
}

export interface UploadSummary {
  id: string;
  filename: string;
  contentHash: string;
  sizeBytes: number;
  duplicateCount: number;
  createdAt: string;
  lastUploadedAt: string;
}

export interface Analysis {
  duration: {
    ms: number;
    seconds: number;
    formatted: string;
    isOutlier: boolean;
    outlierPolicy: { minSeconds: number; maxSeconds: number };
  };
  quality: {
    score: number;
    max: number;
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
  analysis: Analysis;
}

export interface UploadResult extends UploadView {
  duplicate: boolean;
  submittedFilename: string;
  originalUploadId: string | null;
}

export interface UploadList {
  items: UploadView[];
  nextCursor: string | null;
}

/** The API's error envelope, which every failure uses. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    throw new ApiError(
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `Request failed with ${response.status}`,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('UNKNOWN', `Request failed with ${response.status}`);
  }
}

export async function uploadFile(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  // Same origin: next.config.ts rewrites /api/* to the API service.
  return unwrap<UploadResult>(await fetch('/api/upload', { method: 'POST', body: form }));
}

export async function listUploads(limit = 10): Promise<UploadList> {
  return unwrap<UploadList>(await fetch(`/api/uploads?limit=${limit}`, { cache: 'no-store' }));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
