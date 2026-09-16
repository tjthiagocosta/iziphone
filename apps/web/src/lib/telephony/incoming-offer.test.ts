import { type IncomingCall, RING_DURATION_MAX_SECONDS } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  earlyAnswerOf,
  NO_OFFER_MEMORY,
  OFFER_EXPIRY_MS,
  type OfferFate,
  offerFate,
} from './incoming-offer';
import type { CallStatus, DeviceStatus } from './telephony-session';

function offerOf(conversationUuid: string, from: string): IncomingCall {
  return { conversationUuid, from, to: '+15550100100', callerId: from };
}

/** The phone and the socket's offer at one moment, and what the timers say. */
interface Moment {
  callStatus: CallStatus;
  offer: IncomingCall | null;
  /** The offer answered early, while the session still remembers the answer. */
  answeredOffer?: IncomingCall;
  /** The offer that has been around for `OFFER_EXPIRY_MS`. */
  expiredOffer?: IncomingCall;
}

function at(
  callStatus: CallStatus,
  offer: IncomingCall | null,
  timers: Pick<Moment, 'answeredOffer' | 'expiredOffer'> = {},
): Moment {
  return { callStatus, offer, ...timers };
}

/**
 * Asks about each moment in turn the way the call provider does: starting
 * from no memory and handing the rule back what its last answer came with.
 * An offer it dismissed is gone from the moments that follow, as it is from
 * the socket's state.
 */
function fatesOver(moments: Moment[]): Array<OfferFate | null> {
  const dismissed = new Set<IncomingCall>();
  let memory = NO_OFFER_MEMORY;

  return moments.map((moment) => {
    const seen = {
      callStatus: moment.callStatus,
      offer: moment.offer && !dismissed.has(moment.offer) ? moment.offer : null,
      answeredOffer: moment.answeredOffer ?? null,
      expiredOffer: moment.expiredOffer ?? null,
    };

    const decision = offerFate({ memory, ...seen });
    memory = decision.memory;

    if (decision.fate === 'dismiss' && seen.offer) {
      dismissed.add(seen.offer);
    } else {
      // The provider asks again whenever a timer changes, and twice on mount
      // in Strict Mode. With nothing new to see, the answer must not change.
      expect(
        offerFate({ memory, ...seen }),
        `asked again at "${moment.callStatus}"`,
      ).toEqual(decision);
    }

    return decision.fate;
  });
}

function lastFateOver(moments: Moment[]): OfferFate | null | undefined {
  return fatesOver(moments).at(-1);
}

const BUSY: CallStatus[] = ['connecting', 'connected', 'disconnecting'];
const FREE: CallStatus[] = ['idle', 'disconnected'];

