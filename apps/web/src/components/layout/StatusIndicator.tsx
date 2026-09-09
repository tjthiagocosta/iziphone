'use client';

import { useCall } from '@/components/providers/CallProvider';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  type ConnectionStatus,
  connectionStatus,
} from '@/lib/telephony/connection-status';
import { cn } from '@/lib/utils';

const DOT_CLASS: Record<ConnectionStatus, string> = {
  online: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  offline: 'bg-gray-400',
};

const LABEL: Record<ConnectionStatus, string> = {
  online: 'Online - Ready to receive calls',
  connecting: 'Connecting...',
  offline: 'Offline - Cannot receive calls',
};

/** A colored dot in the navbar: green online, pulsing yellow connecting, gray offline. */
export function StatusIndicator() {
  const { deviceStatus, isSocketConnected, error } = useCall();
  const status = connectionStatus(deviceStatus, isSocketConnected);
  const label =
    status === 'offline' && error
      ? `${LABEL[status]}: ${error}`
      : LABEL[status];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
