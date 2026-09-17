import { z } from 'zod';

/** Identifier of a stored entity. Shape is opaque to clients; only emptiness is rejected. */
export const EntityIdSchema = z.string().trim().min(1, 'ID is required');

/** ISO 8601 timestamp with a zone designator, as produced by `Date#toISOString()`. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Time of day in 24-hour `HH:MM` form. */
export const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:MM 24-hour format');

/** E.164 phone number: a leading plus followed by 7 to 15 digits. */
export const E164PhoneNumberSchema = z.e164(
  'Phone number must be in E.164 format',
);

/**
 * Query-string booleans arrive as text. `z.coerce.boolean()` turns the string
 * "false" into `true`, so accept real booleans and the usual textual forms only.
 */
export const QueryBooleanSchema = z.union([z.boolean(), z.stringbool()]);

/**
 * A destination typed by a person. Accepts E.164 or a ten-digit North American
 * number with an optional leading 1 and any punctuation. The API normalises the
 * value to E.164 before it reaches the provider.
 */
export const PhoneNumberInputSchema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .refine(
    isDialablePhoneNumber,
    'Phone number must be a valid E.164 or 10-digit North American number',
  );

export function isDialablePhoneNumber(value: string): boolean {
  return normalizePhoneNumber(value) !== null;
}

/**
 * Canonical E.164 form of a number a person typed, or null when it is not one.
 * Accepts E.164 with any punctuation, or a ten-digit North American number
 * with an optional leading 1.
 */
export function normalizePhoneNumber(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  return null;
}

declare const e164PhoneNumber: unique symbol;

/**
 * A string proven to be E.164. Only {@link toE164PhoneNumber} makes one, so a
 * field of this type cannot be handed a user id or whatever a client sent.
 */
export type E164PhoneNumber = string & { readonly [e164PhoneNumber]: true };

/** {@link normalizePhoneNumber}, keeping the proof in the type. */
export function toE164PhoneNumber(value: string): E164PhoneNumber | null {
  return normalizePhoneNumber(value) as E164PhoneNumber | null;
}

/** IANA time zone name accepted by the runtime's `Intl` implementation. */
export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidTimeZone, 'Unknown IANA time zone');

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type EntityId = z.infer<typeof EntityIdSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
