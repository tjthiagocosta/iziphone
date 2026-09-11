/** One list being read newest-first, and how far it has got. */
export interface LoadedRange {
  /** The oldest instant loaded so far, or null when nothing is loaded. */
  oldest: number | null;
  /** Nothing older than `oldest` is left to fetch. */
  exhausted: boolean;
}

/**
 * The oldest instant two or more lists can be shown down to without a hole.
 *
 * Merging lists that page separately is where this bites: a list with pages
 * left could still produce something older than its own oldest loaded entry
 * but newer than another list's, and inserting that later would push rows in
 * above ones the reader has already passed. Stopping at the newest of the
 * unfinished boundaries keeps every later page strictly below what is on
 * screen. A list that has loaded nothing and has pages left could produce
 * anything, so nothing can be shown yet.
 */
export function watermarkOf(ranges: readonly LoadedRange[]): number {
  let watermark = Number.NEGATIVE_INFINITY;

  for (const range of ranges) {
    if (range.exhausted) {
      continue;
    }

    if (range.oldest === null) {
      return Number.POSITIVE_INFINITY;
    }

    watermark = Math.max(watermark, range.oldest);
  }

  return watermark;
}
