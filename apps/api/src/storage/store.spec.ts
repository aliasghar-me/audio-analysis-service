import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from './store.js';

const HASH = 'a'.repeat(64);

describe('FileStore.relativePathFor', () => {
  const store = new FileStore('/tmp/does-not-need-to-exist');

  it('shards two levels deep by hash prefix', () => {
    const hash = '0123456789abcdef'.repeat(4);
    expect(store.relativePathFor(hash)).toBe(path.join('audio', '01', '23', `${hash}.mp3`));
  });

  it.each([
    ['a filename', 'song.mp3'],
    ['a traversal attempt', '../../etc/passwd'],
    ['a hash with a slash in it', `${'a'.repeat(63)}/`],
    ['uppercase hex', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    // The path is derived from the hash and only the hash. Anything else
    // reaching this function is a bug, so it fails loudly rather than quietly
    // producing a path outside the store.
    expect(() => store.relativePathFor(value)).toThrow(/SHA-256/);
  });
});

describe('FileStore.stage', () => {
  let root: string;
  let store: FileStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'audio-store-'));
    store = new FileStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('hashes, sizes and sniffs in a single pass', async () => {
    const payload = Buffer.from('the quick brown fox jumps over the lazy dog');
    const staged = await store.stage(Readable.from([payload]));

    expect(staged.hash).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(staged.bytes).toBe(payload.length);
    expect(Buffer.from(staged.head).toString()).toBe(payload.subarray(0, 16).toString());
    expect(await readFile(staged.tempPath)).toEqual(payload);
  });

  it('produces the same hash across chunk boundaries', async () => {
    const whole = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789');
    const chunked = await store.stage(
      Readable.from([whole.subarray(0, 5), whole.subarray(5, 9), whole.subarray(9)]),
    );
    const single = await store.stage(Readable.from([whole]));

    expect(chunked.hash).toBe(single.hash);
    expect(chunked.head).toEqual(single.head);
  });

  it('captures a short head without padding it', async () => {
    const staged = await store.stage(Readable.from([Buffer.from('abc')]));
    expect(staged.head).toHaveLength(3);
  });

  it('commits to the content-addressed path and can read it back', async () => {
    const payload = Buffer.from('some audio bytes');
    const staged = await store.stage(Readable.from([payload]));
    const relative = await store.commit(staged.hash, staged.tempPath);

    expect(relative).toBe(store.relativePathFor(staged.hash));
    expect(await store.exists(staged.hash)).toBe(true);
    expect(await readFile(path.join(root, relative))).toEqual(payload);
  });

  it('leaves nothing behind when a staged file is discarded', async () => {
    const staged = await store.stage(Readable.from([Buffer.from('x')]));
    await store.discard(staged.tempPath);
    await expect(readFile(staged.tempPath)).rejects.toThrow();
  });

  it('treats discarding and removing a missing file as a no-op', async () => {
    await expect(store.discard(path.join(root, 'tmp', 'gone.mp3'))).resolves.toBeUndefined();
    await expect(store.remove(HASH)).resolves.toBeUndefined();
  });
});
