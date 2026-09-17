import type { IncomingCall, Teammate } from '@repo/dto';

/**
 * Who is handing the offered call over, or null when it is not a transfer.
 * The controller knows users by id only; the name comes from the list the
 * user picks transfer targets from.
 */
export function transferredByName(
  offer: IncomingCall,
  teammates: readonly Teammate[],
): string | null {
  if (!offer.transferredBy) {
    return null;
  }
  const { userId } = offer.transferredBy;
  return (
    teammates.find((teammate) => teammate.id === userId)?.name ?? 'a teammate'
  );
}
