'use client';

import { PhoneForwarded } from 'lucide-react';
import { useState } from 'react';
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

/**
 * The call bar's transfer button: pick a teammate and the call starts
 * ringing them. The list does not say who is online; the controller answers
 * that when the transfer is attempted.
 */
export function TransferPicker({ disabled }: { disabled: boolean }) {
  const { teammates, teammatesError, refreshTeammates, transferTo } = useCall();
  const [isOpen, setIsOpen] = useState(false);

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
              {teammates.map((teammate) => (
                <CommandItem
                  key={teammate.id}
                  // Names repeat; the id keeps each entry its own.
                  value={`${teammate.name} ${teammate.id}`}
                  keywords={teammate.departments}
                  onSelect={() => {
                    setIsOpen(false);
                    transferTo({ id: teammate.id, name: teammate.name });
                  }}
                >
                  <div>
                    <p className="font-medium">{teammate.name}</p>
                    {teammate.departments.length > 0 && (
                      <p className="text-sm text-muted-foreground">
                        {teammate.departments.join(', ')}
                      </p>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
