'use client';

import { useState } from 'react';
import {
  InboxList,
  type InboxTabOption,
  InboxTabs,
} from '@/components/inbox/InboxList';
import { useInbox } from '@/hooks/use-inbox';
import type { InboxTab } from '@/lib/inbox/inbox-item';

/*
 * Starred and Spam are not here: nothing in the database records either.
 * Recordings is gone too — every recording the API can find belongs to a
 * voicemail, so the tab would repeat the one beside it.
 */
const TABS: InboxTabOption[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'calls', label: 'Calls' },
  { value: 'missed', label: 'Missed' },
  { value: 'voicemails', label: 'Voicemails' },
  { value: 'messages', label: 'Messages' },
];

export function InboxView() {
  const [activeTab, setActiveTab] = useState<InboxTab>('all');
  const inbox = useInbox(activeTab);

  return (
    <div className="h-full flex flex-col bg-background">
      <InboxTabs tabs={TABS} value={activeTab} onChange={setActiveTab} />

      <InboxList {...inbox} />
    </div>
  );
}
