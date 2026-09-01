import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, uploadRequest, type TestHarness } from '../helpers/app.js';
import { synthesizeMp3 } from '../helpers/synthesize-mp3.js';

/**
 * P0: no stack traces, filesystem paths, credentials or internal field names
 * in any response.
 */

describe('responses leak nothing internal', () => {
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

  const secrets = (h: TestHarness) => [
    'storagePath',
    'storage_path',
    h.storageDir,
    'postgresql://',
    'password',
    'node_modules',
    'Error:',
    '    at ',
  ];

  it('does not expose internals on success', async () => {
    const response = await harness.app.inject(
      uploadRequest(synthesizeMp3({ frames: 240 }), { filename: 'ok.mp3' }),
    );

    expect(response.statusCode).toBe(201);
    for (const secret of secrets(harness)) {
      expect(response.body, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('does not expose a stack trace or a path when the parser rejects a file', async () => {
    const response = await harness.app.inject(
      uploadRequest(Buffer.from('this is definitely not audio'), { filename: 'x.mp3' }),
    );

    expect(response.statusCode).toBe(400);
    for (const secret of secrets(harness)) {
      expect(response.body, `leaked ${secret}`).not.toContain(secret);
    }
    // The public message stays generic; the parser's own message goes to the
    // log via `cause` and never to the client.
    expect(response.json().error.message).toBe('The uploaded file is not a valid MP3 audio file.');
  });
});
