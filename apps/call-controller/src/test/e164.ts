import { type E164PhoneNumber, toE164PhoneNumber } from '@repo/dto';

/** A fictional number for a test, in the type only a checked value gets. */
export function e164(value: string): E164PhoneNumber {
  const phoneNumber = toE164PhoneNumber(value);
  if (!phoneNumber) {
    throw new Error(`${value} is not a phone number`);
  }
  return phoneNumber;
}
