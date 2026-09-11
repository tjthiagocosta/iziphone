'use client';

import type { MessageSender, UserDepartmentItem } from '@repo/dto';
import { Loader2, Phone } from 'lucide-react';
import { useState } from 'react';
import {
  InboxList,
  type InboxTabOption,
  InboxTabs,
} from '@/components/inbox/InboxList';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useInbox } from '@/hooks/use-inbox';
import { useMessageSenders } from '@/hooks/use-message-senders';
import { useUserDepartments } from '@/hooks/use-user-departments';
import type { InboxTab } from '@/lib/inbox/inbox-item';
import { lineDescription } from '@/lib/line';
import { cn } from '@/lib/utils';

interface DepartmentViewProps {
  departmentId: string;
}

/*
 * Operators and Live calls are not here: the departments endpoint returns no
 * members, and nothing serves a live-call feed. Recordings and Spam are gone
 * for the reasons the main inbox lists.
 */
const TABS: InboxTabOption[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'calls', label: 'Calls' },
  { value: 'missed', label: 'Missed' },
  { value: 'voicemails', label: 'Voicemails' },
  { value: 'messages', label: 'Messages' },
];

export function DepartmentView({ departmentId }: DepartmentViewProps) {
  const { departments, isLoading } = useUserDepartments();
  const { senders, isLoading: loadingSenders } = useMessageSenders();

  const department = departments.find((item) => item.id === departmentId);

  if (isLoading || loadingSenders) {
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

  return (
    <DepartmentInbox
      department={department}
      lines={departmentLines(department, senders)}
      // Another department is another inbox: start it on its own default
      // line and its first tab rather than keeping this one's.
      key={departmentId}
    />
  );
}

/** A number this department answers on, and its messaging id when it has one. */
interface DepartmentLine {
  phoneNumber: string;
  isDefault: boolean;
  label: string | null;
  /*
   * The senders endpoint lists only numbers that carry SMS or MMS, while the
   * department lists every number it answers on, so a voice-only line is here
   * with no id and reads call history alone.
   */
  sourcePhoneNumberId: string | null;
}

function departmentLines(
  department: UserDepartmentItem,
  senders: readonly MessageSender[],
): DepartmentLine[] {
  return department.phoneNumbers.map((number) => {
    const sender = senders.find(
      (option) =>
        option.ownerType === 'department' &&
        option.ownerId === department.id &&
        option.phoneNumber === number.number,
    );

    return {
      phoneNumber: number.number,
      isDefault: number.isDefault,
      // From the department rather than the sender: a voice-only line has no
      // sender to read a label from and still has to be named in the picker.
      label: number.label,
      sourcePhoneNumberId: sender?.id ?? null,
    };
  });
}

function DepartmentInbox({
  department,
  lines,
}: {
  department: UserDepartmentItem;
  lines: readonly DepartmentLine[];
}) {
  const [activeTab, setActiveTab] = useState<InboxTab>('all');
  const [selected, setSelected] = useState<string | null>(null);

  /*
   * Both list endpoints take one line, and a department can hold several, so
   * the page is one line at a time rather than a merge the reader cannot page
   * through. The default number opens first.
   */
  const line =
    lines.find((option) => option.phoneNumber === selected) ??
    lines.find((option) => option.isDefault) ??
    lines[0];

  const inbox = useInbox(
    activeTab,
    line
      ? {
          linePhone: line.phoneNumber,
          sourcePhoneNumberId: line.sourcePhoneNumberId,
        }
      : undefined,
  );

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className={cn('w-6 h-6 rounded', department.color)} />
          <div>
            <h1 className="text-xl font-semibold">{department.name}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="outline" className="gap-1 text-xs">
                <Phone className="h-3 w-3" />
                Voice
              </Badge>
              {lines.length > 1 && line ? (
                <LinePicker
                  lines={lines}
                  selected={line}
                  onSelect={(option) => setSelected(option.phoneNumber)}
                />
              ) : (
                <span>
                  {line ? lineDescription(line) : 'No number assigned'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <InboxTabs tabs={TABS} value={activeTab} onChange={setActiveTab} />

      {line ? (
        <InboxList {...inbox} />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted-foreground">
            This department has no phone number yet.
          </p>
        </div>
      )}
    </div>
  );
}

function LinePicker({
  lines,
  selected,
  onSelect,
}: {
  lines: readonly DepartmentLine[];
  selected: DepartmentLine;
  onSelect: (line: DepartmentLine) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
          {lineDescription(selected)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {lines.map((line) => (
          <DropdownMenuItem
            key={line.phoneNumber}
            onClick={() => onSelect(line)}
          >
            {lineDescription(line)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
