/**
 * A single-range parser for the `Range` request header (RFC 9110 §14).
 *
 * Audio players do not download a file and then seek — they seek by asking for
 * byte ranges. Without this, scrubbing a track either does nothing or refetches
 * the whole file, which is the difference between a 200 KB request and a 50 MB
 * one every time someone drags the playhead.
 *
 * Only a single range is honoured. Multi-range responses need
 * `multipart/byteranges`, no audio player asks for them, and a server is
 * explicitly allowed to ignore a `Range` it does not wish to satisfy and reply
 * `200` with the whole body — so that is what a multi-range request gets.
 */
export type ParsedRange =
  | { kind: 'none' }
  | { kind: 'satisfiable'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const BYTES_RANGE = /^bytes=(\d*)-(\d*)$/;

export function parseRangeHeader(header: string | undefined, sizeBytes: number): ParsedRange {
  if (!header) return { kind: 'none' };

  const trimmed = header.trim();

  // An unknown unit ("items=0-9") is not an error; it means we serve the whole
  // representation. Same for a multi-range request.
  if (!/^bytes=/i.test(trimmed)) return { kind: 'none' };
  if (trimmed.includes(',')) return { kind: 'none' };

  const match = BYTES_RANGE.exec(trimmed);
  if (!match) return { kind: 'none' };

  const [, rawStart, rawEnd] = match;
  const hasStart = rawStart !== '';
  const hasEnd = rawEnd !== '';

  // "bytes=-" is malformed, not a range over the whole file.
  if (!hasStart && !hasEnd) return { kind: 'none' };

  // Nothing can satisfy a range over an empty representation.
  if (sizeBytes <= 0) return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;

  if (!hasStart) {
    // Suffix form: "bytes=-500" means the LAST 500 bytes, not "up to 500".
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, sizeBytes - suffixLength);
    end = sizeBytes - 1;
  } else {
    start = Number(rawStart);
    // An end past the last byte is clamped rather than rejected, which is what
    // the spec requires and what every player relies on for "bytes=0-".
    end = hasEnd ? Math.min(Number(rawEnd), sizeBytes - 1) : sizeBytes - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: 'none' };
  if (start >= sizeBytes || start > end) return { kind: 'unsatisfiable' };

  return { kind: 'satisfiable', start, end };
}
