import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { readAudioFacts } from '../audio/metadata.js';
import { isDurationOutlier, type OutlierPolicy } from '../audio/duration.js';
import { scoreQuality } from '../audio/quality.js';
import { isMp3 } from '../audio/sniff.js';
import { AppError, isUniqueViolation } from '../http/errors.js';
import type { FileStore } from '../storage/store.js';
import type { UploadsRepository } from './repository.js';
import { toUploadResult, type UploadResult } from './presenter.js';

export interface IngestRequest {
  stream: Readable;
  filename: string | undefined;
  mimetype: string | undefined;
  /** Whether the multipart layer cut the stream short at the size limit. */
  wasTruncated: () => boolean;
}

export interface IngestOutcome {
  /** 201 when a row was created, 200 when these bytes were already on record. */
  created: boolean;
  result: UploadResult;
}

export interface UploadsServiceDeps {
  repository: UploadsRepository;
  store: FileStore;
  outlierPolicy: OutlierPolicy;
  maxUploadBytes: number;
  logger: FastifyBaseLogger;
}

/**
 * Reduce a client-supplied filename to something safe to store and display.
 *
 * It never reaches a filesystem path — those are derived from the content hash
 * — but it is still rendered in a UI and written to the database, so strip the
 * directory components, the control characters, and cap the length.
 */
export function sanitizeFilename(filename: string | undefined): string {
  // Backslashes too: path.basename does not treat them as separators on posix,
  // and a Windows client will happily send `C:\\Users\\me\\song.mp3`.
  const raw = (filename ?? '').replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  const base = path.basename(raw).replace(/[\u0000-\u001f\u007f]/g, '');
  const trimmed = base.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return 'upload.mp3';
  return trimmed.slice(0, 255);
}

export class UploadsService {
  constructor(private readonly deps: UploadsServiceDeps) {}

  /**
   * The upload pipeline. The order of these steps is the design:
   *
   *   stream + hash → size checks → sniff → duplicate short-circuit → parse →
   *   analyse → commit bytes → insert row
   *
   * Hashing before parsing is what makes a duplicate the cheapest possible
   * path: no re-analysis, and not one byte written twice. Committing bytes
   * before inserting the row is a deliberate choice of failure mode — a file
   * with no row is invisible garbage that the next identical upload reclaims,
   * whereas a row with no file is a broken record served to clients.
   */
  async ingest(request: IngestRequest): Promise<IngestOutcome> {
    const { repository, store, outlierPolicy, maxUploadBytes, logger } = this.deps;
    const submittedFilename = sanitizeFilename(request.filename);
    const declaredMime = (request.mimetype ?? 'application/octet-stream').slice(0, 127);

    const staged = await store.stage(request.stream);

    try {
      // Busboy ends a stream that hits the size limit rather than erroring, so
      // without this check we would happily hash and store a prefix.
      if (request.wasTruncated()) {
        throw new AppError('FILE_TOO_LARGE', 'The uploaded file exceeds the size limit.', {
          maxBytes: maxUploadBytes,
        });
      }

      if (staged.bytes === 0) {
        throw new AppError('EMPTY_FILE', 'The uploaded file is empty.');
      }

      // Cheap gate before the expensive parse. The filename and the declared
      // MIME type are client-supplied strings and decide nothing.
      if (!isMp3(staged.head)) {
        throw new AppError('INVALID_AUDIO', 'The uploaded file is not a valid MP3 audio file.', {
          reason: 'magic_bytes',
        });
      }

      const existing = await repository.findByContentHash(staged.hash);
      if (existing) {
        const updated = await repository.registerDuplicate(existing.id);
        return {
          created: false,
          result: toUploadResult(updated, outlierPolicy, { duplicate: true, submittedFilename }),
        };
      }

      const facts = await readAudioFacts(staged.tempPath, staged.bytes);
      const isOutlier = isDurationOutlier(facts.durationMs, outlierPolicy);
      const quality = scoreQuality({
        bitrateBps: facts.bitrateBps,
        sampleRateHz: facts.sampleRateHz,
        channels: facts.channels,
        encodingMode: facts.encodingMode,
        sizeBytes: staged.bytes,
        durationMs: facts.durationMs,
      });

      const storagePath = await store.commit(staged.hash, staged.tempPath);

      try {
        const row = await repository.create({
          contentHash: staged.hash,
          originalName: submittedFilename,
          declaredMime,
          sizeBytes: staged.bytes,
          storagePath,
          durationMs: Math.round(facts.durationMs),
          isOutlier,
          qualityScore: quality.score,
          qualityBreakdown: quality.breakdown,
          // A real VBR file reports a fractional average bitrate (a LAME V2
          // encode measures 96227.979… bps). The column is an integer, and
          // relying on the driver to truncate it silently is not a decision
          // this code should be delegating. Sub-bit-per-second precision is
          // meaningless anyway; the score uses the unrounded value.
          bitrateBps: facts.bitrateBps === null ? null : Math.round(facts.bitrateBps),
          sampleRateHz: facts.sampleRateHz,
          channels: facts.channels,
          codec: facts.codec,
          encodingMode: facts.encodingMode,
        });

        return {
          created: true,
          result: toUploadResult(row, outlierPolicy, { duplicate: false, submittedFilename }),
        };
      } catch (error) {
        // A concurrent request with identical bytes got there first. The
        // constraint, not the lookup above, is what makes this impossible to
        // get wrong: both requests converge on the same duplicate response.
        if (isUniqueViolation(error, 'contentHash')) {
          const winner = await repository.findByContentHash(staged.hash);
          if (winner) {
            const updated = await repository.registerDuplicate(winner.id);
            return {
              created: false,
              result: toUploadResult(updated, outlierPolicy, {
                duplicate: true,
                submittedFilename,
              }),
            };
          }
        }

        // Any other insert failure leaves bytes on disk with nothing pointing
        // at them. Re-check before deleting: if a row does exist, those bytes
        // belong to it and removing them would break a working upload.
        //
        // Note the deliberate asymmetry with the branch above — a P2002 loser
        // must NOT delete the file, because the winner's row addresses exactly
        // these bytes.
        const claimed = await repository.findByContentHash(staged.hash).catch(() => null);
        if (!claimed) {
          await store.remove(staged.hash);
        }
        throw error;
      }
    } finally {
      // Covers every rejection path above; a successful commit has already
      // renamed the file away, so this is a no-op there.
      await store.discard(staged.tempPath).catch((error: unknown) => {
        logger.warn({ err: error, tempPath: staged.tempPath }, 'failed to clean up staged upload');
      });
    }
  }
}
