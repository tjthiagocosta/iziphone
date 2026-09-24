'use client';

import { useCall } from '@/components/providers/CallProvider';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  type IndicatorStatus,
  indicatorStatus,
} from '@/lib/telephony/availability';
import { connectionStatus } from '@/lib/telephony/connection-status';
import { cn } from '@/lib/utils';

const DOT_CLASS: Record<IndicatorStatus, string> = {
  online: 'bg-green-500',
  dnd: 'bg-red-500',
  connecting: 'bg-yellow-500 animate-pulse',
  offline: 'bg-gray-400',
};

const LABEL: Record<IndicatorStatus, string> = {
  online: 'Online - Ready to receive calls',
  dnd: 'Do not disturb - Calls will not ring here',
  connecting: 'Connecting...',
  offline: 'Offline - Cannot receive calls',
};

/**
 * A colored dot in the navbar: green online, red in do not disturb, pulsing
 * yellow connecting, gray offline. It opens the do not disturb switch.
 */
export function StatusIndicator() {
  const {
    deviceStatus,
    isSocketConnected,
    error,
    doNotDisturb,
    isChangingDoNotDisturb,
    doNotDisturbError,
    setDoNotDisturb,
    reloadDoNotDisturb,
  } = useCall();
  const status = indicatorStatus(
    connectionStatus(deviceStatus, isSocketConnected),
    doNotDisturb,
  );
  const label =
    status === 'offline' && error
      ? `${LABEL[status]}: ${error}`
      : LABEL[status];

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // A switch that could not be read would otherwise stay disabled
        // until the socket reconnects.
        if (open && doNotDisturb === null) {
          reloadDoNotDisturb();
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="relative flex items-center justify-center p-1 rounded-full hover:bg-secondary/50 transition-colors"
              aria-label={label}
            >
              <div
                className={cn(
                  'w-2.5 h-2.5 rounded-full transition-colors',
                  DOT_CLASS[status],
                )}
              />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{label}</p>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={doNotDisturb ?? false}
          disabled={doNotDisturb === null || isChangingDoNotDisturb}
          onCheckedChange={(checked) => setDoNotDisturb(checked)}
          // The menu stays open, so the switch is seen to take.
          onSelect={(event) => event.preventDefault()}
        >
          Do not disturb
        </DropdownMenuCheckboxItem>
        <p className="px-2 pb-1.5 text-xs text-muted-foreground">
          {doNotDisturbError ??
            'Holds back every call offered to you, on all your devices. You can still place calls.'}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
