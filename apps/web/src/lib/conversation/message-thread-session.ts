/*
 * The messages of one open thread: the first load, paging back, and keeping
 * what is on screen current. Nothing pushes a message to the browser, so a
 * thread the agent is looking at reads its newest page again every so often.
 * The hook that owns a session wires it to React and to the page, so
 * everything here runs and is tested without a browser.
 */

import type {
  Message,
  MessageConversation,
  MessageListResponse,
} from '@repo/dto';
import {
  mergeNewestPage,
  NO_MESSAGES,
  prependOlderPage,
} from './message-pages';

/**
 * How long a visible thread waits after one answer before it asks again. A
 * refresh on the interval is one request, so an open thread costs three a
 * minute, however often the agent switches tabs. The API allows 100 a minute
 * per client IP and an office usually shares one: ten agents who each keep a
 * thread open spend 30 of them here, which leaves room for the inbox (4 a
 * minute where one is open) and for the requests people cause by working.
 */
export const REFRESH_MS = 20_000;

/**
 * How long a refresh may stay unanswered before the thread asks again. Long
 * enough that a slow answer is waited for rather than raced, short enough
 * that a request which never settles does not leave the thread stale for
 * good.
 */
export const UNANSWERED_MS = 3 * REFRESH_MS;

export interface MessageThreadState {
  /** The thread this is the state of, so a view never shows another one's. */
  conversationId: string;
  conversation: MessageConversation | null;
  /** Oldest first, the order a thread is read in. */
  messages: readonly Message[];
  hasMore: boolean;
  /** The first load is under way. A refresh never shows as loading. */
  isLoading: boolean;
  error: Error | null;
  /**
   * How many times the thread gave up what was loaded and started over from
   * its newest page. The reader's place was in what is gone, so each one is a
   * fresh open to a view.
   */
  restarts: number;
}

/**
 * What to show for `conversationId`. Between a new id and its session's first
 * report, the state a view still holds is the previous thread's: it is never
 * shown under this one, which is loading instead.
 */
export function shownThread(
  state: MessageThreadState | null,
  conversationId: string | null,
): Omit<MessageThreadState, 'conversationId'> {
  if (state && state.conversationId === conversationId) {
    return state;
  }

  return {
    conversation: null,
    messages: NO_MESSAGES.messages,
    hasMore: NO_MESSAGES.hasMore,
    isLoading: conversationId !== null,
    error: null,
    restarts: 0,
  };
}

export interface MessageThreadDeps {
  fetchConversation(conversationId: string): Promise<MessageConversation>;
  /** Newest first; `beforeMessageId` pages back in time. */
  fetchMessages(
    conversationId: string,
    query?: { beforeMessageId: string },
  ): Promise<MessageListResponse>;
  markRead(conversationId: string): Promise<void>;
  /** Whether the agent can see the page at all. */
  isVisible(): boolean;
  /** Calls `listener` when the page is shown or hidden; returns the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void;
}

export class MessageThreadSession {
  private state: MessageThreadState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopWatching: (() => void) | null = null;
  private disposed = false;
  /** Counts refreshes; the newest one asked is the one that times the next. */
  private refreshes = 0;
  /**
   * The newest refresh whose answer is on screen. An answer that a later one
   * overtook is dropped; one that is merely slow is still used.
   */
  private applied = 0;
  /** The same for the header, which only some refreshes read again. */
  private headerReads = 0;
  /**
   * When the thread is next due to ask. Kept apart from the timer because a
   * hidden page has no timer, and picks up from here when it is shown.
   */
  private dueAt = 0;
  /**
   * The thread holds inbound messages the server still counts as unread.
   * They are marked read once the agent can see them, which is not the same
   * moment they are loaded: a page can be hidden when an answer lands.
   */
  private unread = false;

  constructor(
    private readonly conversationId: string,
    private readonly deps: MessageThreadDeps,
    private readonly onChange: (state: MessageThreadState) => void,
  ) {
    this.state = { conversationId, ...shownThread(null, conversationId) };
  }

  /** Loads the thread, then keeps it current while the page is visible. */
  start(): void {
    this.onChange(this.state);

    this.stopWatching = this.deps.onVisibilityChange(() => {
      if (this.deps.isVisible()) {
        this.resume();
      } else {
        this.clearTimer();
      }
    });

    void this.load();
  }

  /**
   * Reads the thread again because the agent acted on it. A send, stored or
   * refused, changes the messages and can change whether the composer may
   * send at all, so this reads the header too.
   */
  async refresh(): Promise<void> {
    await this.readNewest({ header: true });
  }

  async loadOlder(): Promise<void> {
    const oldest = this.state.messages[0];
    if (this.disposed || !oldest || !this.state.hasMore) {
      return;
    }

    try {
      const page = await this.deps.fetchMessages(this.conversationId, {
        beforeMessageId: oldest.id,
      });
      if (this.disposed) {
        return;
      }

      const thread = prependOlderPage(this.state, page, oldest.id);
      if (thread !== this.state) {
        this.update({
          messages: thread.messages,
          hasMore: thread.hasMore,
          error: null,
        });
      }
    } catch (cause) {
      this.update({
        error:
          cause instanceof Error
            ? cause
            : new Error('Failed to load older messages'),
      });
    }
  }

