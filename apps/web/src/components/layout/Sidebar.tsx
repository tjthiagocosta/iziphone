'use client';

import type { MessageConversationListItem } from '@repo/dto';
import { ChevronDown, ChevronRight, Inbox, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMessageConversations } from '@/hooks/use-message-conversations';
import { useUserDepartments } from '@/hooks/use-user-departments';
import { avatarColorFor } from '@/lib/avatar-color';
import { initialsOf } from '@/lib/initials';
import { lineName } from '@/lib/line';
import { formatPhoneNumber } from '@/lib/phone-number';
import { cn } from '@/lib/utils';

const RECENTS_LIMIT = 15;

interface SidebarItemProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  isActive?: boolean;
}

function SidebarItem({ href, icon, label, badge, isActive }: SidebarItemProps) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
        isActive
          ? 'bg-sidebar-active text-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground',
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge !== undefined && badge > 0 && (
        <Badge
          variant="secondary"
          className="h-5 min-w-5 px-1.5 justify-center"
        >
          {badge}
        </Badge>
      )}
    </Link>
  );
}

interface RecentItemProps {
  /** The conversation, not the contact: one contact has one per line. */
  conversationId: string;
  contact: MessageConversationListItem['contact'];
  line: string;
  isActive?: boolean;
}

function RecentItem({
  conversationId,
  contact,
  line,
  isActive,
}: RecentItemProps) {
  return (
    <Link
      href={`/app/conversations/${conversationId}`}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
        isActive
          ? 'bg-sidebar-active text-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground',
      )}
    >
      <Avatar className="h-7 w-7">
        <AvatarFallback
          className={cn(avatarColorFor(contact.id), 'text-white text-xs')}
        >
          {initialsOf(contact.name, contact.phoneNumber.slice(-2))}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className="truncate">
          {contact.name ?? formatPhoneNumber(contact.phoneNumber)}
        </p>
        {/* Which of our numbers the thread is on: the same person can be
            here twice, once per line. */}
        <p className="truncate text-xs text-muted-foreground">{line}</p>
      </div>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [departmentsExpanded, setDepartmentsExpanded] = useState(true);
  const { departments, isLoading: departmentsLoading } = useUserDepartments();

  const { conversations } = useMessageConversations({ limit: RECENTS_LIMIT });

  return (
    <aside className="w-60 bg-sidebar border-r border-border flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {/* Main Navigation */}
          <SidebarItem
            href="/app/inbox"
            icon={<Inbox className="h-5 w-5" />}
            label="Inbox"
            isActive={pathname === '/app/inbox' || pathname === '/app'}
          />
          <SidebarItem
            href="/app/contacts"
            icon={<Users className="h-5 w-5" />}
            label="Contacts"
            isActive={pathname === '/app/contacts'}
          />

          {/* Departments Section */}
          <div className="pt-4">
            <button
              type="button"
              onClick={() => setDepartmentsExpanded(!departmentsExpanded)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider w-full hover:text-foreground transition-colors"
            >
              {departmentsExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              Departments
            </button>
            {departmentsExpanded && (
              <div className="mt-1 space-y-0.5">
                {departmentsLoading ? (
                  <div className="px-3 py-2 space-y-2">
                    <div className="h-4 bg-muted rounded animate-pulse" />
                    <div className="h-4 bg-muted rounded animate-pulse w-3/4" />
                  </div>
                ) : departments.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No departments assigned
                  </div>
                ) : (
                  departments.map((dept) => (
                    <Link
                      key={dept.id}
                      href={`/app/departments/${dept.id}`}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                        pathname === `/app/departments/${dept.id}`
                          ? 'bg-sidebar-active text-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground',
                      )}
                    >
                      <div className={cn('w-4 h-4 rounded', dept.color)} />
                      <span className="truncate">{dept.name}</span>
                    </Link>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Recents Section */}
          <div className="pt-4">
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <ChevronDown className="h-4 w-4" />
              Recents
            </div>
            <div className="mt-1 space-y-0.5">
              {conversations.map((conversation) => (
                <RecentItem
                  key={conversation.id}
                  conversationId={conversation.id}
                  contact={conversation.contact}
                  line={lineName(conversation.sourcePhoneNumber)}
                  isActive={
                    pathname === `/app/conversations/${conversation.id}`
                  }
                />
              ))}

              {conversations.length === 0 && (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No conversations yet
                </p>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}
