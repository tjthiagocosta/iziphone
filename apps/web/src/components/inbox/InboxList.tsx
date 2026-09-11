'use client';

import { MessageSquare, Phone, PhoneMissed, Voicemail } from 'lucide-react';
import Link from 'next/link';
import { useCall } from '@/components/providers/CallProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { UseInboxReturn } from '@/hooks/use-inbox';
import { avatarColorFor } from '@/lib/avatar-color';
import type { InboxItem, InboxTab } from '@/lib/inbox/inbox-item';
import { type InboxRow, inboxRow } from '@/lib/inbox/inbox-row';
import { initialsOf } from '@/lib/initials';
import { formatRelativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

export interface InboxTabOption {
  value: InboxTab;
  label: string;
}

/** The tab strip above an inbox; a department shows a subset of it. */
export function InboxTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly InboxTabOption[];
  value: InboxTab;
  onChange: (tab: InboxTab) => void;
}) {
  return (
    <div className="border-b border-border px-4">
      <Tabs value={value} onValueChange={(next) => onChange(next as InboxTab)}>
        <TabsList className="h-auto bg-transparent gap-1 p-0 flex-wrap">
          {tabs.map((tab) => (
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
  );
}

/**
 * The rows of an inbox. The reader's inbox and a department's are the same
 * list read with a different scope, so they render through here.
 */
export function InboxList({
  items,
  isLoading,
  isLoadingMore,
  error,
  hasMore,
  loadMore,
}: Omit<UseInboxReturn, 'refresh'>) {
  return (
    <ScrollArea className="flex-1">
      <div className="divide-y divide-border">
        {error ? (
          <InboxNotice>{error.message}</InboxNotice>
        ) : isLoading ? (
          <InboxNotice>Loading…</InboxNotice>
        ) : items.length === 0 ? (
          <InboxNotice>No items found</InboxNotice>
        ) : (
          items.map((item) => <InboxListItem key={item.key} item={item} />)
        )}
      </div>

      {hasMore && !isLoading && !error && (
        <div className="p-4 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={loadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? 'Loading…' : 'Show older'}
          </Button>
        </div>
      )}
    </ScrollArea>
  );
}

function InboxNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center h-64">
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}

function InboxListItem({ item }: { item: InboxItem }) {
  const row = inboxRow(item);
  const body = <InboxRowBody row={row} />;

  if (row.href) {
    return (
      <Link
        href={row.href}
        className={cn(
          'flex items-center gap-4 px-4 py-3 hover:bg-secondary/50 transition-colors',
          row.unreadCount > 0 && 'bg-secondary/30',
        )}
      >
        {body}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-4 px-4 py-3 hover:bg-secondary/50 transition-colors">
      {body}
      {row.callBack && <CallBackButton number={row.callBack} />}
    </div>
  );
}

const ROW_ICONS = {
  message: MessageSquare,
  call: Phone,
  missed: PhoneMissed,
  voicemail: Voicemail,
} as const;

function InboxRowBody({ row }: { row: InboxRow }) {
  const Icon = ROW_ICONS[row.icon];

  return (
    <>
      <Avatar className="h-10 w-10">
        <AvatarFallback
          className={cn(avatarColorFor(row.identity), 'text-white')}
        >
          {initialsOf(row.name, row.fallback)}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'font-medium truncate',
              row.unreadCount > 0 && 'font-semibold',
            )}
          >
            {row.title}
          </span>
          {/*
            One contact has a separate conversation per line, so two rows for
            the same person are normal. Without the line they read as a bug.
          */}
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
            {row.line}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon
            className={cn(
              'h-4 w-4 shrink-0',
              row.isMissed ? 'text-destructive' : 'text-muted-foreground',
            )}
          />
          <span className={cn('truncate', row.isMissed && 'text-destructive')}>
            {row.preview}
          </span>
        </div>
      </div>

      <span className="text-sm text-muted-foreground whitespace-nowrap">
        {formatRelativeTime(new Date(row.sortKey))}
      </span>
    </>
  );
}

/**
 * A call row opens nothing: a contact has one conversation per line, and the
 * call record names only the numbers, so the thread cannot be identified.
 */
function CallBackButton({ number }: { number: string }) {
  const { makeCall } = useCall();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void makeCall(number)}
      className="shrink-0"
    >
      Call back
    </Button>
  );
}