  /** Stops asking; an answer still on its way is ignored when it lands. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private async load(): Promise<void> {
    try {
      const [conversation, page] = await Promise.all([
        this.deps.fetchConversation(this.conversationId),
        this.deps.fetchMessages(this.conversationId),
      ]);
      if (this.disposed) {
        return;
      }

      const { thread } = mergeNewestPage(NO_MESSAGES, page);
      this.update({
        conversation,
        messages: thread.messages,
        hasMore: thread.hasMore,
      });
      // The interval runs from this answer, whatever marking it read takes.
      this.schedule();

      this.unread = conversation.unreadCount > 0;
      await this.markReadIfSeen();
    } catch (cause) {
      this.update({
        error:
          cause instanceof Error ? cause : new Error('Failed to fetch thread'),
      });
    } finally {
      this.update({ isLoading: false });
    }
  }

  /**
   * The agent is back. The interval carries on instead of starting over: a
   * refresh that is overdue happens at once, one that is not waits out the
   * rest, so going back and forth between tabs asks no more often than a
   * thread that stayed visible. What landed while the page was hidden is
   * read now either way.
   */
  private resume(): void {
    if (Date.now() >= this.dueAt) {
      void this.readNewest();
      return;
    }

    void this.markReadIfSeen().catch(() => {
      // Still unread on the server; the next refresh tries again.
    });
    this.arm();
  }

  /**
   * Reads the newest page again and folds it into what is loaded, without a
   * loading state and without an error: a refresh that fails leaves the last
   * good messages on screen, and the next one asks again.
   *
   * A thread that never loaded has nothing to keep current, and a hidden page
   * does not ask.
   */
  private async readNewest({ header = false } = {}): Promise<void> {
    if (this.disposed || !this.state.conversation || !this.deps.isVisible()) {
      return;
    }

    // The next refresh is timed from this one's answer, so a slow answer
    // cannot pile requests up behind it. Until then the timer stands guard:
    // a request that never settles would otherwise be the last one made.
    this.schedule(UNANSWERED_MS);
    const request = ++this.refreshes;

    let page: MessageListResponse | null = null;
    try {
      page = await this.deps.fetchMessages(this.conversationId);
    } catch {
      // Deliberately silent; see above.
    }
    if (this.disposed) {
      return;
    }

    let inbound = false;
    if (page && request > this.applied) {
      this.applied = request;
      const { thread, arrived, restarted } = mergeNewestPage(this.state, page);
      // An error on screen is about something older than this answer.
      if (thread !== this.state || this.state.error) {
        this.update({
          messages: thread.messages,
          hasMore: thread.hasMore,
          error: null,
          restarts: this.state.restarts + (restarted ? 1 : 0),
        });
      }

      inbound = arrived.some((message) => message.direction === 'INBOUND');
      if (inbound) {
        this.unread = true;
      }
    }

    if (header || inbound) {
      await this.refreshConversation();
    }

    await this.markReadIfSeen().catch(() => {
      // Still unread on the server; the next refresh tries again.
    });

    if (request === this.refreshes) {
      this.schedule();
    }
  }

  /**
   * An inbound message is what changes the rest of the thread: the contact
   * opting out (or back in) arrives as one, and decides whether the composer
   * may send. Read then and after the agent sent something, so a refresh that
   * finds nothing stays at one request.
   */
  private async refreshConversation(): Promise<void> {
    const request = ++this.headerReads;

    try {
      const conversation = await this.deps.fetchConversation(
        this.conversationId,
      );
      if (request === this.headerReads) {
        this.update({ conversation });
      }
    } catch {
      // The header on screen is still the last good one.
    }
  }

  /**
   * Marks the thread read when it has unread messages and the agent can see
   * them. Messages that landed while the page was hidden wait here until it
   * is shown again.
   */
  private async markReadIfSeen(): Promise<void> {
    if (this.disposed || !this.unread || !this.deps.isVisible()) {
      return;
    }

    // Cleared before the request rather than after it, so a message that
    // arrives while it is in flight asks for another one.
    this.unread = false;
    try {
      await this.deps.markRead(this.conversationId);
    } catch (cause) {
      this.unread = true;
      throw cause;
    }
  }

  private schedule(delay = REFRESH_MS): void {
    this.dueAt = Date.now() + delay;
    this.arm();
  }

  private arm(): void {
    this.clearTimer();
    if (this.disposed || !this.state.conversation || !this.deps.isVisible()) {
      return;
    }

    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.readNewest();
      },
      Math.max(0, this.dueAt - Date.now()),
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private update(patch: Partial<MessageThreadState>): void {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
