import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { readAudioFacts, storableBitrate } from '../audio/metadata.js';
import { isDurationOutlier, type OutlierPolicy } from '../audio/duration.js';
import { scoreQuality } from '../audio/quality.js';
import { isMp3 } from '../audio/sniff.js';
import { AppError, isUniqueViolation } from '../http/errors.js';
import type { FileStore, StagedFile } from '../storage/store.js';
import type { UploadsRepository } from './repository.js';
import { toUploadResult, type UploadResult } from './presenter.js';

export interface IngestRequest {
  stream: Readable;
  filename: string | undefined;
  mimetype: string | undefined;
  /** Whether the multipart layer cut the stream short at the size limit. */
  wasTruncated: () => boolean;
}

/**
 * An upload whose bytes are on disk under a temporary name and have passed the
 * cheap checks, but which has not been analysed, stored or recorded yet.
 *
 * Staging is a separate step so the route can finish reading the multipart body
 * — and reject a request carrying a second file — before anything is committed.
 * Doing the whole ingest inline would insert a row for the first file and only
 * then discover the request was invalid.
 */
export interface StagedUpload {
  file: StagedFile;
  submittedFilename: string;
  declaredMime: string;
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
   * Read the body to disk and apply the cheap rejections.
   *
   * Streaming rather than buffering: the hash has to be known before we can
   * decide whether the bytes are worth keeping, and holding a 50 MB body per
   * concurrent request in memory is the first thing that falls over under load.
   */
  async stage(request: IngestRequest): Promise<StagedUpload> {
    const { store, maxUploadBytes } = this.deps;
    const submittedFilename = sanitizeFilename(request.filename);
    const declaredMime = (request.mimetype ?? 'application/octet-stream').slice(0, 127);

    const file = await store.stage(request.stream);

    try {
      // Busboy ends a stream that hits the size limit rather than erroring, so
      // without this check we would happily hash and store a prefix.
      if (request.wasTruncated()) {
        throw new AppError('FILE_TOO_LARGE', 'The uploaded file exceeds the size limit.', {
          maxBytes: maxUploadBytes,
        });
      }

      if (file.bytes === 0) {
        throw new AppError('EMPTY_FILE', 'The uploaded file is empty.');
      }

      // Cheap gate before the expensive parse. The filename and the declared
      // MIME type are client-supplied strings and decide nothing.
      if (!isMp3(file.head)) {
        throw new AppError('INVALID_AUDIO', 'The uploaded file is not a valid MP3 audio file.', {
          reason: 'magic_bytes',
        });
      }
    } catch (error) {
      await this.discard({ file, submittedFilename, declaredMime });
      throw error;
    }

    return { file, submittedFilename, declaredMime };
  }

  /** Drop staged bytes that will never be committed. Never throws. */
  async discard(staged: StagedUpload): Promise<void> {
    await this.deps.store.discard(staged.file.tempPath).catch((error: unknown) => {
      this.deps.logger.warn(
        { err: error, tempPath: staged.file.tempPath },
        'failed to clean up staged upload',
      );
    });
  }

  /**
   * Analyse, store and record a staged upload. The order of these steps is the
   * design:
   *
   *   duplicate short-circuit → parse → analyse → commit bytes → insert row
   *
   * Hashing before parsing (done in `stage`) is what makes a duplicate the
   * cheapest possible path: no re-analysis, and not one byte written twice.
   * Committing bytes before inserting the row is a deliberate choice of failure
   * mode — a file with no row is invisible garbage that the next identical
   * upload reclaims, whereas a row with no file is a broken record served to
   * clients.
   */
  async finalize(staged: StagedUpload): Promise<IngestOutcome> {
    const { repository, store, outlierPolicy, logger } = this.deps;
    const { file, submittedFilename, declaredMime } = staged;

    try {
      const existing = await repository.findByContentHash(file.hash);
      if (existing) {
        const updated = await repository.registerDuplicate(existing.id);
        return {
          created: false,
          result: toUploadResult(updated, outlierPolicy, { duplicate: true, submittedFilename }),
        };
      }

      const facts = await readAudioFacts(file.tempPath, file.bytes);
      const isOutlier = isDurationOutlier(facts.durationMs, outlierPolicy);
      const quality = scoreQuality({
        bitrateBps: facts.bitrateBps,
        sampleRateHz: facts.sampleRateHz,
        channels: facts.channels,
        encodingMode: facts.encodingMode,
        sizeBytes: file.bytes,
        durationMs: facts.durationMs,
      });

      const storagePath = await store.commit(file.hash, file.tempPath);

      try {
        const row = await repository.create({
          contentHash: file.hash,
          originalName: submittedFilename,
          declaredMime,
          sizeBytes: file.bytes,
          storagePath,
          durationMs: Math.round(facts.durationMs),
          isOutlier,
          qualityScore: quality.score,
          qualityBreakdown: quality.breakdown,
          bitrateBps: storableBitrate(facts.bitrateBps),
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
          const winner = await repository.findByContentHash(file.hash);
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
        const claimed = await repository.findByContentHash(file.hash).catch(() => null);
        if (!claimed) {
          // Swallowed deliberately: this runs inside a catch, and losing the
          // real failure to a secondary cleanup error would hide why the
          // upload failed at all. The orphan is logged and reclaimed by the
          // next upload of the same bytes.
          await store.remove(file.hash).catch((cleanupError: unknown) => {
            logger.warn(
              { err: cleanupError, contentHash: file.hash },
              'failed to remove orphaned upload after a failed insert',
            );
          });
        }
        throw error;
      }
    } finally {
      // Covers every rejection path above; a successful commit has already
      // renamed the file away, so this is a no-op there.
      await this.discard(staged);
    }
  }
}
