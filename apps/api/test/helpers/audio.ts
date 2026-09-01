import { parseBuffer } from 'music-metadata';
import { toFacts, type AudioFacts } from '../../src/audio/metadata.js';

/**
 * Read audio facts straight from a buffer.
 *
 * Test-only. The service always has the upload on disk by this point and uses
 * `readAudioFacts`, so a buffer variant in `src/` would be production code that
 * only tests call — and it would carry a catch that nothing can reach, because
 * `parseBuffer` resolves with an empty format for malformed input rather than
 * throwing. The container check in `toFacts` is what rejects those.
 */
export async function readAudioFactsFromBuffer(buffer: Uint8Array): Promise<AudioFacts> {
  return toFacts(
    await parseBuffer(buffer, { mimeType: 'audio/mpeg' }, { duration: true }),
    buffer.byteLength,
  );
}
