import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from './range.js';

const SIZE = 1000;

describe('parseRangeHeader', () => {
  it('treats a missing header as no range', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('', SIZE)).toEqual({ kind: 'none' });
  });

  it.each([
    ['bytes=0-499', 0, 499],
    ['bytes=500-999', 500, 999],
    ['bytes=0-0', 0, 0],
    ['bytes=999-999', 999, 999],
  ])('parses %s', (header, start, end) => {
    expect(parseRangeHeader(header, SIZE)).toEqual({ kind: 'satisfiable', start, end });
  });

  it('treats an open-ended range as running to the last byte', () => {
    // This is the one every audio player opens with.
    expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({ kind: 'satisfiable', start: 0, end: 999 });
    expect(parseRangeHeader('bytes=750-', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 750,
      end: 999,
    });
  });

  it('reads the suffix form as the LAST n bytes', () => {
    // `bytes=-100` is the final 100 bytes, not the first 100 — getting this
    // backwards is the classic implementation bug.
    expect(parseRangeHeader('bytes=-100', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 900,
      end: 999,
    });
  });

  it('clamps a suffix longer than the file to the whole file', () => {
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 0,
      end: 999,
    });
  });

  it('clamps an end past the last byte rather than rejecting it', () => {
    expect(parseRangeHeader('bytes=0-99999', SIZE)).toEqual({
      kind: 'satisfiable',
      start: 0,
      end: 999,
    });
  });

  it.each([
    ['a start past the end of the file', 'bytes=1000-1500'],
    ['a start exactly at the length', 'bytes=1000-'],
    ['a backwards range', 'bytes=500-100'],
    ['a zero-length suffix', 'bytes=-0'],
  ])('reports %s as unsatisfiable', (_label, header) => {
    expect(parseRangeHeader(header, SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('cannot satisfy any range over an empty representation', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it.each([
    ['an unknown unit', 'items=0-10'],
    ['a multi-range request', 'bytes=0-99,200-299'],
    ['a malformed header', 'bytes=abc-def'],
    ['bare "bytes="', 'bytes='],
    ['no equals sign', 'bytes 0-10'],
    ['a bare dash', 'bytes=-'],
    ['a number too large to be finite', `bytes=${'9'.repeat(400)}-`],
  ])('ignores %s and serves the whole body', (_label, header) => {
    // Ignoring a Range we do not wish to satisfy and replying 200 is explicitly
    // permitted, and is friendlier than a 416 the client cannot act on.
    expect(parseRangeHeader(header, SIZE)).toEqual({ kind: 'none' });
  });
});
