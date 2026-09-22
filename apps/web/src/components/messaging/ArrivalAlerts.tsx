'use client';

import type { MessageActivity } from '@repo/dto';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { useUnreadMessages } from '@/components/providers/UnreadMessagesProvider';
import {
  APP_TITLE,
  openThreadIdOf,
  shouldSoundArrival,
  tabTitle,
} from '@/lib/messaging/conversation-activity';

/** Where the sound lives; the `.gitignore` names this one file explicitly. */
const NOTIFICATION_SOUND = '/sounds/notification.mp3';

/**
 * Tells the agent a message arrived while they were somewhere else: the count
 * in the browser tab, and a sound. Renders nothing, and holds no rule of its
 * own — `lib/messaging/conversation-activity` decides both.
 */
export function ArrivalAlerts() {
  const pathname = usePathname();
  const { lastMessageActivity } = useCall();
  const { unreadConversations } = useUnreadMessages();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastAlertAtRef = useRef<number | null>(null);
  /**
   * The notice that has already been sounded, or not. Without it, moving
   * between pages would sound the last message again every time: the socket's
   * notice outlives the navigation, and only a new one is news.
   */
  const soundedActivity = useRef<MessageActivity | null>(lastMessageActivity);
  const openThreadId = openThreadIdOf(pathname);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is not read here on purpose. The router re-applies the layout's metadata title when the route changes, which drops the count; this puts it back.
  useEffect(() => {
    document.title = tabTitle(unreadConversations);

    // Leaving the signed-in app leaves nothing behind that keeps this count
    // right, so it goes rather than sitting in the tab going stale.
    return () => {
      document.title = APP_TITLE;
    };
  }, [unreadConversations, pathname]);

  useEffect(() => {
    const activity = lastMessageActivity;
    if (!activity || activity === soundedActivity.current) {
      return;
    }
    soundedActivity.current = activity;

    const now = Date.now();
    const sound = shouldSoundArrival({
      kind: activity.kind,
      conversationId: activity.conversationId,
      openThreadId,
      isPageVisible: document.visibilityState === 'visible',
      lastAlertAt: lastAlertAtRef.current,
      now,
    });

    if (!sound) {
      return;
    }

    lastAlertAtRef.current = now;
    audioRef.current ??= new Audio(NOTIFICATION_SOUND);
    const audio = audioRef.current;
    // Back to the start, so a second message during playback is still heard.
    audio.currentTime = 0;
    audio.play().catch(() => {
      /*
       * Browsers refuse to play audio until the page has had a click or a key
       * press, and on a tab opened and left alone it never has. Dropping the
       * rejection is the right outcome: the tab count and the inbox still say a
       * message arrived, and the sound works from the first interaction on.
       */
    });
  }, [lastMessageActivity, openThreadId]);

  return null;
}
