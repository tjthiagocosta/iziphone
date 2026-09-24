'use client';

import { PhoneForwarded } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { useCall } from '@/components/providers/CallProvider';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTeammateAvailability } from '@/hooks/use-teammate-availability';
import { transferChoiceOf } from '@/lib/telephony/availability';

/**
 * The call bar's transfer button: pick a teammate and the call starts
 * ringing them. While the list is open it shows who is on a call, in do not
 * disturb or offline, and does not let them be picked. That is only a
 * courtesy: the controller refuses such a transfer whatever the list said.
 */
export function TransferPicker({ disabled }: { disabled: boolean }) {
  const { teammates, teammatesError, refreshTeammates, transferTo } = useCall();
  const { getRealtimeToken } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const availability = useTeammateAvailability({
    userIds: teammates.map((teammate) => teammate.id),
    enabled: isOpen,
    getRealtimeToken,
  });

  // A list that was open when the call stopped being transferable is closed
  // for good, or it would open by itself on the next call that can be.
  if (disabled && isOpen) {
    setIsOpen(false);
  }

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      // People join and leave while a tab stays open.
      void refreshTeammates();
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-full"
              disabled={disabled}
              aria-label="Transfer"
            >
              <PhoneForwarded className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Transfer</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80 p-0" side="top" align="center">
        <Command>
          <CommandInput placeholder="Transfer to..." />
          <CommandList>
            <CommandEmpty>
              {teammatesError
                ? 'The team could not be loaded.'
                : 'No teammates found.'}
            </CommandEmpty>
            <CommandGroup>
              {teammates.map((teammate) => {
                const choice = transferChoiceOf(
                  availability.get(teammate.id)?.state,
                );
                return (
                  <CommandItem
                    key={teammate.id}
                    // Names repeat; the id keeps each entry its own.
                    value={`${teammate.name} ${teammate.id}`}
                    keywords={teammate.departments}
                    disabled={!choice.selectable}
                    onSelect={() => {
                      setIsOpen(false);
                      transferTo({ id: teammate.id, name: teammate.name });
                    }}
                  >
                    <div className="flex w-full items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{teammate.name}</p>
                        {teammate.departments.length > 0 && (
                          <p className="text-sm text-muted-foreground">
                            {teammate.departments.join(', ')}
                          </p>
                        )}
                      </div>
                      {choice.reason && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {choice.reason}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
