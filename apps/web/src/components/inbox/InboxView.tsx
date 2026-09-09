'use client';

import {
  MessageSquare,
  Phone,
  PhoneMissed,
  Star,
  Voicemail,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  formatPhoneNumber,
  formatRelativeTime,
  type MockInteraction,
  mockRecentInteractions,
} from '@/lib/mock-data';
import { cn } from '@/lib/utils';

type InboxTab =
  | 'unread'
  | 'all'
  | 'calls'
  | 'missed'
  | 'voicemails'
  | 'recordings'
  | 'messages'
  | 'starred'
  | 'spam';

const TABS: { value: InboxTab; label: string }[] = [
  { value: 'unread', label: 'Unread' },
  { value: 'all', label: 'All' },
  { value: 'calls', label: 'Calls' },
  { value: 'missed', label: 'Missed' },
  { value: 'voicemails', label: 'Voicemails' },
  { value: 'recordings', label: 'Recordings' },
  { value: 'messages', label: 'Messages' },
  { value: 'starred', label: 'Starred' },
  { value: 'spam', label: 'Spam' },
];

function filterInteractions(
  interactions: MockInteraction[],
  tab: InboxTab,
): MockInteraction[] {
  switch (tab) {
    case 'unread':
      return interactions.filter((i) => !i.isRead);
    case 'calls':
      return interactions.filter((i) => i.type === 'call');
    case 'missed':
      return interactions.filter(
        (i) =>
          i.type === 'call' &&
          (i.status === 'missed' || i.status === 'no-answer'),
      );
    case 'voicemails':
      return interactions.filter((i) => i.type === 'voicemail');
    case 'recordings':
      return interactions.filter(
        (i) => (i.type === 'call' || i.type === 'voicemail') && i.duration,
      );
    case 'messages':
      return interactions.filter((i) => i.type === 'message');
    case 'starred':
      return interactions.filter((i) => i.isStarred);
    case 'spam':
      return []; // No spam in mock data
    default:
      return interactions;
  }
}

export function InboxView() {
  const [activeTab, setActiveTab] = useState<InboxTab>('all');

  const filteredInteractions = filterInteractions(
    mockRecentInteractions,
    activeTab,
  );

  // Sort by timestamp descending
  const sortedInteractions = [...filteredInteractions].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  );

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Tabs */}
      <div className="border-b border-border px-4">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as InboxTab)}
        >
          <TabsList className="h-auto bg-transparent gap-1 p-0 flex-wrap">
            {TABS.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="px-3 py-2.5 text-sm font-normal data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none rounded-none border-b-2 border-transparent data-[state=active]:border-info data-[state=active]:bg-transparent"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Interaction List */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {sortedInteractions.length === 0 ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">No items found</p>
            </div>
          ) : (
            sortedInteractions.map((interaction) => (
              <InboxItem key={interaction.id} interaction={interaction} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface InboxItemProps {
  interaction: MockInteraction;
}

function InboxItem({ interaction }: InboxItemProps) {
  const { contact, type, direction, status, timestamp, content, duration } =
    interaction;

  const isMissed =
    status === 'missed' || status === 'no-answer' || status === 'busy';

  // Get preview text
  const getPreview = () => {
    if (type === 'message') {
      return (
        content?.slice(0, 60) + (content && content.length > 60 ? '...' : '')
      );
    }
    if (type === 'voicemail') {
      return 'Voicemail';
    }
    if (isMissed) {
      return 'Missed call';
    }
    if (direction === 'outbound') {
      return `Outbound / ${duration ? Math.ceil(duration / 60) : 0} min`;
    }
    return `Inbound / ${duration ? Math.ceil(duration / 60) : 0} min`;
  };

  // Get icon
  const getIcon = () => {
    if (type === 'message') {
      return <MessageSquare className="h-4 w-4 text-muted-foreground" />;
    }
    if (type === 'voicemail') {
      return <Voicemail className="h-4 w-4 text-muted-foreground" />;
    }
    if (isMissed) {
      return <PhoneMissed className="h-4 w-4 text-destructive" />;
    }
    return <Phone className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <Link
      href={`/app/conversations/${contact.id}`}
      className={cn(
        'flex items-center gap-4 px-4 py-3 hover:bg-secondary/50 transition-colors',
        !interaction.isRead && 'bg-secondary/30',
      )}
    >
      {/* Avatar */}
      <Avatar className="h-10 w-10">
        <AvatarFallback className={cn(contact.avatarColor, 'text-white')}>
          {contact.initials}
        </AvatarFallback>
      </Avatar>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'font-medium truncate',
              !interaction.isRead && 'font-semibold',
            )}
          >
            {contact.name || formatPhoneNumber(contact.phoneNumber)}
          </span>
          {interaction.isStarred && (
            <Star className="h-4 w-4 fill-warning text-warning" />
          )}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {getIcon()}
          <span className={cn(isMissed && 'text-destructive')}>
            {getPreview()}
          </span>
        </div>
      </div>

      {/* Timestamp */}
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        {formatRelativeTime(timestamp)}
      </span>
    </Link>
  );
}
