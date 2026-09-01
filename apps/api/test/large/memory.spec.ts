import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, streamingUploadRequest, type TestHarness } from '../helpers/app.js';
import { streamMp3 } from '../helpers/synthesize-mp3.js';

/**
 * Proof that the service does not hold an upload in memory.
 *
 * This is the only test that would catch someone "simplifying" `store.stage()`
 * back to `part.toBuffer()`, and getting it to mean anything took three tries
 * worth recording:
 *
 *   - `heapUsed` cannot tell the two apart at all. Node Buffers live off-heap,
 *     so it stays around 1 MB whether the body is streamed or buffered.
 *   - `rss` is dominated by page retention. It grew to 113% of the payload
 *     while streaming, so it flags nothing and would fail at random.
 *   - `arrayBuffers` counts the right allocations but reports *uncollected*
 *     ones too, so the absolute number depends on GC timing: the same upload
 *     measured 9 MB in a clean process, 29 MB in a fresh worker, and 51 MB in
 *     a worker that had already streamed four 50 MB files.
 *
 * So the assertion is relative, not absolute. The same payload is buffered and
 * streamed in the same process, moments apart, and the two peaks are compared.
 * Both share whatever GC state the worker is in, which is exactly what makes
 * the comparison stable.
 *
 * The file contains one test for the same reason: Vitest gives every file its
 * own fork, and a worker polluted by earlier uploads reports their remains as
 * this one's growth.
 */
const PAYLOAD = 52_428_800 - 500_000; // just under the 50 MiB cap

/** Peak `arrayBuffers` growth while `work` runs. */
async function peakAllocation(work: () => Promise<void>): Promise<number> {
  globalThis.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const before = process.memoryUsage().arrayBuffers;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  }, 20);

  try {
    await work();
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  } finally {
    clearInterval(sampler);
  }

  return peak - before;
}

describe('memory behaviour under a 50 MB upload', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildTestHarness();
    await harness.truncate();
  });
  afterAll(async () => {
    await harness.close();
  });

  it('costs far less than buffering the same payload would', async () => {
    // The control: what holding this file in memory actually costs. If the
    // service ever regresses to buffering, its cost converges on this.
    const buffered = await peakAllocation(async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of streamMp3({ bytes: PAYLOAD }).stream) chunks.push(chunk as Buffer);
      const whole = Buffer.concat(chunks);
      expect(whole.length).toBeGreaterThan(49_000_000);
    });

    const streamed = await peakAllocation(async () => {
      const response = await harness.app.inject(
        streamingUploadRequest(streamMp3({ bytes: PAYLOAD }).stream),
      );
      expect(response.statusCode).toBe(201);
    });

    const ratio = buffered / streamed;
    expect(
      ratio,
      `buffering peaked at ${(buffered / 1e6).toFixed(1)} MB, streaming at ${(streamed / 1e6).toFixed(1)} MB ` +
        `(${ratio.toFixed(1)}x) for a ${(PAYLOAD / 1e6).toFixed(1)} MB payload`,
    ).toBeGreaterThan(2);

    // And in absolute terms the streamed path must stay clear of one whole copy.
    expect(streamed).toBeLessThan(PAYLOAD);
  });
});
