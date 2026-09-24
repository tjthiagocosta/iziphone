import type { CallRecord, Message } from '@repo/dto';
import { type LoadedRange, watermarkOf } from '../paging';
import { dayKey, formatDayLabel } from '../relative-time';

/**
 * One thing that happened on a thread. A thread is a (contact, line) pair under
 * the line's owner at the time, so a call belongs to it when it was on the same
 * line with the same contact — a call with that contact on another
 * department's number belongs to that department's thread instead, and never
 * appears here. Calls are matched on the numbers only, from the calls the
 * reader may see, so a thread shows every call with its contact on its line
 * that the reader can see, not only its owner's. A supervisor or an
 * administrator sees every call, so the new owner's thread shows them the
 * previous owner's calls with that contact too, though not that owner's
 * messages; a reader who can see two owners' threads sees both owners' calls
 * in each.
 */
export type TimelineEntry =
  | { kind: 'message'; key: string; at: number; message: Message }
  | { kind: 'call'; key: string; at: number; call: CallRecord };

/** A day's worth of entries, oldest first, under one heading. */
export interface TimelineDay {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

function entryAt(value: string): number | null {
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/**
 * Merges the two histories of a thread into the order they happened, oldest
 * first, grouped by the day a reader would say they happened on.
 *
 * Messages and calls page separately, so anything older than what both have
 * covered is held back rather than shown as a day with half its entries; see
 * {@link watermarkOf}.
 *
 * `now` is a parameter so the headings are testable, and because they are
 * relative: the same thread reads `Today` on the day and `Yesterday` after.
 */
export function buildTimeline(
  messages: readonly Message[],
  calls: readonly CallRecord[],
  now: Date = new Date(),
  floor = Number.NEGATIVE_INFINITY,
): TimelineDay[] {
  const entries: TimelineEntry[] = [];

  for (const message of messages) {
    const at = entryAt(message.createdAt);
    if (at !== null) {
      entries.push({
        kind: 'message',
        key: `message:${message.id}`,
        at,
        message,
      });
    }
  }

  for (const call of calls) {
    const at = entryAt(call.createdAt);
    if (at !== null) {
      entries.push({ kind: 'call', key: `call:${call.id}`, at, call });
    }
  }

  entries.sort(
    (a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const days: TimelineDay[] = [];

  for (const entry of entries) {
    if (entry.at < floor) {
      continue;
    }

    const key = dayKey(new Date(entry.at));
    const last = days[days.length - 1];

    if (last?.key === key) {
      last.entries.push(entry);
    } else {
      days.push({
        key,
        label: formatDayLabel(new Date(entry.at), now),
        entries: [entry],
      });
    }
  }

  return days;
}

/**
 * How far back the thread can be shown, given how much of each history is
 * loaded. Both are read newest-first, so the oldest entry of each is its
 * boundary.
 */
export function timelineFloor(
  messages: LoadedRange,
  calls: LoadedRange,
): number {
  return watermarkOf([messages, calls]);
}
