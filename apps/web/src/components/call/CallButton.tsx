'use client';

import type { OutboundCallLine } from '@repo/dto';
import { Button, type ButtonProps } from '@/components/ui/button';
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
import type { CallEligibility } from '@/lib/telephony/call-line';
import { cn } from '@/lib/utils';

interface CallButtonProps
  extends Omit<ButtonProps, 'onClick' | 'disabled' | 'aria-disabled'> {
  eligibility: CallEligibility;
  /** What the tooltip says while the call can be placed. */
  label: string;
  onCall: (line: OutboundCallLine) => void;
}

/** A button that starts a call from a line, or says why it cannot. */
export function CallButton({
  eligibility,
  label,
  onCall,
  className,
  children,
  ...props
}: CallButtonProps) {
  if (!eligibility.canCall) {
    /*
     * `aria-disabled` rather than `disabled`: a disabled button takes neither
     * the pointer, a tap nor focus, and the reason would be out of reach. It
     * is the title for whoever hovers or listens, and pressing the button,
     * which is all a touch screen offers, opens it instead of calling.
     */
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            {...props}
            aria-disabled
            title={eligibility.reason}
            className={cn(
              className,
              'opacity-50 cursor-not-allowed hover:bg-transparent',
            )}
          >
            {children}
          </Button>
        </PopoverTrigger>
        <PopoverContent role="status" className="w-auto max-w-xs p-3 text-sm">
          {eligibility.reason}
        </PopoverContent>
      </Popover>
    );
  }

  const { line } = eligibility;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props} className={className} onClick={() => onCall(line)}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
