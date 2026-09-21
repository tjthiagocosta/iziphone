import { type E164PhoneNumber, toE164PhoneNumber } from './primitives.js';

/**
 * Who a message came from, or is going to. Three different things turn up in
 * that field and only two of them can be written back to, so the difference is
 * decided here once rather than guessed at every place that stores, shows or
 * answers a message.
 */
export type MessageAddress =
  /** A real number in E.164 form. */
  | { kind: 'phone'; value: E164PhoneNumber }
  /** A short code, as one-time codes and alerts are sent from. */
  | { kind: 'short-code'; value: string }
  /** A sender id, usually a brand name. One way: a reply has nowhere to go. */
  | { kind: 'alphanumeric'; value: string };

/**
 * Longest address kept. A sender id is at most 11 characters and a channel
 * address a little more, so anything far past that is not an address and is
 * refused at the boundary instead of being stored as a contact.
 */
const MAX_LENGTH = 64;

/** Short codes run from three to seven digits. */
const SHORT_CODE = /^\d{3,7}$/;

/**
 * The address a provider sent, in the form it is stored and compared in, or
 * null when the value is not an address at all.
 */
export function toMessageAddress(value: string): MessageAddress | null {
  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) {
    return null;
  }

  const phoneNumber = toE164PhoneNumber(trimmed);

  if (phoneNumber !== null) {
    return { kind: 'phone', value: phoneNumber };
  }

  if (SHORT_CODE.test(trimmed)) {
    return { kind: 'short-code', value: trimmed };
  }

  return { kind: 'alphanumeric', value: trimmed };
}

/**
 * Whether a message can be delivered to this address. A name in place of a
 * number is one way: the provider has nothing to route an answer to, so asking
 * it to try is a guaranteed failure and the reader is better told up front.
 */
export function canReceiveMessages(value: string): boolean {
  const address = toMessageAddress(value);

  return address !== null && address.kind !== 'alphanumeric';
}
