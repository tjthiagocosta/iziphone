'use client';

import { ChevronDown } from 'lucide-react';
import { useCall } from '@/components/providers/CallProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { lineDescription } from '@/lib/line';
import { callFromChosenLine } from '@/lib/telephony/call-line';
import { cn } from '@/lib/utils';

/**
 * "Call from", for the places where no conversation decides the line. It
 * names the line the call will leave from, offers the others when there are
 * any, and says why when the user has none. A thread needs no picker: its
 * calls leave from the line the thread is on.
 */
export function CallLinePicker({ className }: { className?: string }) {
  const { callLines, reloadCallLines, chosenCallLineId, chooseCallLine } =
    useCall();
  const eligibility = callFromChosenLine(callLines, chosenCallLineId);

  if (!eligibility.canCall) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        {eligibility.reason}
        {callLines.status === 'failed' && (
          <Button
            variant="link"
            className="h-auto p-0 ml-2 text-sm"
            onClick={reloadCallLines}
          >
            Try again
          </Button>
        )}
      </p>
    );
  }

  const lines = callLines.status === 'loaded' ? callLines.lines : [];

  // One line is no choice: name it and stay out of the way.
  if (lines.length < 2) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        Calling from {lineDescription(eligibility.line)}
      </p>
    );
  }

  return (
    <div className={cn('flex items-center gap-2 text-sm', className)}>
      <span className="text-muted-foreground">Call from</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto p-0 hover:bg-transparent justify-start gap-1.5 text-sm"
          >
            {lineDescription(eligibility.line)}
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          {lines.map((line) => (
            <DropdownMenuItem
              key={line.id}
              onClick={() => chooseCallLine(line.id)}
            >
              {lineDescription(line)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
