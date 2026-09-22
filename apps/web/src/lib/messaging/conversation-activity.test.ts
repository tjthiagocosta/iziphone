import { describe, expect, test } from 'vitest';
import {
  ALERT_MIN_GAP_MS,
  APP_TITLE,
  type ArrivalAlertInput,
  openThreadIdOf,
  shouldSoundArrival,
  tabTitle,
} from './conversation-activity';

describe('tabTitle', () => {
  test('is the plain title with nothing unread', () => {
    expect(tabTitle(0)).toBe(APP_TITLE);
  });

  test('leads with the count while anything is unread', () => {
    expect(tabTitle(1)).toBe(`(1) ${APP_TITLE}`);
    expect(tabTitle(14)).toBe(`(14) ${APP_TITLE}`);
  });
});

describe('openThreadIdOf', () => {
  test('names the conversation the reader has open', () => {
    expect(openThreadIdOf('/app/conversations/conversation-1')).toBe(
      'conversation-1',
    );
    expect(openThreadIdOf('/app/conversations/conversation-1/')).toBe(
      'conversation-1',
    );
  });

  test('reads an id the browser escaped', () => {
    expect(openThreadIdOf('/app/conversations/conv%2F1')).toBe('conv/1');
  });

  test('is nothing anywhere else in the app', () => {
    for (const pathname of [
      '/app/inbox',
      '/app/conversations',
      '/app/conversations/conversation-1/messages',
      '/app/departments/dept-1',
      '/admin/users',
      '/',
    ]) {
      expect(openThreadIdOf(pathname)).toBeNull();
    }
  });
});

describe('shouldSoundArrival', () => {
  const arrival: ArrivalAlertInput = {
    kind: 'received',
    conversationId: 'conversation-1',
    openThreadId: null,
    isPageVisible: true,
    lastAlertAt: null,
    now: 10_000,
  };

  test('sounds for a message that arrived somewhere the reader is not looking', () => {
    expect(shouldSoundArrival(arrival)).toBe(true);
    expect(
      shouldSoundArrival({ ...arrival, openThreadId: 'conversation-2' }),
    ).toBe(true);
  });

  test('stays quiet for the thread the reader is reading', () => {
    expect(
      shouldSoundArrival({ ...arrival, openThreadId: 'conversation-1' }),
    ).toBe(false);
  });

  test('sounds for that same thread when the tab is in the background', () => {
    expect(
      shouldSoundArrival({
        ...arrival,
        openThreadId: 'conversation-1',
        isPageVisible: false,
      }),
    ).toBe(true);
  });

  test('never sounds for a delivery status', () => {
    expect(shouldSoundArrival({ ...arrival, kind: 'status' })).toBe(false);
    expect(
      shouldSoundArrival({
        ...arrival,
        kind: 'status',
        isPageVisible: false,
      }),
    ).toBe(false);
  });

  test('sounds once for a burst, and again when the gap has passed', () => {
    const justPlayed = arrival.now - ALERT_MIN_GAP_MS + 1;
    expect(shouldSoundArrival({ ...arrival, lastAlertAt: justPlayed })).toBe(
      false,
    );
    expect(
      shouldSoundArrival({
        ...arrival,
        lastAlertAt: arrival.now - ALERT_MIN_GAP_MS,
      }),
    ).toBe(true);
  });
});
