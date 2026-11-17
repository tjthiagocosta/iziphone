/**
 * The page to load instead of one the list no longer reaches, once the last
 * number on it was released or moved out of the filter; null while the page
 * asked for still exists.
 */
export function lastPageIfPastEnd(
  requested: number,
  totalPages: number,
): number | null {
  return requested > 1 && requested > totalPages
    ? Math.max(totalPages, 1)
    : null;
}
