import { lstat, mkdir, mkdtemp, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

/**
 * P0: whatever a client uploads stays inert data inside one directory.
 *
 * The threat these cover is an upload that becomes *executable* — a `.js` a
 * bundler picks up, a `.php` a webserver runs, a `.sh` something sources — or
 * one that escapes the storage root through a symlink.
 */
describe('uploads are inert data in an isolated directory', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildTestHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.truncate();
  });

  it.each([
    ['javascript', 'payload.js'],
    ['php', 'shell.php'],
    ['a shell script', 'run.sh'],
    ['html', 'page.html'],
    ['a dotfile', '.env'],
    ['a config file', 'next.config.ts'],
  ])('cannot be stored as %s whatever the client calls it', async (_label, filename) => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 200 }), { filename }),
    );

    expect(response.statusCode).toBe(201);

    // The client's name is display metadata. The path is derived from the
    // hash, and the extension is always .mp3.
    const stored = await harness.storedFiles();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/\.mp3$/);
    expect(stored[0]).not.toContain(filename);
  });

  it('writes only inside the storage root, in a hash-shaped tree', async () => {
    await harness.app.inject(uploadRequest(synthesizeMp3({ frames: 210 })));

    const stored = await harness.storedFiles();
    expect(stored).toHaveLength(1);
    // audio/<2 hex>/<2 hex>/<64 hex>.mp3 — nothing else is representable.
    expect(stored[0]).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp3$/);

    const resolved = path.resolve(harness.storageDir, 'audio', stored[0]!);
    expect(resolved.startsWith(path.resolve(harness.storageDir))).toBe(true);
  });

  it('does not write through a symlink planted at the destination', async () => {
    // If an attacker could pre-create the content-addressed path as a symlink
    // pointing somewhere sensitive, a write would follow it. The commit is a
    // `rename`, which replaces the link itself rather than writing through it.
    const mp3 = synthesizeMp3({ frames: 220 });
    const first = await harness.app.inject(uploadRequest(mp3, { filename: 'a.mp3' }));
    const hash = first.json().upload.contentHash;
    await harness.truncate();

    const outside = path.join(harness.storageDir, 'outside-target.txt');
    await writeFile(outside, 'must not be overwritten');

    const target = path.join(harness.storageDir, 'audio', hash.slice(0, 2), hash.slice(2, 4));
    await mkdir(target, { recursive: true });
    const linkPath = path.join(target, `${hash}.mp3`);
    await symlink(outside, linkPath);

    const response = await harness.app.inject(uploadRequest(mp3, { filename: 'b.mp3' }));
    expect(response.statusCode).toBe(201);

    // The symlink was replaced by a real file, and the target is untouched.
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(false);
    expect((await lstat(outside)).size).toBe('must not be overwritten'.length);
  });

  it('leaves nothing executable or unexpected in the storage root', async () => {
    // Its own storage directory: every harness in this process otherwise shares
    // the one from test/setup.ts, and sibling tests plant files in it on
    // purpose. This asserts what the store itself creates, and nothing else.
    const isolated = await buildTestHarness({
      STORAGE_DIR: await mkdtemp(path.join(tmpdir(), 'isolation-')),
    });
    try {
      await isolated.truncate();
      await isolated.app.inject(uploadRequest(synthesizeMp3({ frames: 231 })));

      const entries = (await readdir(isolated.storageDir)).sort();
      // Only the content store and the staging directory are ever created.
      expect(entries).toEqual(['audio', 'tmp']);
    } finally {
      await isolated.close();
    }
  });

  it('never follows a traversal filename out of the root', async () => {
    const sentinel = path.join(harness.storageDir, '..', 'sentinel-must-not-exist.mp3');
    await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 240 }), { filename: '../sentinel-must-not-exist.mp3' }),
    );

    await expect(lstat(sentinel)).rejects.toThrow();
  });
});

describe('archives are never unpacked', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildTestHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.truncate();
  });

  it.each([
    ['a ZIP', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(400)])],
    ['a gzip stream', Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(400)])],
    ['a tar header', Buffer.concat([Buffer.alloc(257), Buffer.from('ustar'), Buffer.alloc(200)])],
    ['a 7z archive', Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf]), Buffer.alloc(400)])],
  ])('rejects %s renamed .mp3 without attempting to read inside it', async (_label, body) => {
    const response = await harness.app.inject(uploadRequest(body, { filename: 'album.mp3' }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_AUDIO');
    expect(await harness.storedFiles()).toHaveLength(0);
    // Nothing was expanded: the storage root holds no extra entries.
    expect(await readdir(harness.storageDir).catch(() => [])).not.toContain('album');
  });
});

describe('log injection through a filename', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildTestHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.truncate();
  });

  it('cannot forge a second log line', async () => {
    // Newlines and carriage returns are control characters, and the sanitizer
    // strips them — a filename can never break out of its JSON string and
    // fake a log record.
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 250 }), {
        filename: 'song.mp3\n{"level":50,"msg":"FAKE ADMIN LOGIN"}\n.mp3',
      }),
    );

    expect(response.statusCode).toBe(201);
    const stored = response.json().upload.filename;
    expect(stored).not.toContain('\n');
    expect(stored).not.toContain('\r');
  });
});

describe('the symlink helper is doing what the test claims', () => {
  // Guards the symlink test above: if `symlink` silently failed, that test
  // would pass without proving anything.
  it('creates a real symlink in the test environment', async () => {
    const harness = await buildTestHarness();
    try {
      const target = path.join(harness.storageDir, 'sym-target.txt');
      const link = path.join(harness.storageDir, 'sym-link.txt');
      await writeFile(target, 'x');
      await symlink(target, link);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(target);
    } finally {
      await harness.close();
    }
  });
});
