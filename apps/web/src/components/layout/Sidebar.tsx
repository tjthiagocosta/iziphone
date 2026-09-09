'use client';

import { ChevronDown, ChevronRight, Inbox, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useUserDepartments } from '@/hooks/use-user-departments';
import { formatPhoneNumber, mockRecentInteractions } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

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
  id: string;
  name: string | null;
  phoneNumber: string;
  avatarColor: string;
  initials: string;
  status?: 'available' | 'dnd' | 'offline';
  isActive?: boolean;
}

function RecentItem({
  id,
  name,
  phoneNumber,
  avatarColor,
  initials,
  status,
  isActive,
}: RecentItemProps) {
  return (
    <Link
      href={`/app/conversations/${id}`}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
        isActive
          ? 'bg-sidebar-active text-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground',
      )}
    >
      <div className="relative">
        <Avatar className="h-7 w-7">
          <AvatarFallback className={cn(avatarColor, 'text-white text-xs')}>
            {initials}
          </AvatarFallback>
        </Avatar>
        {status === 'dnd' && (
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-warning border-2 border-sidebar" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="truncate">{name || formatPhoneNumber(phoneNumber)}</p>
        {status === 'dnd' && <p className="text-xs text-warning">DND</p>}
      </div>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [departmentsExpanded, setDepartmentsExpanded] = useState(true);
  const { departments, isLoading: departmentsLoading } = useUserDepartments();

  // Get unique contacts from recent interactions
  const recentContacts = mockRecentInteractions
    .reduce(
      (acc, interaction) => {
        const existing = acc.find((c) => c.id === interaction.contact.id);
        if (!existing) {
          acc.push(interaction.contact);
        }
        return acc;
      },
      [] as (typeof mockRecentInteractions)[0]['contact'][],
    )
    .slice(0, 15);

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
              {recentContacts.map((contact) => (
                <RecentItem
                  key={contact.id}
                  id={contact.id}
                  name={contact.name}
                  phoneNumber={contact.phoneNumber}
                  avatarColor={contact.avatarColor}
                  initials={contact.initials}
                  status={contact.status}
                  isActive={pathname === `/app/conversations/${contact.id}`}
                />
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}
