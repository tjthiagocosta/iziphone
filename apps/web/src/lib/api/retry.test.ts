import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { canPassByRetrying, keepAsking, retryDelay } from './retry';

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe('canPassByRetrying', () => {
  test.each([
    ['no answer at all', new TypeError('Failed to fetch')],
    ['something thrown that is not an error', 'offline'],
    ['a timeout', httpError(408, 'Request Timeout')],
    [
      'too many requests',
      httpError(429, 'Rate limit exceeded. Try again in 31 seconds.'),
    ],
    ['a server error', httpError(500, 'Internal Server Error')],
    ['a gateway that lost the server', httpError(502, 'Bad Gateway')],
    ['a server not ready', httpError(503, 'Service Unavailable')],
  ])('%s can pass', (_reason, error) => {
    expect(canPassByRetrying(error)).toBe(true);
  });

  test.each([
    ['a user who is signed out', httpError(401, 'Unauthorized')],
    ['a refusal', httpError(403, 'Forbidden')],
    ['something missing', httpError(404, 'Not Found')],
    ['a request the server will not take', httpError(400, 'Bad Request')],
    [
      'an answer this app cannot read',
      httpError(200, 'The server answered with an unexpected shape'),
    ],
  ])('%s will not pass', (_reason, error) => {
    expect(canPassByRetrying(error)).toBe(false);
  });
});

describe('retryDelay', () => {
  test('waits a second, then twice as long after each failure, up to thirty seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(retryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });
});

describe('keepAsking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('answers as soon as the request does', async () => {
    const request = vi.fn(async () => 'answer');

    await expect(keepAsking(request, () => true)).resolves.toBe('answer');
    expect(request).toHaveBeenCalledOnce();
  });

  test('asks again after a failure that can pass, waiting longer each time', async () => {
    const askedAt: number[] = [];
    const request = vi.fn(async () => {
      askedAt.push(Date.now());
      if (askedAt.length < 4) {
        throw httpError(429, 'Rate limit exceeded. Try again in 31 seconds.');
      }
      return 'answer';
    });

    const answer = keepAsking(request, () => true);
    await vi.advanceTimersByTimeAsync(retryDelay(1) + retryDelay(2));
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(retryDelay(3));

    await expect(answer).resolves.toBe('answer');
    const waits = askedAt
      .slice(1)
      .map((at, i) => at - (askedAt[i] ?? Number.NaN));
    expect(waits).toEqual([retryDelay(1), retryDelay(2), retryDelay(3)]);
  });

  test('fails at once with a failure that will not pass', async () => {
    const refusal = httpError(403, 'Forbidden');
    const request = vi.fn(async (): Promise<string> => {
      throw refusal;
    });

    await expect(keepAsking(request, () => true)).rejects.toBe(refusal);
    expect(request).toHaveBeenCalledOnce();
  });

  test('stops with the last failure once nobody waits for the answer', async () => {
    let wanted = true;
    const failure = httpError(503, 'Service Unavailable');
    const request = vi.fn(async (): Promise<string> => {
      throw failure;
    });

    const answer = keepAsking(request, () => wanted);
    const settled = expect(answer).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(retryDelay(1));
    expect(request).toHaveBeenCalledTimes(2);

    wanted = false;
    await vi.advanceTimersByTimeAsync(retryDelay(30) * 4);

    await settled;
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('does not wait at all when the first failure lands after nobody wants the answer', async () => {
    let wanted = true;
    const failure = new TypeError('Failed to fetch');
    const request = vi.fn(async (): Promise<string> => {
      wanted = false;
      throw failure;
    });

    await expect(keepAsking(request, () => wanted)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
