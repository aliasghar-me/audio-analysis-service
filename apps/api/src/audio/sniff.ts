/**
 * Content-based MP3 detection.
 *
 * The filename and the declared Content-Type are strings the client wrote —
 * `curl -F "file=@virus.exe;filename=song.mp3;type=audio/mpeg"` satisfies both.
 * They are recorded for audit and never used to make a decision. This is the
 * first of the two checks that actually look at the bytes.
 *
 * It is a cheap GATE, not a validator: it reads four bytes and cannot know
 * whether a second frame follows. Its job is to reject a 50 MB text file before
 * we pay for a full parse. `music-metadata` is the real validator.
 */

/** Enough bytes for an ID3 signature or a frame header. */
export const SNIFF_BYTES = 16;

export function isMp3(head: Uint8Array): boolean {
  return hasId3Tag(head) || hasFrameSync(head);
}

/** ID3v2 tag: the literal "ID3" plus a sane major-version byte. */
export function hasId3Tag(head: Uint8Array): boolean {
  if (head.length < 4) return false;
  return head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 && head[3]! < 0xff;
}

/**
 * A raw MPEG audio frame header.
 *
 * Eleven sync bits, then a version field where 0b01 is reserved and a layer
 * field where 0b00 is reserved. Testing for those two reserved values is what
 * separates a real header from two bytes that happen to be 0xFF 0xFF — a plain
 * "second byte starts with 0xE" check would accept garbage and reject the
 * MPEG-2.5 files it was meant to allow.
 */
export function hasFrameSync(head: Uint8Array): boolean {
  if (head.length < 2) return false;
  const b0 = head[0]!;
  const b1 = head[1]!;

  if (b0 !== 0xff) return false;
  if ((b1 & 0xe0) !== 0xe0) return false;

  const version = (b1 >> 3) & 0x03;
  if (version === 0x01) return false; // reserved

  const layer = (b1 >> 1) & 0x03;
  if (layer === 0x00) return false; // reserved

  return true;
}
