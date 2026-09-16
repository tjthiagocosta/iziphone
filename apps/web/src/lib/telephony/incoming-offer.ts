/*
 * What becomes of a call the controller offered. The offer comes over the
 * socket before Twilio rings the device, so it normally appears while the
 * phone is still idle, and it carries the only Answer button. Whether it has
 * had its day therefore depends on what the phone was doing a moment ago, not
 * only on what it is doing now.
 */

import { type IncomingCall, RING_DURATION_MAX_SECONDS } from '@repo/dto';
import type { CallStatus, DeviceStatus } from './telephony-session';

/** Twilio lets a leg ring this much longer than the timeout it was given. */
const TWILIO_RING_BUFFER_SECONDS = 5;

/** Room for the ring to reach the device after the offer, and for its end to. */
const SIGNALING_ALLOWANCE_SECONDS = 10;

/**
 * Longer than the device can ring for one offer. The controller announces the
 * end of a call only once the whole conversation is over, so an offer the
 * device never rings for (it is not registered, or Twilio could not reach it)
 * would otherwise stay up for as long as a colleague talks to the caller.
 */
export const OFFER_EXPIRY_MS =
  (RING_DURATION_MAX_SECONDS +
    TWILIO_RING_BUFFER_SECONDS +
    SIGNALING_ALLOWANCE_SECONDS) *
  1000;

/**
 * `show` puts the offer on screen, `hold` keeps it off screen without
 * forgetting it, and `dismiss` forgets it.
 */
export type OfferFate = 'show' | 'hold' | 'dismiss';

/** The phone as an offer sees it: nothing on, being rung, or taken by a call. */
type PhonePhase = 'free' | 'rung' | 'busy';

/**
 * What the rule keeps from one question to the next. Start from
 * `NO_OFFER_MEMORY`, then hand back what the last answer came with.
 */
export interface OfferMemory {
  phase: PhonePhase;
  /** Every offer the controller sends is its own object, even for the same call. */
  offer: IncomingCall | null;
  heldOffer: IncomingCall | null;
  /**
   * The offer the ring was taken to be for: the one there when the ring began,
   * or the first to turn up during it. The session does not say which call
   * rings, so a later offer is not mistaken for the one that rang.
   */
  rungOffer: IncomingCall | null;
}

export const NO_OFFER_MEMORY: OfferMemory = {
  phase: 'free',
  offer: null,
  heldOffer: null,
  rungOffer: null,
};

export interface OfferFateInput {
  memory: OfferMemory;
  callStatus: CallStatus;
  offer: IncomingCall | null;
  /** The offer answered before the device rang, while the session remembers the answer. */
  answeredOffer: IncomingCall | null;
  /** The offer that has been around for `OFFER_EXPIRY_MS`, if one has. */
  expiredOffer: IncomingCall | null;
}

export interface OfferDecision {
  /** What to do with the offer, or null without one. */
  fate: OfferFate | null;
  memory: OfferMemory;
}

/**
 * Asked after every change to the phone or the offer. Answering, declining
 * and the controller's `call_ended` remove an offer where they happen; this
 * is the rest: the ring stopped, the ring never came, or the phone is taken
 * by a call.
 */
export function offerFate({
  memory,
  callStatus,
  offer,
  answeredOffer,
  expiredOffer,
}: OfferFateInput): OfferDecision {
  const phase = phaseOf(callStatus, memory.phase);
  const fate = offer
    ? fateIn(phase, offer, memory, { answeredOffer, expiredOffer })
    : null;

  return {
    fate,
    memory: {
      phase,
      offer,
      heldOffer: fate === 'hold' ? offer : null,
      rungOffer: phase === 'rung' ? (memory.rungOffer ?? offer) : null,
    },
  };
}

function phaseOf(callStatus: CallStatus, lastPhase: PhonePhase): PhonePhase {
  switch (callStatus) {
    case 'idle':
    case 'disconnected':
      return 'free';
    case 'connecting':
    case 'connected':
    case 'disconnecting':
      return 'busy';
    case 'ringing':
      // The session says "ringing" both when the device is rung and when the
      // far end of a dialed call is. The Device drops an invite that reaches
      // it during a call, so only a free phone is rung: on a busy one it is
      // the dialed call, and the phone stays busy.
      return lastPhase === 'busy' ? 'busy' : 'rung';
  }
}

function fateIn(
  phase: PhonePhase,
  offer: IncomingCall,
  memory: OfferMemory,
  {
    answeredOffer,
    expiredOffer,
  }: Pick<OfferFateInput, 'answeredOffer' | 'expiredOffer'>,
): OfferFate {
  const hasExpired = expiredOffer === offer;
  const wasHeld = memory.heldOffer === offer;
  const wasRinging = memory.phase === 'rung';
  const rangForThis = wasRinging && memory.rungOffer === offer;

  switch (phase) {
    case 'rung':
      // The offer carries the only Answer button: a phone being rung shows
      // it, held or not, whatever the clock says.
      return 'show';
    case 'busy': {
      if (hasExpired) {
        return 'dismiss';
      }
      // The offer was answered if the phone rang for it, or if its early
      // answer was applied, which the session does in the step the device
      // rings. Any other must not cover the call: it arrived during it, turned
      // up while the phone rang for another, or the user dialed out instead.
      // The Device drops an invite that reaches it while busy, but the call
      // may end, or fail to start, before the invite lands, so such an offer
      // waits off screen in case the device rings after all.
      const wasOnScreen = memory.offer === offer && !wasHeld;
      const wasAnsweredEarly = !wasRinging && answeredOffer === offer;
      const wasAnswered = wasOnScreen && (rangForThis || wasAnsweredEarly);
      return wasAnswered ? 'dismiss' : 'hold';
    }
    case 'free': {
      // The session may still apply an early answer; taking the offer away
      // before it forgets would connect a call the screen said was gone.
      const isAwaitingRing = answeredOffer === offer;
      // A ring for it that stopped went unanswered: a colleague took the
      // call, the caller gave up, or the ring ran out.
      if (rangForThis || (hasExpired && !isAwaitingRing)) {
        return 'dismiss';
      }
      return wasHeld ? 'hold' : 'show';
    }
  }
}

/** What an Answer pressed before the device rang has come to. */
export type EarlyAnswer = 'connecting' | 'phone-not-ready';

/**
 * The session applies an early answer when the device rings, which only a
 * registered device does: saying "connecting" on any other would be a promise
 * nothing can keep.
 */
export function earlyAnswerOf(
  offer: IncomingCall | null,
  answeredOffer: IncomingCall | null,
  deviceStatus: DeviceStatus,
): EarlyAnswer | null {
  if (!offer || answeredOffer !== offer) {
    return null;
  }
  return deviceStatus === 'ready' ? 'connecting' : 'phone-not-ready';
}
