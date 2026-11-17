import type { PhoneNumberAssignment, PhoneNumberOwner } from '@repo/dto';

/**
 * Who an admin is giving a number to, while they choose. Picking "a user"
 * comes before picking which one, so a kind can be chosen with nobody yet.
 */
export type OwnerSelection =
  | { kind: 'reserve' }
  | { kind: 'user' | 'department'; holder: PhoneNumberAssignment | null };

export type OwnerKind = OwnerSelection['kind'];

export const RESERVE_SELECTION: OwnerSelection = { kind: 'reserve' };

/** The selection that stands for a number's current holder. */
export function selectionOf(
  holder: PhoneNumberAssignment | null,
): OwnerSelection {
  return holder ? { kind: holder.type, holder } : RESERVE_SELECTION;
}

/** Switches the kind, forgetting a holder of another kind. */
export function withKind(
  selection: OwnerSelection,
  kind: OwnerKind,
): OwnerSelection {
  if (kind === 'reserve') {
    return RESERVE_SELECTION;
  }

  if (selection.kind === kind) {
    return selection;
  }

  return { kind, holder: null };
}

/**
 * The holder chosen: an assignment, `null` for the reserve, or `undefined`
 * while a kind is chosen but nobody of that kind is.
 */
export function chosenHolder(
  selection: OwnerSelection,
): PhoneNumberAssignment | null | undefined {
  if (selection.kind === 'reserve') {
    return null;
  }

  return selection.holder ?? undefined;
}

/** What the API is sent for a holder: its kind and id, or `null` for the reserve. */
export function ownerOf(
  holder: PhoneNumberAssignment | null,
): PhoneNumberOwner | null {
  return holder ? { type: holder.type, id: holder.id } : null;
}

export function sameHolder(
  a: PhoneNumberAssignment | null,
  b: PhoneNumberAssignment | null,
): boolean {
  return a?.type === b?.type && a?.id === b?.id;
}
