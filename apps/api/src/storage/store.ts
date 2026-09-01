import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { SNIFF_BYTES } from '../audio/sniff.js';

/**
 * Content-addressed storage on the local filesystem.
 *
 * Everything in this service that touches `fs` lives here. Two consequences
 * worth stating: the path of a file is a pure function of its bytes, so
 * identical uploads cannot occupy two slots even if the database were wrong,
 * and swapping this for S3 is one file's blast radius because nothing outside
 * this module imports `node:fs`.
 */

export interface StagedFile {
  /** Lowercase hex SHA-256 of everything that was written. */
  hash: string;
  bytes: number;
  tempPath: string;
  /** The first bytes, captured during the same pass, for magic-byte sniffing. */
  head: Uint8Array;
}

/** Capture the first `limit` bytes as they flow past, copying nothing extra. */
function captureHead(limit: number, onDone: (head: Uint8Array) => void): Transform {
  const chunks: Buffer[] = [];
  let captured = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (captured < limit) {
        const slice = chunk.subarray(0, limit - captured);
        chunks.push(Buffer.from(slice));
        captured += slice.length;
      }
      callback(null, chunk);
    },
    flush(callback) {
      onDone(Uint8Array.from(Buffer.concat(chunks)));
      callback();
    },
  });
}

/** Hash bytes as they flow past. */
function hashStream(onDone: (hex: string) => void): Transform {
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      onDone(hash.digest('hex'));
      callback();
    },
  });
}

const HEX_64 = /^[0-9a-f]{64}$/;

export class FileStore {
  constructor(private readonly rootDir: string) {}

  /**
   * The path a hash maps to, relative to the storage root.
   *
   * Sharded two levels so no single directory accumulates millions of entries.
   * The hash is validated rather than trusted: it is the only thing that ever
   * reaches a path, and a caller passing a filename here would be a traversal
   * bug, so make it impossible instead of documenting it.
   */
  relativePathFor(hash: string): string {
    if (!HEX_64.test(hash)) {
      throw new Error(`Not a SHA-256 hex digest: ${JSON.stringify(hash)}`);
    }
    return path.join('audio', hash.slice(0, 2), hash.slice(2, 4), `${hash}.mp3`);
  }

  absolutePathFor(hash: string): string {
    return path.join(this.rootDir, this.relativePathFor(hash));
  }

  /**
   * Stream an upload to a temporary file, hashing and sniffing in one pass.
   *
   * Streaming rather than buffering: the hash has to be known before we can
   * decide whether the bytes are worth keeping, and holding a 50 MB body per
   * concurrent request in memory is the first thing that falls over under load.
   * The temp file lands on the same filesystem as the content store, which is
   * what makes `commit` an atomic rename.
   */
  async stage(source: Readable): Promise<StagedFile> {
    const tempDir = path.join(this.rootDir, 'tmp');
    await mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${randomUUID()}.mp3`);

    let hash = '';
    let head: Uint8Array = new Uint8Array(0);

    await pipeline(
      source,
      captureHead(SNIFF_BYTES, (value) => {
        head = value;
      }),
      hashStream((value) => {
        hash = value;
      }),
      createWriteStream(tempPath),
    );

    const { size } = await stat(tempPath);
    return { hash, bytes: size, tempPath, head };
  }

  /**
   * Move staged bytes to their permanent, content-addressed home.
   *
   * `rename` is atomic within a filesystem, so a partially written file is
   * never visible at the final path. If something is already there it is
   * byte-identical by construction — same hash, same content — so replacing it
   * is a no-op in every sense that matters.
   */
  async commit(hash: string, tempPath: string): Promise<string> {
    const relative = this.relativePathFor(hash);
    const absolute = path.join(this.rootDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await rename(tempPath, absolute);
    return relative;
  }

  /**
   * Remove a staged file. `force` means a missing file is not an error, but a
   * genuine failure (a permission problem, say) propagates — swallowing it here
   * as well as in the caller would mean nothing ever reports it.
   */
  async discard(tempPath: string): Promise<void> {
    await rm(tempPath, { force: true });
  }

  /**
   * Remove stored bytes. Used only to clean up after a failed insert.
   *
   * Propagates like `discard` does: the caller is cleaning up inside a `catch`
   * and is the only one who knows that losing the original error to a cleanup
   * failure would be worse than the cleanup failure itself.
   */
  async remove(hash: string): Promise<void> {
    await rm(this.absolutePathFor(hash), { force: true });
  }

  async exists(hash: string): Promise<boolean> {
    try {
      await stat(this.absolutePathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read stored bytes, optionally just a slice of them.
   *
   * `createReadStream` seeks to `start` rather than reading and discarding, so
   * serving the tail of a 50 MB file costs the same as serving the head.
   */
  openRead(hash: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.absolutePathFor(hash), range);
  }
}
