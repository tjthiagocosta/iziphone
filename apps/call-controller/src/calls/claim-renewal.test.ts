import { AVAILABILITY } from '@repo/events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { RECONCILE_EVERY_ROUNDS, startClaimRenewal } from './claim-renewal.js';

const INTERVAL = AVAILABILITY.CLAIM_RENEW_INTERVAL_MS;

function buildFlow() {
  return {
    renewClaims: vi.fn(async () => undefined),
    reconcileWithTwilio: vi.fn(async () => undefined),
  };
}

/**
 * The calls' Redis as the renewal sees it, shared by every controller
 * instance a test starts. The lock lapses on the faked clock.
 */
function buildTelephony() {
  let lock: { holder: string; until: number } | undefined;
  return {
    restoreLiveCalls: vi.fn(async () => 0),
    takeReconcileLock: vi.fn(async (holder: string, ttlMs: number) => {
      if (lock && lock.until > Date.now()) {
        return false;
      }
      lock = { holder, until: Date.now() + ttlMs };
      return true;
    }),
    releaseReconcileLock: vi.fn(async (holder: string) => {
      if (lock?.holder === holder) {
        lock = undefined;
      }
    }),
  };
}

describe('startClaimRenewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('runs a round at start, then one per interval until stopped', async () => {
    const flow = buildFlow();
    const renewal = startClaimRenewal({
      flow,
      telephony: buildTelephony(),
      log: createFakeLogger(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flow.renewClaims).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(flow.renewClaims).toHaveBeenCalledTimes(3);

    await renewal.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(flow.renewClaims).toHaveBeenCalledTimes(3);
  });

  test('asks Twilio about the calls in the round at start, and every tenth round after', async () => {
    const flow = buildFlow();
    const rounds: number[] = [];
    flow.reconcileWithTwilio.mockImplementation(async () => {
      rounds.push(flow.renewClaims.mock.calls.length - 1);
    });
    const renewal = startClaimRenewal({
      flow,
      telephony: buildTelephony(),
      log: createFakeLogger(),
    });

    await vi.advanceTimersByTimeAsync(2 * RECONCILE_EVERY_ROUNDS * INTERVAL);
    await renewal.stop();

    expect(rounds).toEqual([
      0,
      RECONCILE_EVERY_ROUNDS,
      2 * RECONCILE_EVERY_ROUNDS,
    ]);
  });

  test('renews the calls before asking Twilio about them', async () => {
    const flow = buildFlow();
    const renewal = startClaimRenewal({
      flow,
      telephony: buildTelephony(),
      log: createFakeLogger(),
    });
    await vi.advanceTimersByTimeAsync(0);
    await renewal.stop();

    const [renewed] = flow.renewClaims.mock.invocationCallOrder;
    const [reconciled] = flow.reconcileWithTwilio.mock.invocationCallOrder;
    expect(renewed).toBeLessThan(reconciled ?? 0);
  });

  test('keeps renewing, well within a claim lifetime, while Twilio never answers', async () => {
    const flow = buildFlow();
    flow.reconcileWithTwilio.mockReturnValue(new Promise(() => undefined));
    const renewals: number[] = [];
    flow.renewClaims.mockImplementation(async () => {
      renewals.push(Date.now());
    });
    const renewal = startClaimRenewal({
      flow,
      telephony: buildTelephony(),
      log: createFakeLogger(),
    });

    await vi.advanceTimersByTimeAsync(2 * RECONCILE_EVERY_ROUNDS * INTERVAL);
    await renewal.stop();

    expect(renewals).toHaveLength(2 * RECONCILE_EVERY_ROUNDS + 1);
    const gaps = renewals
      .slice(1)
      .map((at, index) => at - (renewals[index] ?? 0));
    expect(Math.max(...gaps)).toBeLessThan(AVAILABILITY.CLAIM_LIFETIME_MS);
    // Nor is a second reconciliation piled on the one that is stuck.
    expect(flow.reconcileWithTwilio).toHaveBeenCalledOnce();
  });

  test('does not start a round while the previous one is still going', async () => {
    let finish: () => void = () => undefined;
    const flow = buildFlow();
    flow.renewClaims.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const renewal = startClaimRenewal({
      flow,
      telephony: buildTelephony(),
      log: createFakeLogger(),
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(flow.renewClaims).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(flow.renewClaims).toHaveBeenCalledTimes(2);
    await renewal.stop();
  });

  test('keeps going after a round that failed', async () => {
    const log = createFakeLogger();
    const flow = buildFlow();
    flow.renewClaims.mockRejectedValueOnce(new Error('Redis is away'));
    const renewal = startClaimRenewal({
      flow,
      telephony: buildTelephony(),
      log,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(flow.renewClaims).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledOnce();
    await renewal.stop();
  });

  test('asks Twilio again at the next due round after a reconciliation that failed', async () => {
    const log = createFakeLogger();
    const flow = buildFlow();
    flow.reconcileWithTwilio.mockRejectedValueOnce(new Error('Twilio is away'));
    const renewal = startClaimRenewal({
      flow,
      telephony: buildTelephony(),
      log,
    });

    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_ROUNDS * INTERVAL);
    await renewal.stop();

    expect(log.warn).toHaveBeenCalledOnce();
    expect(flow.reconcileWithTwilio).toHaveBeenCalledTimes(2);
    expect(flow.renewClaims).toHaveBeenCalledTimes(RECONCILE_EVERY_ROUNDS + 1);
  });

  describe('with several controller instances', () => {
    test('only the one holding the lock asks Twilio, and another asks once it lapses', async () => {
      const telephony = buildTelephony();
      const first = buildFlow();
      const second = buildFlow();
      const renewals = [
        startClaimRenewal({ flow: first, telephony, log: createFakeLogger() }),
        startClaimRenewal({ flow: second, telephony, log: createFakeLogger() }),
      ];

      await vi.advanceTimersByTimeAsync(0);
      expect(first.reconcileWithTwilio).toHaveBeenCalledOnce();
      expect(second.reconcileWithTwilio).not.toHaveBeenCalled();

      // The second stays due, and tries every round until the lock lapses.
      await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_ROUNDS * INTERVAL);
      expect(second.reconcileWithTwilio).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_ROUNDS * INTERVAL);
      await Promise.all(renewals.map((renewal) => renewal.stop()));

      // Once per period between them, not once per period each.
      expect(
        first.reconcileWithTwilio.mock.calls.length +
          second.reconcileWithTwilio.mock.calls.length,
      ).toBe(3);
      // Every instance renews every round, whoever holds the lock.
      expect(first.renewClaims).toHaveBeenCalledTimes(
        2 * RECONCILE_EVERY_ROUNDS + 1,
      );
      expect(second.renewClaims).toHaveBeenCalledTimes(
        2 * RECONCILE_EVERY_ROUNDS + 1,
      );
    });

    test('an instance that stops gives the lock up, so the next one asks Twilio at once', async () => {
      const telephony = buildTelephony();
      const leaving = startClaimRenewal({
        flow: buildFlow(),
        telephony,
        log: createFakeLogger(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await leaving.stop();

      const flow = buildFlow();
      const arriving = startClaimRenewal({
        flow,
        telephony,
        log: createFakeLogger(),
      });
      await vi.advanceTimersByTimeAsync(0);
      await arriving.stop();

      expect(flow.reconcileWithTwilio).toHaveBeenCalledOnce();
    });
  });

  describe('calls missing from the live set', () => {
    test('are looked for once, before the first renewal', async () => {
      const flow = buildFlow();
      const telephony = buildTelephony();
      const renewal = startClaimRenewal({
        flow,
        telephony,
        log: createFakeLogger(),
      });

      await vi.advanceTimersByTimeAsync(2 * INTERVAL);
      await renewal.stop();

      expect(telephony.restoreLiveCalls).toHaveBeenCalledOnce();
      const [looked] = telephony.restoreLiveCalls.mock.invocationCallOrder;
      const [renewed] = flow.renewClaims.mock.invocationCallOrder;
      expect(looked).toBeLessThan(renewed ?? 0);
    });

    test('are looked for again next round when the look failed, and the renewal goes on', async () => {
      const flow = buildFlow();
      const telephony = buildTelephony();
      telephony.restoreLiveCalls.mockRejectedValueOnce(
        new Error('Redis is away'),
      );
      const renewal = startClaimRenewal({
        flow,
        telephony,
        log: createFakeLogger(),
      });

      await vi.advanceTimersByTimeAsync(2 * INTERVAL);
      await renewal.stop();

      expect(telephony.restoreLiveCalls).toHaveBeenCalledTimes(2);
      expect(flow.renewClaims).toHaveBeenCalledTimes(3);
    });
  });
});
