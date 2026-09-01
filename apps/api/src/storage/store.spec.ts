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

  it('stops capturing once the head is full', async () => {
    // Chunks keep arriving after the 16-byte head is satisfied; the capture
    // must ignore them rather than growing.
    const chunks = Array.from({ length: 12 }, (_, i) => Buffer.from(`chunk${i}-`));
    const staged = await store.stage(Readable.from(chunks));
    const whole = Buffer.concat(chunks);

    expect(staged.head).toHaveLength(16);
    expect(Buffer.from(staged.head)).toEqual(whole.subarray(0, 16));
    expect(staged.bytes).toBe(whole.length);
    expect(staged.hash).toBe(createHash('sha256').update(whole).digest('hex'));
  });

  it('reads back only the requested byte range', async () => {
    const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const staged = await store.stage(Readable.from([payload]));
    await store.commit(staged.hash, staged.tempPath);

    const slice: Buffer[] = [];
    for await (const chunk of store.openRead(staged.hash, { start: 10, end: 19 })) {
      slice.push(chunk as Buffer);
    }
    expect(Buffer.concat(slice)).toEqual(payload.subarray(10, 20));
  });

  it('reports a hash it has never stored as absent', async () => {
    expect(await store.exists('b'.repeat(64))).toBe(false);
  });

  it('propagates a real failure to remove stored bytes', async () => {
    const { mkdir } = await import('node:fs/promises');
    const hash = 'c'.repeat(64);
    // A non-empty directory where the file should be: `rm` without `recursive`
    // refuses, which is exactly the class of failure the caller must hear about.
    await mkdir(path.join(store.absolutePathFor(hash), 'nested'), { recursive: true });
    await expect(store.remove(hash)).rejects.toThrow();
  });

  it('treats removing a hash that was never stored as a no-op', async () => {
    await expect(store.remove('d'.repeat(64))).resolves.toBeUndefined();
  });

  it('propagates a real removal failure instead of hiding it', async () => {
    // `force: true` already makes a missing file a no-op, so anything that does
    // throw is a genuine problem the caller has to hear about.
    await expect(store.discard(root)).rejects.toThrow();
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
