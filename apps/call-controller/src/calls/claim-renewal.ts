import { AVAILABILITY } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { CallFlow } from './call-flow.js';

/*
 * The heartbeat that keeps the users of every live call claimed. A claim
 * runs out unless renewed, which is what frees a user whose release was lost;
 * this is the other half, which keeps a user who is still on a call from
 * being freed, and claims them again if Redis or this service was away for
 * longer than a claim lasts. Every so often it also asks Twilio whether each
 * call's legs are still up, so that a call whose final status callback was
 * lost (the controller restarting, a webhook that failed) ends, and lets its
 * users go, instead of holding them for as long as its state lasts.
 */

/**
 * How many rounds apart Twilio is asked about every leg: about five minutes
 * at the usual interval, for one request per leg of each live call. The
 * round at start always asks, because a restart is how a status callback is
 * most likely lost.
 */
export const RECONCILE_EVERY_ROUNDS = 10;

export interface ClaimRenewal {
  stop(): void;
}

export function startClaimRenewal(deps: {
  flow: Pick<CallFlow, 'renewClaims'>;
  log: FastifyBaseLogger;
  intervalMs?: number;
}): ClaimRenewal {
  let running = false;
  let round = 0;

  const renew = async (): Promise<void> => {
    // A round that takes longer than the interval (Redis slow to answer) is
    // not joined by another one working through the same calls.
    if (running) {
      return;
    }
    running = true;
    const reconcile = round % RECONCILE_EVERY_ROUNDS === 0;
    round += 1;
    try {
      await deps.flow.renewClaims({ reconcile });
    } catch (error) {
      // The next round tries again; a claim survives two missed rounds.
      deps.log.warn({ err: error }, 'Failed to renew call claims');
    } finally {
      running = false;
    }
  };

  // At once, not an interval from now: claims that ran out while this
  // service was down are taken again before any call is offered to them.
  void renew();
  const timer = setInterval(() => {
    void renew();
  }, deps.intervalMs ?? AVAILABILITY.CLAIM_RENEW_INTERVAL_MS);
  // Renewing claims is no reason to keep the process alive.
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
