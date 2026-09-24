import type { AvailabilityState } from '@repo/dto';

/*
 * Whether a user can be offered a call, from three facts kept apart on
 * purpose: whether a softphone of theirs is connected, whether they turned on
 * do not disturb, and which calls claim them. Every caller asks this one
 * rule, so a department ring, a transfer and the status a softphone shows
 * can never disagree.
 */

export interface AvailabilityFacts {
  /** How many of the user's softphones are connected. */
  sockets: number;
  doNotDisturb: boolean;
  /** The calls whose claim on the user has not run out. */
  calls: readonly string[];
}

/**
 * `available`, or the reason the user cannot take a call: no softphone to
 * ring (`offline`), do not disturb (`dnd`), or another call (`busy`). The
 * reasons are checked in that order, so a user who is on a call with do not
 * disturb on is shown as not wanting to be disturbed, which lasts longer.
 *
 * `forCall` is the call being offered: its own claim does not make the user
 * busy for it, which is what lets a fixed-order ring or a repeated offer come
 * back to somebody it already holds.
 */
export function decideAvailability(
  facts: AvailabilityFacts,
  forCall?: string,
): AvailabilityState {
  if (facts.sockets === 0) {
    return 'offline';
  }
  if (facts.doNotDisturb) {
    return 'dnd';
  }
  return facts.calls.some((call) => call !== forCall) ? 'busy' : 'available';
}
