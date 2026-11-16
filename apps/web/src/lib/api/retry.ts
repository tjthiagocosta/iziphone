/*
 * When a request to our servers that failed is worth making again, and how
 * long to wait first. Everyone behind one office address shares the API's
 * rate limit, so a spent limit or a restarting server must hold a user up
 * for a while, not until they reload.
 */

const FIRST_WAIT_MS = 1000;
const LONGEST_WAIT_MS = 30_000;

/**
 * Whether a request that failed this way may succeed if it is made again. No
 * answer at all, a timeout, too many requests and a server error can all
 * pass. Any other refusal, a 401 for a user who is signed out among them,
 * would only be given again, and so would an answer this app cannot read.
 */
export function canPassByRetrying(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('status' in error) ||
    typeof error.status !== 'number'
  ) {
    return true;
  }
  const { status } = error;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * How long to wait before trying again after `failures` failed tries in a
 * row: a second after the first, twice as long after each one more, never
 * longer than thirty seconds.
 */
export function retryDelay(failures: number): number {
  return Math.min(
    FIRST_WAIT_MS * 2 ** Math.max(failures - 1, 0),
    LONGEST_WAIT_MS,
  );
}

/**
 * Makes `request` until it answers or fails in a way that will not pass,
 * waiting `retryDelay` after each failure that can. Once `stillWanted` says
 * nobody waits for the answer any more, it stops and fails with the last
 * failure instead of asking again.
 */
export async function keepAsking<T>(
  request: () => Promise<T>,
  stillWanted: () => boolean,
): Promise<T> {
  for (let failures = 1; ; failures += 1) {
    try {
      return await request();
    } catch (error) {
      if (!canPassByRetrying(error) || !stillWanted()) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(failures)));
      if (!stillWanted()) {
        throw error;
      }
    }
  }
}
