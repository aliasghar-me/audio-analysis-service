import { describe, expect, it } from 'vitest';
import { formatDuration, isDurationOutlier, type OutlierPolicy } from './duration.js';

describe('formatDuration', () => {
  it.each([
    [0, '00:00'],
    [1_000, '00:01'],
    [59_000, '00:59'],
    [60_000, '01:00'],
    [213_440, '03:33'],
    [599_000, '09:59'],
    [3_599_000, '59:59'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('rounds to the nearest second rather than truncating', () => {
    expect(formatDuration(59_400)).toBe('00:59');
    expect(formatDuration(59_600)).toBe('01:00');
  });

  it('switches to h:mm:ss at one hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_800_000)).toBe('1:03:20');
  });

  it('never renders a negative duration', () => {
    expect(formatDuration(-5_000)).toBe('00:00');
  });
});

describe('isDurationOutlier', () => {
  const policy: OutlierPolicy = { minSeconds: 5, maxSeconds: 600 };

  it.each([
    [4_999, true, 'just under the floor'],
    [5_000, false, 'exactly the floor'],
    [213_440, false, 'a normal song'],
    [600_000, false, 'exactly the ceiling'],
    [600_001, true, 'just over the ceiling'],
  ])('%ims -> %s (%s)', (ms, expected) => {
    expect(isDurationOutlier(ms, policy)).toBe(expected);
  });

  it('honours a custom policy', () => {
    expect(isDurationOutlier(20_000, { minSeconds: 30, maxSeconds: 600 })).toBe(true);
    expect(isDurationOutlier(20_000, { minSeconds: 5, maxSeconds: 600 })).toBe(false);
  });
});
