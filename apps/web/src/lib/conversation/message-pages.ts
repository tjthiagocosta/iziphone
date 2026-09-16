import type { Message, MessageListResponse } from '@repo/dto';

/** The stretch of a thread that is loaded: from some message up to the newest. */
export interface LoadedMessages {
  /** Oldest first, the order a thread is read in. */
  messages: readonly Message[];
  /** Messages older than the first one are left to fetch. */
  hasMore: boolean;
}

export const NO_MESSAGES: LoadedMessages = { messages: [], hasMore: false };

export interface NewestPageMerge {
  /** The same object as before when the page changed nothing. */
  thread: LoadedMessages;
  /** The page's messages that were not loaded before, oldest first. */
  arrived: Message[];
  /**
   * What was loaded is gone and the thread starts over from the page. A
   * reader's place was in what is gone, so a view treats it as a fresh open.
   */
  restarted: boolean;
}

/**
 * Milliseconds since the epoch; the string itself does not sort, because
 * `IsoDateTimeSchema` admits offset forms. A value that is not a time sorts
 * first instead of turning every comparison it is part of into NaN.
 */
function createdAtOf(message: Message): number {
  const at = Date.parse(message.createdAt);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * Oldest first. Messages created in the same instant keep the order they were
 * given in, which is the server's: the first message is the cursor the next
 * older page is asked from, and it has to be the row the server ended on.
 */
function oldestFirst(messages: Iterable<Message>): Message[] {
  return [...messages].sort((a, b) => {
    const [atA, atB] = [createdAtOf(a), createdAtOf(b)];
    return atA === atB ? 0 : atA < atB ? -1 : 1;
  });
}

/**
 * Both copies were parsed by the same schema, so equal content serializes
 * equally. A false difference would only cost a render.
 */
function sameMessage(a: Message | undefined, b: Message): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Folds a freshly read newest page into what a thread has loaded.
 *
 * The endpoint only pages backwards from the newest message, so keeping an
 * open thread current means reading that page again. Keying on the id lets a
 * message that changed (queued, sent, delivered, failed) replace its loaded
 * copy in place and drops the ones that are simply still there, so pages
 * loaded further back stay loaded and nothing appears twice. The result is
 * sorted rather than appended to: a message is timestamped when its
 * transaction starts, so one that commits late can belong before another
 * that is already on screen.
 *
 * When the page shares nothing with what is loaded and older messages lie
 * beyond it, more than a page arrived since the last read. Keeping both sides
 * would leave a hole that paging back from the oldest loaded message never
 * reaches, so the thread restarts from the page and pages back from there.
 */
export function mergeNewestPage(
  loaded: LoadedMessages,
  page: MessageListResponse,
): NewestPageMerge {
  const known = new Map(
    loaded.messages.map((message) => [message.id, message]),
  );
  // The endpoint answers newest first, because it pages backwards.
  const fresh = oldestFirst([...page.messages].reverse());
  const arrived = fresh.filter((message) => !known.has(message.id));

  if (fresh.length === 0) {
    return { thread: loaded, arrived, restarted: false };
  }

  const reachesLoaded = arrived.length < fresh.length;
  if (!reachesLoaded && (known.size === 0 || page.hasMore)) {
    return {
      thread: { messages: fresh, hasMore: page.hasMore },
      arrived,
      restarted: known.size > 0,
    };
  }

  const changed =
    arrived.length > 0 ||
    fresh.some((message) => !sameMessage(known.get(message.id), message));
  if (!changed) {
    return { thread: loaded, arrived, restarted: false };
  }

  const byId = new Map(known);
  for (const message of fresh) {
    byId.set(message.id, message);
  }
  const messages = oldestFirst(byId.values());
  const oldest = messages[0];

  return {
    thread: {
      messages,
      // Whichever side reaches further back knows whether anything is older.
      hasMore: oldest && !known.has(oldest.id) ? page.hasMore : loaded.hasMore,
    },
    arrived,
    restarted: false,
  };
}

/**
 * Puts a page of older messages in front of what is loaded.
 *
 * `beforeMessageId` is the message the page was asked from. When it is no
 * longer the oldest one loaded, the answer is for a thread that has moved on
 * (it restarted from a newer page, or the same page already landed after a
 * second click) and would leave a hole or a repeat, so it is dropped.
 */
export function prependOlderPage(
  loaded: LoadedMessages,
  page: MessageListResponse,
  beforeMessageId: string,
): LoadedMessages {
  if (loaded.messages[0]?.id !== beforeMessageId) {
    return loaded;
  }

  const byId = new Map(
    [...page.messages].reverse().map((message) => [message.id, message]),
  );
  for (const message of loaded.messages) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }

  return { messages: oldestFirst(byId.values()), hasMore: page.hasMore };
}
