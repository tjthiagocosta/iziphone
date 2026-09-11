/**
 * Which leg of a call is whose.
 *
 * `from` and `to` are the provider's, so the party they name swaps with the
 * direction: on an inbound call the contact dialled us, on an outbound one we
 * dialled them. Both the API (to resolve the contact) and the web app (to
 * label a row) need the rule, so it lives here rather than in either.
 *
 * The direction is read as a plain string because the column that stores it
 * is one: anything not recorded as inbound is treated as outbound, matching
 * how a call record is published.
 */

interface CallLegs {
  direction: string;
  from: string;
  to: string;
}

/** The other party's number: the contact, whichever leg holds them. */
export function callCounterparty(call: CallLegs): string {
  return call.direction === 'inbound' ? call.from : call.to;
}

/** Our own number the call was on, which is the line it belongs to. */
export function callLine(call: CallLegs): string {
  return call.direction === 'inbound' ? call.to : call.from;
}
