import type { PhoneNumberOwner, PhoneNumberStatus } from '@repo/dto';

/** Who holds a number, as its row says: a user, a department, or nobody (the reserve). */
export interface NumberHolder {
  userId: string | null;
  departmentId: string | null;
}

export const RESERVE: NumberHolder = { userId: null, departmentId: null };

export function holderOf(owner: PhoneNumberOwner | null): NumberHolder {
  if (!owner) {
    return RESERVE;
  }

  return owner.type === 'user'
    ? { userId: owner.id, departmentId: null }
    : { userId: null, departmentId: owner.id };
}

/** The owner a holder names, as the API and the audit log show it. */
export function ownerOf(holder: NumberHolder): PhoneNumberOwner | null {
  if (holder.userId) {
    return { type: 'user', id: holder.userId };
  }

  if (holder.departmentId) {
    return { type: 'department', id: holder.departmentId };
  }

  return null;
}

/**
 * The holder a change asks for. `undefined` keeps the current one, `null`
 * sends the number to the reserve.
 */
export function requestedHolder(
  current: NumberHolder,
  owner: PhoneNumberOwner | null | undefined,
): NumberHolder {
  return owner === undefined ? current : holderOf(owner);
}

export function sameHolder(left: NumberHolder, right: NumberHolder): boolean {
  return (
    left.userId === right.userId && left.departmentId === right.departmentId
  );
}

/** Only a held number routes; one in the reserve answers nothing. */
export function statusFor(holder: NumberHolder): PhoneNumberStatus {
  return holder.userId || holder.departmentId ? 'ACTIVE' : 'RESERVED';
}

export interface PrimaryChange {
  before: NumberHolder;
  after: NumberHolder;
  wasPrimary: boolean;
  /** What the admin asked for, if anything. */
  requested: boolean | undefined;
  /** Whether the department it ends in already has a primary other than this number. */
  departmentHasPrimary: boolean;
}

/**
 * Whether the number is its department's primary once the change is applied.
 * Primary is a department idea (its default line); a user's numbers and the
 * reserve's are never primary. What the admin asked for wins. Otherwise a
 * number keeps its standing in the department it stays in, and one that joins
 * a department becomes primary only when that department has none, as a
 * department's first bought number does.
 */
export function isPrimaryAfter(change: PrimaryChange): boolean {
  const { before, after, wasPrimary, requested, departmentHasPrimary } = change;

  if (!after.departmentId) {
    return false;
  }

  if (requested !== undefined) {
    return requested;
  }

  if (after.departmentId === before.departmentId) {
    return wasPrimary;
  }

  return !departmentHasPrimary;
}
