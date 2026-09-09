'use client';

import { useCall } from '@/components/providers/CallProvider';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type ConnectionStatus = 'online' | 'connecting' | 'offline';

/**
 * Determine overall connection status from device and socket state
 */
function getStatus(
  deviceStatus: string,
  isSocketConnected: boolean,
): ConnectionStatus {
  // Both device ready AND socket connected = online
  if (deviceStatus === 'ready' && isSocketConnected) {
    return 'online';
  }
  // Either one is connecting/ready but not both = connecting
  if (
    deviceStatus === 'connecting' ||
    (deviceStatus === 'ready' && !isSocketConnected) ||
    (deviceStatus !== 'ready' && isSocketConnected)
  ) {
    return 'connecting';
  }
  // Both offline
  return 'offline';
}

/**
 * Get the CSS class for the status indicator dot
 */
function getStatusColor(status: ConnectionStatus): string {
  switch (status) {
    case 'online':
      return 'bg-green-500';
    case 'connecting':
      return 'bg-yellow-500 animate-pulse';
    case 'offline':
      return 'bg-gray-400';
  }
}

/**
 * Get the tooltip label for the status
 */
function getStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'online':
      return 'Online - Ready to receive calls';
    case 'connecting':
      return 'Connecting...';
    case 'offline':
      return 'Offline - Cannot receive calls';
  }
}

/**
 * StatusIndicator - Shows connection status as a small colored dot
 *
 * - Green: Online (socket connected + telephony client ready)
 * - Yellow (pulsing): Connecting
 * - Gray: Offline
 */
export function StatusIndicator() {
  const { deviceStatus, isSocketConnected } = useCall();
  const status = getStatus(deviceStatus, isSocketConnected);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="relative flex items-center justify-center p-1 rounded-full hover:bg-secondary/50 transition-colors"
          aria-label={getStatusLabel(status)}
        >
          <div
            className={cn(
              'w-2.5 h-2.5 rounded-full transition-colors',
              getStatusColor(status),
            )}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {getStatusLabel(status)}
      </TooltipContent>
    </Tooltip>
  );
}
