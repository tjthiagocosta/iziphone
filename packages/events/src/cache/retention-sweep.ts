/*
 * The lock the recording retention sweep takes before it runs. Only the API
 * sweeps; the key is declared here so that every Redis key prefix has one
 * home.
 *
 *   recordings:retention:sweep -> the instance currently sweeping
 */

export const RETENTION_SWEEP_LOCK = {
  KEY: 'recordings:retention:sweep',
  /**
   * Longer than a run takes, shorter than the interval between runs, so an
   * instance that dies mid-sweep holds nobody up until the next hour. The
   * holder deletes the key when it finishes, and never deletes another
   * holder's.
   */
  TTL_SECONDS: 15 * 60,
} as const;
