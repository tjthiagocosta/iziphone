import type {
  AvailabilityState,
  OwnAvailabilityResponse,
  UnavailableReason,
  UserAvailability,
} from '@repo/dto';
import type { ConnectionStatus } from './connection-status';

/*
 * What the softphone shows of availability: the user's own do not disturb
 * and whether each teammate can be handed a call. The controller decides
 * both; this only keeps what it said in order. Every word from it carries a
 * revision that only grows, so whatever arrives late (an event overtaken by
 * a snapshot, a slow poll overtaken by a fast one) is recognised and dropped.
 */

/**
 * The user's own do not disturb, as this softphone last heard it. Their
 * state is not kept: the softphone knows its own connection better than the
 * controller can tell it, and shows nothing of being busy.
 */
export interface OwnAvailability {
  doNotDisturb: boolean;
  revision: number;
}

/**
 * A snapshot from the controller, read on (re)connect. It is kept unless
 * something newer is known.
 */
export function applyOwnSnapshot(
  current: OwnAvailability | null,
  snapshot: OwnAvailabilityResponse,
): OwnAvailability | null {
  if (current && snapshot.availability.revision < current.revision) {
    return current;
  }
  return ownAvailabilityOf(snapshot);
}

/**
 * The controller's answer to the user switching do not disturb here. It is
 * kept whatever was known before: nothing heard earlier can be newer than
 * the answer to what the user just did, and a revision that looks older only
 * means the controller's Redis was emptied and its revisions began again.
 */
export function applyOwnAnswer(
  answer: OwnAvailabilityResponse,
): OwnAvailability {
  return ownAvailabilityOf(answer);
}

/**
 * An event on the socket. One that is not newer than what is known changes
 * nothing. Do not disturb follows from the state, except while the user
 * reads as offline, which does not say whether it is on.
 */
export function applyOwnEvent(
  current: OwnAvailability | null,
  event: UserAvailability,
): OwnAvailability | null {
  if (current && event.revision <= current.revision) {
    return current;
  }
  if (event.state === 'offline') {
    return current && { ...current, revision: event.revision };
  }
  return { doNotDisturb: event.state === 'dnd', revision: event.revision };
}

function ownAvailabilityOf({
  availability,
  doNotDisturb,
}: OwnAvailabilityResponse): OwnAvailability {
  return { doNotDisturb, revision: availability.revision };
}

/**
 * Teammates' availability, merged per teammate by revision, so that a poll
 * answered late cannot put back what a later one already replaced.
 */
export function mergeTeammateAvailability(
  current: ReadonlyMap<string, UserAvailability>,
  snapshot: readonly UserAvailability[],
): Map<string, UserAvailability> {
  const merged = new Map(current);
  for (const entry of snapshot) {
    const known = merged.get(entry.userId);
    if (!known || entry.revision >= known.revision) {
      merged.set(entry.userId, entry);
    }
  }
  return merged;
}

const UNAVAILABLE_REASON: Record<UnavailableReason, string> = {
  busy: 'On a call',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

/**
 * Whether a teammate can be picked for a transfer, and if not, why. A
 * teammate whose availability is not known yet can be picked: the controller
 * refuses the transfer if they cannot take it, so this only saves a click.
 */
export function transferChoiceOf(state: AvailabilityState | undefined): {
  selectable: boolean;
  reason: string | null;
} {
  if (!state || state === 'available') {
    return { selectable: true, reason: null };
  }
  return { selectable: false, reason: UNAVAILABLE_REASON[state] };
}

export type IndicatorStatus = ConnectionStatus | 'dnd';

/**
 * What the navbar dot shows: do not disturb matters only while connected.
 * `doNotDisturb` is null while it is not known.
 */
export function indicatorStatus(
  connection: ConnectionStatus,
  doNotDisturb: boolean | null,
): IndicatorStatus {
  return connection === 'online' && doNotDisturb ? 'dnd' : connection;
}
