import { describe, expect, it } from 'vitest';
import { isMp3 } from './sniff.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('isMp3', () => {
  it('accepts an ID3v2 tag', () => {
    expect(isMp3(bytes(0x49, 0x44, 0x33, 0x03, 0x00, 0x00))).toBe(true);
  });

  it.each([
    ['MPEG-1 Layer III, no CRC', 0xfb],
    ['MPEG-1 Layer III, with CRC', 0xfa],
    ['MPEG-2 Layer III', 0xf3],
    ['MPEG-2 Layer II', 0xf5],
    ['MPEG-2.5 Layer III', 0xe3],
  ])('accepts a raw frame sync: %s', (_label, second) => {
    expect(isMp3(bytes(0xff, second, 0x90, 0x00))).toBe(true);
  });

  it.each([
    ['reserved MPEG version', bytes(0xff, 0xeb, 0x90, 0x00)],
    ['reserved layer', bytes(0xff, 0xf9, 0x90, 0x00)],
    ['incomplete sync bits', bytes(0xff, 0xc0, 0x90, 0x00)],
    ['ASCII text', new TextEncoder().encode('this is not audio')],
    ['a PNG signature', bytes(0x89, 0x50, 0x4e, 0x47)],
    ['empty', new Uint8Array(0)],
    ['a single byte', bytes(0xff)],
  ])('rejects %s', (_label, head) => {
    expect(isMp3(head)).toBe(false);
  });

  it('accepts an ID3 header followed by garbage', () => {
    // Documents the boundary of this check on purpose: sniffing is a gate, and
    // this file is rejected one step later by the parser, not here.
    expect(isMp3(new TextEncoder().encode('ID3 nonsense'))).toBe(true);
  });
});
