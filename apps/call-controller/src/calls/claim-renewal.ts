import { randomUUID } from 'node:crypto';
import { AVAILABILITY } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { CallFlow } from './call-flow.js';
import type { TelephonyService } from './telephony.service.js';

/*
 * The heartbeat that keeps the users of every live call claimed. A claim
 * runs out unless renewed, which is what frees a user whose release was lost;
 * this is the other half, which keeps a user who is still on a call from
 * being freed, and claims them again if Redis or this service was away for
 * longer than a claim lasts. Every so often it also asks Twilio whether each
 * call's legs are still up, so that a call whose final status callback was
 * lost (the controller restarting, a webhook that failed) ends, and lets its
 * users go, instead of holding them for as long as its state lasts.
 *
 * Renewing and asking Twilio are kept apart. Every round renews, whatever
 * the reconciliation is doing: a claim lapses after three rounds without a
 * renewal, and Twilio can be slow for much longer than that. The
 * reconciliation runs on its own, one at a time, and across instances only
 * where the reconcile lock was taken.
 */

/**
 * How many rounds apart Twilio is asked about every leg: about five minutes
 * at the usual interval, for one request per leg of each live call. The
 * round at start always asks, because a restart is how a status callback is
 * most likely lost.
 */
export const RECONCILE_EVERY_ROUNDS = 10;

export interface ClaimRenewal {
  /**
   * Stop the rounds, and give the reconcile lock up if this instance holds
   * it, so that whichever starts next reconciles at once.
   */
  stop(): Promise<void>;
}

export function startClaimRenewal(deps: {
  flow: Pick<CallFlow, 'renewClaims' | 'reconcileWithTwilio'>;
  telephony: Pick<
    TelephonyService,
    'restoreLiveCalls' | 'takeReconcileLock' | 'releaseReconcileLock'
  >;
  log: FastifyBaseLogger;
  intervalMs?: number;
}): ClaimRenewal {
  const { flow, telephony, log } = deps;
  const intervalMs = deps.intervalMs ?? AVAILABILITY.CLAIM_RENEW_INTERVAL_MS;
  // How long the instance that reconciled keeps the others from doing it
  // again: one round short of the time between two reconciliations, so that
  // its own next one finds the lock lapsed, and an instance that dies
  // holding it holds the others back no longer than that.
  const lockTtlMs = (RECONCILE_EVERY_ROUNDS - 1) * intervalMs;
  const holder = randomUUID();
  let round = 0;
  let renewing = false;
  let reconciling = false;
  let reconcileDue = false;
  let liveCallsRestored = false;
  let stopped = false;

  // Calls whose state is missing from the live set would never be renewed
  // or reconciled: those already going when the set was introduced, and
  // any whose state was written without being added. Looked for once, and
  // again every round until the look succeeds.
  const restoreLiveCalls = async (): Promise<void> => {
    try {
      const restored = await telephony.restoreLiveCalls();
      liveCallsRestored = true;
      if (restored > 0) {
        log.info(
          { calls: restored },
          'Found calls in progress that were not being renewed',
        );
      }
    } catch (error) {
      log.warn(
        { err: error },
        'Failed to look for calls in progress; trying again next round',
      );
    }
  };

  const reconcile = async (): Promise<void> => {
    reconciling = true;
    try {
      // Another instance reconciled a moment ago: this one stays due, and
      // tries again next round, so that a reconciliation is never skipped
      // for longer than the lock lasts.
      if (!(await telephony.takeReconcileLock(holder, lockTtlMs))) {
        return;
      }
      reconcileDue = false;
      await flow.reconcileWithTwilio();
    } catch (error) {
      log.warn({ err: error }, 'Failed to reconcile calls with Twilio');
    } finally {
      reconciling = false;
    }
  };

  const renew = async (): Promise<void> => {
    // A round that takes longer than the interval (Redis slow to answer) is
    // not joined by another one working through the same calls.
    if (renewing) {
      return;
    }
    renewing = true;
    if (round % RECONCILE_EVERY_ROUNDS === 0) {
      reconcileDue = true;
    }
    round += 1;
    try {
      if (!liveCallsRestored) {
        await restoreLiveCalls();
      }
      await flow.renewClaims();
    } catch (error) {
      // The next round tries again; a claim survives two missed rounds.
      log.warn({ err: error }, 'Failed to renew call claims');
    } finally {
      renewing = false;
    }

    // Started once the calls are renewed, and never waited for: a Twilio
    // that takes minutes to answer must not cost a single renewal.
    if (reconcileDue && !reconciling && !stopped) {
      void reconcile();
    }
  };

  // At once, not an interval from now: claims that ran out while this
  // service was down are taken again before any call is offered to them.
  void renew();
  const timer = setInterval(() => {
    void renew();
  }, intervalMs);
  // Renewing claims is no reason to keep the process alive.
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      try {
        await telephony.releaseReconcileLock(holder);
      } catch (error) {
        // It lapses on its own; the next reconciliation is late, not lost.
        log.warn({ err: error }, 'Failed to give the reconcile lock up');
      }
    },
  };
}