describe('offerFate', () => {
  const offer = offerOf('CA_caller_1', '+15550100123');
  const next = offerOf('CA_caller_2', '+15550100145');

  test('shows an offer that arrives before the device rings', () => {
    expect(
      fatesOver([at('idle', null), at('idle', offer), at('idle', offer)]),
    ).toEqual([null, 'show', 'show']);
  });

  test('shows it for as long as the device rings', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('ringing', offer),
      ]),
    ).toEqual(['show', 'show', 'show']);
  });

  test.each(FREE)(
    'dismisses it when the ring stops unanswered and the phone is %s',
    (callStatus) => {
      expect(
        lastFateOver([
          at('idle', offer),
          at('ringing', offer),
          at(callStatus, offer),
        ]),
      ).toBe('dismiss');
    },
  );

  test('takes a ring already under way to be for the offer that reaches the browser late', () => {
    expect(
      fatesOver([
        at('ringing', null),
        at('ringing', offer),
        at('disconnected', offer),
      ]),
    ).toEqual([null, 'show', 'dismiss']);
  });

  test('shows an offer while the "call ended" of an earlier call clears', () => {
    expect(
      fatesOver([
        at('connected', null),
        at('disconnected', null),
        at('disconnected', offer),
        at('idle', offer),
      ]),
    ).toEqual([null, null, 'show', 'show']);
  });

  test('does not hold the end of a ring against an offer that arrived with it', () => {
    expect(
      lastFateOver([
        at('idle', offer),
        at('ringing', offer),
        at('disconnected', next),
      ]),
    ).toBe('show');
  });

  test('does not hold the end of a ring against an offer that turned up during it', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('ringing', next),
        at('disconnected', next),
        at('idle', next),
      ]),
    ).toEqual(['show', 'show', 'show', 'show', 'show']);
  });

  test('keeps a ring for the offer that was there, after that offer is withdrawn', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('ringing', null),
        at('ringing', next),
        at('disconnected', next),
      ]),
    ).toEqual(['show', 'show', null, 'show', 'show']);
  });

  test('treats the same call offered again as a new offer', () => {
    const again = { ...offer };

    expect(
      lastFateOver([
        at('idle', offer),
        at('ringing', offer),
        at('disconnected', again, { expiredOffer: offer }),
      ]),
    ).toBe('show');
  });

  test.each(BUSY)('dismisses it once the answered call is %s', (callStatus) => {
    expect(
      lastFateOver([
        at('idle', offer),
        at('ringing', offer),
        at(callStatus, offer),
      ]),
    ).toBe('dismiss');
  });

  test('dismisses it when an early answer is applied the moment the device rings', () => {
    // The session rings and accepts in one step, so "ringing" is never seen.
    expect(
      lastFateOver([
        at('idle', offer),
        at('idle', offer, { answeredOffer: offer }),
        at('connecting', offer, { answeredOffer: offer }),
      ]),
    ).toBe('dismiss');
  });

  test('holds it when the user dials out instead, and shows it if that call fails and the device rings', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('connecting', offer),
        at('idle', offer),
        at('ringing', offer),
      ]),
    ).toEqual(['show', 'hold', 'hold', 'show']);
  });

  test('holds an offer when the early answer applied was given to another', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('idle', offer, { answeredOffer: offer }),
        at('idle', next, { answeredOffer: offer }),
        at('connecting', next, { answeredOffer: offer }),
      ]),
    ).toEqual(['show', 'show', 'show', 'hold']);
  });

  test('holds an offer that turned up during the ring of the call that was answered', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('ringing', next),
        at('connecting', next),
        at('connected', next),
      ]),
    ).toEqual(['show', 'show', 'show', 'hold', 'hold']);
  });

  test.each(BUSY)(
    'holds an offer that arrives while another call is %s',
    (callStatus) => {
      expect(
        fatesOver([
          at(callStatus, null),
          at(callStatus, next),
          at(callStatus, offer),
        ]),
      ).toEqual([null, 'hold', 'hold']);
    },
  );

  test('holds an offer that arrives in the step the phone gets busy', () => {
    expect(lastFateOver([at('ringing', null), at('connecting', offer)])).toBe(
      'hold',
    );
  });

  test('keeps holding it through the rest of that call and after it', () => {
    expect(
      fatesOver([
        at('connected', null),
        at('connected', offer),
        at('disconnecting', offer),
        at('disconnected', offer),
        at('idle', offer),
      ]),
    ).toEqual([null, 'hold', 'hold', 'hold', 'hold']);
  });

  test('shows a held offer when the device rings after all', () => {
    expect(
      fatesOver([
        at('connected', offer),
        at('idle', offer),
        at('ringing', offer),
        at('disconnected', offer),
      ]),
    ).toEqual(['hold', 'hold', 'show', 'dismiss']);
  });

  test('keeps a held offer off screen while a call the user dials rings at the far end', () => {
    // The session reports that as "ringing" too.
    expect(
      fatesOver([
        at('connected', offer),
        at('idle', offer),
        at('connecting', offer),
        at('ringing', offer),
        at('connected', offer),
      ]),
    ).toEqual(['hold', 'hold', 'hold', 'hold', 'hold']);
  });

  test('holds an offer that arrives while a dialed call rings, and does not hold that call going unanswered against it', () => {
    expect(
      fatesOver([
        at('connecting', null),
        at('ringing', null),
        at('ringing', offer),
        at('disconnected', offer),
        at('ringing', offer),
      ]),
    ).toEqual([null, null, 'hold', 'hold', 'show']);
  });

  test.each(FREE)(
    'dismisses an expired offer the device never rang for while the phone is %s',
    (callStatus) => {
      expect(
        fatesOver([
          at(callStatus, offer),
          at(callStatus, offer, { expiredOffer: offer }),
        ]),
      ).toEqual(['show', 'dismiss']);
    },
  );

  test.each(BUSY)(
    'dismisses a held offer that expires while the call is %s',
    (callStatus) => {
      expect(
        fatesOver([
          at(callStatus, offer),
          at(callStatus, offer, { expiredOffer: offer }),
        ]),
      ).toEqual(['hold', 'dismiss']);
    },
  );

  test('never lets the clock take the Answer button away mid-ring', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('ringing', offer, { expiredOffer: offer }),
      ]),
    ).toEqual(['show', 'show', 'show']);
  });

  test('does not count the expiry of an earlier offer against its replacement', () => {
    expect(
      fatesOver([at('idle', offer), at('idle', next, { expiredOffer: offer })]),
    ).toEqual(['show', 'show']);
  });

  test('keeps an expired offer until the session has forgotten its early answer', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('idle', offer, { answeredOffer: offer }),
        at('idle', offer, { answeredOffer: offer, expiredOffer: offer }),
        at('idle', offer, { expiredOffer: offer }),
      ]),
    ).toEqual(['show', 'show', 'show', 'dismiss']);
  });

  test.each([...FREE, ...BUSY, 'ringing'] as const)(
    'has nothing to decide without an offer while the phone is %s',
    (callStatus) => {
      expect(
        fatesOver([
          at('ringing', null),
          at(callStatus, null, { answeredOffer: offer, expiredOffer: offer }),
        ]),
      ).toEqual([null, null]);
    },
  );
});

