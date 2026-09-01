/**
 * The window outside which a duration is flagged. A policy, not a discovered
 * truth — see the README for why this is fixed rather than statistical.
 */
export interface OutlierPolicy {
  minSeconds: number;
  maxSeconds: number;
}

/**
 * `mm:ss`, or `h:mm:ss` once the file is an hour or longer.
 *
 * Rounds to the nearest second, so a 59.6 s file reads `01:00` rather than
 * `00:59`. Minutes are zero-padded to two digits; hours are not, because
 * `1:03:20` is how people write it.
 */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * A file is an outlier when it is shorter than the floor or longer than the
 * ceiling. Both bounds are inclusive of the accepted range: exactly 5 s and
 * exactly 600 s are normal, 4.999 s and 600.001 s are not.
 */
export function isDurationOutlier(durationMs: number, policy: OutlierPolicy): boolean {
  const seconds = durationMs / 1000;
  return seconds < policy.minSeconds || seconds > policy.maxSeconds;
}
