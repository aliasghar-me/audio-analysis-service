import type { Database } from '../db/client.js';
import type { Upload } from '../generated/client.js';
import type { QualityBreakdown } from '../audio/quality.js';

/**
 * Every Prisma call for uploads, and nowhere else.
 *
 * Not an abstraction over the database — it is still Prisma types in and out —
 * but a single place to read to learn every query this service issues, which is
 * what makes the index choices in schema.prisma reviewable.
 */

export interface NewUpload {
  contentHash: string;
  originalName: string;
  declaredMime: string;
  sizeBytes: number;
  storagePath: string;
  durationMs: number;
  isOutlier: boolean;
  qualityScore: number;
  qualityBreakdown: QualityBreakdown;
  bitrateBps: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  codec: string | null;
  encodingMode: string | null;
}

export class UploadsRepository {
  constructor(private readonly db: Database) {}

  findByContentHash(contentHash: string): Promise<Upload | null> {
    return this.db.upload.findUnique({ where: { contentHash } });
  }

  findById(id: string): Promise<Upload | null> {
    return this.db.upload.findUnique({ where: { id } });
  }

  create(data: NewUpload): Promise<Upload> {
    const { qualityBreakdown, ...rest } = data;
    return this.db.upload.create({
      data: { ...rest, qualityBreakdown: { ...qualityBreakdown } },
    });
  }

  /**
   * Record that these bytes turned up again.
   *
   * A single atomic UPDATE rather than a read-modify-write, so concurrent
   * duplicates of the same file all count.
   */
  registerDuplicate(id: string): Promise<Upload> {
    return this.db.upload.update({
      where: { id },
      data: { duplicateCount: { increment: 1 }, lastUploadedAt: new Date() },
    });
  }

  /**
   * One page, newest first, by keyset rather than offset.
   *
   * Offset pagination re-scans everything it skips and shifts under inserts —
   * and inserts are the one thing this table does constantly.
   */
  listPage(limit: number, cursor?: string): Promise<Upload[]> {
    return this.db.upload.findMany({
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }
}
