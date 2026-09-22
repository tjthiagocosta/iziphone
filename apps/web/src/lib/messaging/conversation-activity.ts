/*
 * What the browser does when the call controller says a conversation changed:
 * how long it waits before reading, what the tab shows, and whether it makes a
 * sound. The rules are here so they can be tested without a browser; the
 * effects that fetch, write `document.title` and press play on an audio
 * element are thin edges over them.
 */

import type { MessageActivityKind } from '@repo/dto';

/**
 * How long a listener waits after an event before it reads. Each event resets
 * the wait, so a contact sending three messages, or a send whose status moves
 * twice, costs one request instead of one each. Short enough that the agent
 * sees it as immediate.
 */
export const ACTIVITY_REFRESH_DELAY_MS = 500;

/**
 * The tab title with nothing unread. The root layout's metadata uses this too,
 * so the plain title and the one with a count cannot drift apart.
 */
export const APP_TITLE = 'iziphone - Business Phone System';

/**
 * How long the sound waits before it may play again. A contact sending four
 * messages in a row, or four contacts at once, is one alert: the agent has
 * already been told, and a burst of chimes says nothing the first did not.
 */
export const ALERT_MIN_GAP_MS = 2000;

/** The tab title for a reader with `unreadConversations` threads unread. */
export function tabTitle(unreadConversations: number): string {
  return unreadConversations > 0
    ? `(${unreadConversations}) ${APP_TITLE}`
    : APP_TITLE;
}

/**
 * The conversation whose thread is open, from the path the reader is on.
 * Anywhere else in the app, no thread is open.
 */
export function openThreadIdOf(pathname: string): string | null {
  const match = /^\/app\/conversations\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1];

  return id ? decodeURIComponent(id) : null;
}

export interface ArrivalAlertInput {
  kind: MessageActivityKind;
  /** The conversation the activity is about. */
  conversationId: string;
  /** The thread the reader has open, from {@link openThreadIdOf}. */
  openThreadId: string | null;
  /** Whether the reader can see the page at all. */
  isPageVisible: boolean;
  /** When the sound last played, on the same clock as `now`. */
  lastAlertAt: number | null;
  now: number;
}

/**
 * Whether this activity should make a sound.
 *
 * Only a message arriving does: a delivery status is about something the agent
 * did themselves and needs no announcing. A message in the thread they are
 * looking at needs none either, because it appears in front of them; the same
 * thread on a hidden tab does, since they are somewhere else entirely.
 */
export function shouldSoundArrival(input: ArrivalAlertInput): boolean {
  if (input.kind !== 'received') {
    return false;
  }

  if (input.isPageVisible && input.openThreadId === input.conversationId) {
    return false;
  }

  return (
    input.lastAlertAt === null ||
    input.now - input.lastAlertAt >= ALERT_MIN_GAP_MS
  );
}
