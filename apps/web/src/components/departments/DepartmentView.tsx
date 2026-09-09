'use client';

import {
  ChevronDown,
  Loader2,
  Phone,
  Play,
  RefreshCw,
  User,
} from 'lucide-react';
import { useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUserDepartments } from '@/hooks/use-user-departments';
import {
  formatDuration,
  formatPhoneNumber,
  formatRelativeTime,
  mockContacts,
  mockRecentInteractions,
} from '@/lib/mock-data';
import { cn } from '@/lib/utils';

interface DepartmentViewProps {
  departmentId: string;
}

type DepartmentTab =
  | 'live-calls'
  | 'operators'
  | 'new'
  | 'all'
  | 'missed'
  | 'messages'
  | 'voicemails'
  | 'recordings'
  | 'spam';

const TABS: { value: DepartmentTab; label: string }[] = [
  { value: 'live-calls', label: 'Live Calls' },
  { value: 'operators', label: 'Operators' },
  { value: 'new', label: 'New' },
  { value: 'all', label: 'All' },
  { value: 'missed', label: 'Missed' },
  { value: 'messages', label: 'Messages' },
  { value: 'voicemails', label: 'Voicemails' },
  { value: 'recordings', label: 'Recordings' },
  { value: 'spam', label: 'Spam' },
];

export function DepartmentView({ departmentId }: DepartmentViewProps) {
  const [activeTab, setActiveTab] = useState<DepartmentTab>('live-calls');
  const [isActive, setIsActive] = useState(true);
  const { departments, isLoading } = useUserDepartments();

  // Find department from user's departments
  const department = departments.find((d) => d.id === departmentId);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!department) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Department not found</p>
      </div>
    );
  }

  // Get department members (mock - filter contacts with department badge)
  const operators = mockContacts.filter((c) => c.departmentBadge);

  // Get department recordings (mock)
  const recordings = mockRecentInteractions.filter(
    (i) => (i.type === 'call' || i.type === 'voicemail') && i.duration,
  );

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Department Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn('w-6 h-6 rounded', department.color)} />
            <div>
              <h1 className="text-xl font-semibold">{department.name}</h1>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" className="gap-1 text-xs">
                  <Phone className="h-3 w-3" />
                  Voice
                </Badge>
                <span>
                  {formatPhoneNumber(
                    department.phoneNumbers.find((p) => p.isDefault)?.number ||
                      department.phoneNumbers[0]?.number ||
                      '',
                  )}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Active</span>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as DepartmentTab)}
        className="flex-1 flex flex-col"
      >
        <div className="border-b border-border px-4">
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
        </div>

        {/* Live Calls Tab */}
        <TabsContent value="live-calls" className="flex-1 mt-0">
          <div className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
              <span>Current live calls.</span>
              <Button variant="link" size="sm" className="h-auto p-0 text-info">
                Refresh
              </Button>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              <User className="h-10 w-10 p-2 rounded-full bg-secondary" />
              <span>No calls are live.</span>
            </div>
          </div>
        </TabsContent>

        {/* Operators Tab */}
        <TabsContent value="operators" className="flex-1 mt-0">
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="gap-1">
                  Name
                  <ChevronDown className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="sm" className="gap-1">
                  Status
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Sort by: Operators on call
                </span>
                <Button variant="ghost" size="sm" className="gap-1">
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
              </div>
            </div>

            <ScrollArea className="h-[calc(100vh-280px)]">
              <div className="space-y-2">
                {operators.map((operator) => (
                  <OperatorItem key={operator.id} operator={operator} />
                ))}
              </div>
            </ScrollArea>
          </div>
        </TabsContent>

        {/* Recordings Tab */}
        <TabsContent value="recordings" className="flex-1 mt-0">
          <ScrollArea className="h-[calc(100vh-200px)]">
            <div className="divide-y divide-border">
              {recordings.map((recording) => (
                <RecordingItem key={recording.id} recording={recording} />
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Other tabs - placeholder content */}
        {['new', 'all', 'missed', 'messages', 'voicemails', 'spam'].map(
          (tab) => (
            <TabsContent key={tab} value={tab} className="flex-1 mt-0">
              <div className="flex items-center justify-center h-64">
                <p className="text-muted-foreground">No items found</p>
              </div>
            </TabsContent>
          ),
        )}
      </Tabs>
    </div>
  );
}

interface OperatorItemProps {
  operator: (typeof mockContacts)[0];
}

function OperatorItem({ operator }: OperatorItemProps) {
  const [isActive, setIsActive] = useState(true);

  return (
    <div className="flex items-center gap-4 p-3 rounded-lg hover:bg-secondary/50 transition-colors">
      <div className="relative">
        <Avatar className="h-10 w-10">
          <AvatarFallback className={cn(operator.avatarColor, 'text-white')}>
            {operator.initials}
          </AvatarFallback>
        </Avatar>
        {operator.status === 'available' && (
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-background" />
        )}
      </div>

      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">
            {operator.name || formatPhoneNumber(operator.phoneNumber)}
          </span>
        </div>
        <button
          type="button"
          className="text-sm text-muted-foreground flex items-center gap-1 hover:text-foreground"
        >
          2 departments
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      <span className="text-sm text-success">Available</span>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Active</span>
        <Switch checked={isActive} onCheckedChange={setIsActive} />
      </div>
    </div>
  );
}

interface RecordingItemProps {
  recording: (typeof mockRecentInteractions)[0];
}

function RecordingItem({ recording }: RecordingItemProps) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 hover:bg-secondary/50 transition-colors">
      <Badge variant="outline" className="text-xs">
        REC
      </Badge>

      <span className="text-sm w-32 truncate">
        {recording.contact.name || 'Unknown'}
      </span>

      <span className="text-sm text-muted-foreground w-32 truncate">
        {formatPhoneNumber(recording.to)}
      </span>

      {/* Audio player placeholder */}
      <div className="flex-1 flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <Play className="h-4 w-4" />
        </Button>
        <div className="flex-1 h-1 bg-secondary rounded-full">
          <div className="w-0 h-full bg-success rounded-full" />
        </div>
      </div>

      <span className="text-sm text-muted-foreground w-12">
        {recording.duration ? formatDuration(recording.duration) : '0:00'}
      </span>

      <span className="text-sm text-muted-foreground w-24 text-right">
        {formatRelativeTime(recording.timestamp)}
      </span>
    </div>
  );
}