describe('an offer over the life of a call', () => {
  const offer = offerOf('CA_caller_1', '+15550100123');
  const next = offerOf('CA_caller_2', '+15550100145');

  test('is shown from the socket event until the unanswered ring stops', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('ringing', offer),
        at('disconnected', offer),
        at('idle', offer),
      ]),
    ).toEqual(['show', 'show', 'show', 'dismiss', null]);
  });

  test('is shown until the call it was answered from is connecting', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('connecting', offer),
        at('connected', offer),
      ]),
    ).toEqual(['show', 'show', 'dismiss', null]);
  });

  test('is shown after an early answer until the device rings and connects', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('idle', offer, { answeredOffer: offer }),
        at('connecting', offer, { answeredOffer: offer }),
        at('connected', offer),
      ]),
    ).toEqual(['show', 'show', 'dismiss', null]);
  });

  test('goes away on its own when the device never rings', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('idle', offer),
        at('idle', offer, { expiredOffer: offer }),
        at('idle', offer),
      ]),
    ).toEqual(['show', 'show', 'dismiss', null]);
  });

  test('never covers a call in progress, nor turns up when that call ends', () => {
    expect(
      fatesOver([
        at('connected', null),
        at('connected', offer),
        at('disconnected', offer),
        at('idle', offer),
        at('idle', offer, { expiredOffer: offer }),
      ]),
    ).toEqual([null, 'hold', 'hold', 'hold', 'dismiss']);
  });

  test('turns up when the device rings for it right after a call ended', () => {
    expect(
      fatesOver([
        at('disconnecting', null),
        at('disconnecting', offer),
        at('disconnected', offer),
        at('ringing', offer),
        at('connecting', offer),
      ]),
    ).toEqual([null, 'hold', 'hold', 'show', 'dismiss']);
  });

  test('outlives the end of the ring for the offer it replaced', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('disconnected', next),
        at('idle', next),
        at('ringing', next),
        at('disconnected', next),
      ]),
    ).toEqual(['show', 'show', 'show', 'show', 'show', 'dismiss']);
  });

  test('outlives a ring it turned up during, and goes with its own', () => {
    expect(
      fatesOver([
        at('idle', offer),
        at('ringing', offer),
        at('ringing', next),
        at('disconnected', next),
        at('ringing', next),
        at('disconnected', next),
      ]),
    ).toEqual(['show', 'show', 'show', 'show', 'show', 'dismiss']);
  });
});

describe('earlyAnswerOf', () => {
  const offer = offerOf('CA_caller_1', '+15550100123');

  test('is nothing until the offer on screen was answered', () => {
    expect(earlyAnswerOf(offer, null, 'ready')).toBeNull();
    expect(earlyAnswerOf(null, null, 'ready')).toBeNull();
    expect(earlyAnswerOf(null, offer, 'ready')).toBeNull();
    expect(
      earlyAnswerOf(offerOf('CA_caller_2', '+15550100145'), offer, 'ready'),
    ).toBeNull();
  });

  test('is connecting on a device Twilio can ring', () => {
    expect(earlyAnswerOf(offer, offer, 'ready')).toBe('connecting');
  });

  test.each(['offline', 'connecting', 'error'] satisfies DeviceStatus[])(
    'does not promise a connection while the device is %s',
    (deviceStatus) => {
      expect(earlyAnswerOf(offer, offer, deviceStatus)).toBe('phone-not-ready');
    },
  );
});

describe('OFFER_EXPIRY_MS', () => {
  test('outlasts the longest ring an admin can set, with the buffer Twilio adds', () => {
    expect(OFFER_EXPIRY_MS).toBeGreaterThan(
      (RING_DURATION_MAX_SECONDS + 5) * 1000,
    );
  });
});
