import { AVAILABILITY } from '@repo/events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { RECONCILE_EVERY_ROUNDS, startClaimRenewal } from './claim-renewal.js';

describe('startClaimRenewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('runs a round at start, then one per interval until stopped', async () => {
    const flow = { renewClaims: vi.fn(async () => undefined) };
    const renewal = startClaimRenewal({ flow, log: createFakeLogger() });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.renewClaims).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AVAILABILITY.CLAIM_RENEW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(AVAILABILITY.CLAIM_RENEW_INTERVAL_MS);
    expect(flow.renewClaims).toHaveBeenCalledTimes(3);

    renewal.stop();
    await vi.advanceTimersByTimeAsync(AVAILABILITY.CLAIM_RENEW_INTERVAL_MS);
    expect(flow.renewClaims).toHaveBeenCalledTimes(3);
  });

  test('asks Twilio about the calls in the round at start, and every tenth round after', async () => {
    const flow = {
      renewClaims: vi.fn(
        async (_options?: { reconcile?: boolean }) => undefined,
      ),
    };
    const renewal = startClaimRenewal({
      flow,
      log: createFakeLogger(),
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(2 * RECONCILE_EVERY_ROUNDS * 1000);
    renewal.stop();

    const reconciling = flow.renewClaims.mock.calls.flatMap(
      ([options], round) => (options?.reconcile ? [round] : []),
    );
    expect(reconciling).toEqual([
      0,
      RECONCILE_EVERY_ROUNDS,
      2 * RECONCILE_EVERY_ROUNDS,
    ]);
  });

  test('does not start a round while the previous one is still going', async () => {
    let finish: () => void = () => undefined;
    const flow = {
      renewClaims: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const renewal = startClaimRenewal({
      flow,
      log: createFakeLogger(),
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(flow.renewClaims).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(flow.renewClaims).toHaveBeenCalledTimes(2);
    renewal.stop();
  });

  test('keeps going after a round that failed', async () => {
    const log = createFakeLogger();
    const flow = {
      renewClaims: vi
        .fn(async () => undefined)
        .mockRejectedValueOnce(new Error('Redis is away')),
    };
    const renewal = startClaimRenewal({ flow, log, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(flow.renewClaims).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledOnce();
    renewal.stop();
  });
});
