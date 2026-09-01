import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { FileStore } from '../storage/store.js';
import { AppError } from '../http/errors.js';
import { UploadsService, sanitizeFilename } from './service.js';
import type { NewUpload, UploadsRepository } from './repository.js';
import type { Upload } from '../generated/client.js';
import { synthesizeMp3 } from '../../test/helpers/synthesize-mp3.js';

/**
 * The storage/database consistency contract, exercised against a real
 * filesystem and a repository that fails on demand.
 *
 * These paths cannot be reached through HTTP without breaking Postgres on
 * purpose, but they are exactly the ones that leave a service quietly corrupt:
 * bytes on disk with no row, or a row pointing at bytes that were deleted out
 * from under it. A stub repository is the only honest way to prove them.
 */

const noopLogger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as FastifyBaseLogger;

function row(overrides: Partial<Upload> = {}): Upload {
  return {
    id: 'row-1',
    contentHash: 'x'.repeat(64),
    originalName: 'existing.mp3',
    declaredMime: 'audio/mpeg',
    sizeBytes: 1,
    storagePath: 'audio/xx/xx/x.mp3',
    durationMs: 1000,
    isOutlier: false,
    qualityScore: 5,
    qualityBreakdown: {},
    bitrateBps: 128000,
    sampleRateHz: 44100,
    channels: 2,
    codec: 'MPEG 1 Layer 3',
    encodingMode: 'CBR',
    duplicateCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastUploadedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Upload;
}

/** A repository whose behaviour each test dictates. */
function stubRepository(behaviour: {
  onCreate?: (data: NewUpload) => Promise<Upload>;
  existing?: Upload | null;
  onFindAfterFailure?: Upload | null;
}) {
  let findCalls = 0;
  const calls = { create: 0, registerDuplicate: 0 };
  const repo = {
    async findByContentHash() {
      findCalls += 1;
      // The first lookup is the fast path; a later one is the post-failure
      // "does a row own these bytes now?" re-check.
      return findCalls === 1
        ? (behaviour.existing ?? null)
        : (behaviour.onFindAfterFailure ?? null);
    },
    async findById() {
      return null;
    },
    async create(data: NewUpload) {
      calls.create += 1;
      if (!behaviour.onCreate) return row({ contentHash: data.contentHash });
      return behaviour.onCreate(data);
    },
    async registerDuplicate(id: string) {
      calls.registerDuplicate += 1;
      return row({ id, duplicateCount: 1 });
    },
    async listPage() {
      return [];
    },
  } as unknown as UploadsRepository;
  return { repo, calls };
}

describe('UploadsService storage/database consistency', () => {
  let root: string;
  let store: FileStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'svc-'));
    store = new FileStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function service(repo: UploadsRepository) {
    return new UploadsService({
      repository: repo,
      store,
      outlierPolicy: { minSeconds: 5, maxSeconds: 600 },
      maxUploadBytes: 50 * 1024 * 1024,
      logger: noopLogger,
    });
  }

  async function stage(svc: UploadsService, mp3 = synthesizeMp3({ frames: 200 })) {
    return svc.stage({
      stream: Readable.from([mp3]),
      filename: 'track.mp3',
      mimetype: 'audio/mpeg',
      wasTruncated: () => false,
    });
  }

  /** Everything under storage/, including the staging directory. */
  async function everything(): Promise<string[]> {
    const found: string[] = [];
    async function walk(dir: string) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else found.push(path.relative(root, full));
      }
    }
    await walk(root);
    return found;
  }

  it('removes the stored bytes when the insert fails, leaving no orphan', async () => {
    const { repo, calls } = stubRepository({
      onCreate: async () => {
        throw new Error('connection terminated unexpectedly');
      },
      onFindAfterFailure: null, // nothing claims these bytes
    });
    const svc = service(repo);

    await expect(svc.finalize(await stage(svc))).rejects.toThrow(/connection terminated/);

    expect(calls.create).toBe(1);
    // The whole point: a failed insert must not leave bytes behind.
    expect(await everything()).toEqual([]);
  });

  it('keeps the stored bytes when a concurrent row already claims them', async () => {
    // A non-P2002 failure, but by the time we re-check, another request has
    // committed a row for this hash. Deleting the file would break that row.
    const winner = row({ id: 'winner' });
    const { repo } = stubRepository({
      onCreate: async () => {
        throw new Error('some other database failure');
      },
      onFindAfterFailure: winner,
    });
    const svc = service(repo);

    await expect(svc.finalize(await stage(svc))).rejects.toThrow(/some other database failure/);

    const left = await everything();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^audio\//);
  });

  it('treats a unique-constraint violation as a duplicate and keeps the file', async () => {
    const winner = row({ id: 'winner', duplicateCount: 0 });
    const { repo, calls } = stubRepository({
      onCreate: async () => {
        throw Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['contentHash'] },
        });
      },
      onFindAfterFailure: winner,
    });
    const svc = service(repo);

    const outcome = await svc.finalize(await stage(svc));

    expect(outcome.created).toBe(false);
    expect(outcome.result.duplicate).toBe(true);
    expect(outcome.result.originalUploadId).toBe('winner');
    expect(calls.registerDuplicate).toBe(1);

    // The winner's row addresses exactly these bytes — deleting them here is
    // the subtle way to corrupt a working upload.
    const left = await everything();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^audio\//);
  });

  it('leaves no staged file behind on a successful insert', async () => {
    const { repo } = stubRepository({});
    const svc = service(repo);

    await svc.finalize(await stage(svc));

    const left = await everything();
    expect(left.every((f) => !f.startsWith('tmp'))).toBe(true);
    expect(left).toHaveLength(1);
  });

  it('short-circuits a known hash without storing or analysing again', async () => {
    const { repo, calls } = stubRepository({ existing: row({ id: 'already-here' }) });
    const svc = service(repo);

    const outcome = await svc.finalize(await stage(svc));

    expect(outcome.created).toBe(false);
    expect(outcome.result.originalUploadId).toBe('already-here');
    expect(calls.create).toBe(0);
    // Nothing was committed to the content store: the bytes are already there
    // under the original upload, and the staged copy is discarded.
    expect(await everything()).toEqual([]);
  });

  it('discards the staged file when a cheap check rejects the upload', async () => {
    const { repo } = stubRepository({});
    const svc = service(repo);

    await expect(
      svc.stage({
        stream: Readable.from([Buffer.from('this is not audio')]),
        filename: 'fake.mp3',
        mimetype: 'audio/mpeg',
        wasTruncated: () => false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIO' });

    expect(await everything()).toEqual([]);
  });

  it('rejects a truncated upload and stores nothing', async () => {
    const { repo } = stubRepository({});
    const svc = service(repo);

    await expect(
      svc.stage({
        stream: Readable.from([synthesizeMp3({ frames: 50 })]),
        filename: 'big.mp3',
        mimetype: 'audio/mpeg',
        wasTruncated: () => true,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });

    expect(await everything()).toEqual([]);
  });

  it('rejects an empty upload and stores nothing', async () => {
    const { repo } = stubRepository({});
    const svc = service(repo);

    await expect(
      svc.stage({
        stream: Readable.from([Buffer.alloc(0)]),
        filename: 'empty.mp3',
        mimetype: 'audio/mpeg',
        wasTruncated: () => false,
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await everything()).toEqual([]);
  });
});

describe('sanitizeFilename', () => {
  it.each([
    ['song.mp3', 'song.mp3'],
    ['../../etc/passwd.mp3', 'passwd.mp3'],
    ['../../../../../../etc/shadow.mp3', 'shadow.mp3'],
    ['..\\..\\windows\\system32.mp3', 'system32.mp3'],
    ['/etc/passwd.mp3', 'passwd.mp3'],
    ['dir/sub/track.mp3', 'track.mp3'],
    ['chanson-café.mp3', 'chanson-café.mp3'],
    ['歌曲.mp3', '歌曲.mp3'],
    ['🎵.mp3', '🎵.mp3'],
    ["'; DROP TABLE uploads;--.mp3", "'; DROP TABLE uploads;--.mp3"],
    ['song', 'song'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('a bc.mp3')).toBe('abc.mp3');
    expect(sanitizeFilename('line\nbreak.mp3')).toBe('linebreak.mp3');
  });

  it('clamps to 255 characters', () => {
    expect(sanitizeFilename(`${'a'.repeat(400)}.mp3`)).toHaveLength(255);
  });

  it('falls back for names that reduce to nothing', () => {
    expect(sanitizeFilename(undefined)).toBe('upload.mp3');
    expect(sanitizeFilename('')).toBe('upload.mp3');
    expect(sanitizeFilename('.')).toBe('upload.mp3');
    expect(sanitizeFilename('..')).toBe('upload.mp3');
    expect(sanitizeFilename('/')).toBe('upload.mp3');
  });
});
