'use client';

import {
  Grid3X3,
  Mic,
  MicOff,
  Pause,
  PhoneForwarded,
  PhoneOff,
  User,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { CallStatus } from '@/hooks/use-telephony-client';
import { formatPhoneNumber } from '@/lib/phone-number';
import { cn } from '@/lib/utils';
import { KeypadModal } from './KeypadModal';

/**
 * Format seconds into MM:SS or HH:MM:SS
 */
function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get call status display text
 */
function getCallStatusText(status: CallStatus, duration: number): string {
  switch (status) {
    case 'connecting':
      return 'Connecting...';
    case 'ringing':
      return 'Ringing...';
    case 'disconnecting':
      return 'Ending...';
    case 'connected':
      return formatDuration(duration);
    case 'disconnected':
      return 'Call ended';
    case 'idle':
      return '';
  }
}

/**
 * ActiveCallBar - Floating pill at bottom of screen during active calls
 * Shows call info and controls (mute, hold, keypad, end)
 */
export function ActiveCallBar() {
  const {
    callStatus,
    remoteNumber,
    callDuration,
    isMuted,
    isEndingCall,
    hangUp,
    toggleMute,
  } = useCall();

  const [isKeypadOpen, setIsKeypadOpen] = useState(false);

  const displayNumber = remoteNumber
    ? formatPhoneNumber(remoteNumber)
    : 'Unknown';
  const statusText = getCallStatusText(callStatus, callDuration);
  const isConnected = callStatus === 'connected';

  return (
    <>
      {/* Floating pill bar */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
        <div className="flex items-center gap-4 bg-card border border-border rounded-2xl px-4 py-3 shadow-lg">
          {/* Avatar and caller info */}
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-muted text-muted-foreground">
                <User className="h-5 w-5" />
              </AvatarFallback>
            </Avatar>

            <div className="flex flex-col">
              <span className="text-sm font-medium">{displayNumber}</span>
              <span
                className={cn(
                  'text-xs',
                  callStatus === 'ringing' && 'text-yellow-500',
                  callStatus === 'connecting' && 'text-blue-500',
                  callStatus === 'disconnecting' && 'text-orange-500',
                  callStatus === 'connected' && 'text-green-500',
                  callStatus === 'disconnected' && 'text-muted-foreground',
                )}
              >
                {statusText}
              </span>
            </div>
          </div>

          {/* Divider */}
          <div className="h-8 w-px bg-border" />

          {/* Call controls */}
          <div className="flex items-center gap-1">
            {/* Mute button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-10 w-10 rounded-full',
                    isMuted && 'bg-yellow-500/20 text-yellow-500',
                  )}
                  onClick={toggleMute}
                  disabled={!isConnected}
                >
                  {isMuted ? (
                    <MicOff className="h-5 w-5" />
                  ) : (
                    <Mic className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isMuted ? 'Unmute' : 'Mute'}</TooltipContent>
            </Tooltip>

            {/* Hold button - disabled for now */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  disabled
                >
                  <Pause className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hold (Coming soon)</TooltipContent>
            </Tooltip>

            {/* Transfer button - disabled for now */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  disabled
                >
                  <PhoneForwarded className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Transfer (Coming soon)</TooltipContent>
            </Tooltip>

            {/* Keypad button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  onClick={() => setIsKeypadOpen(true)}
                  disabled={!isConnected}
                >
                  <Grid3X3 className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Keypad</TooltipContent>
            </Tooltip>

            {/* Add participant - disabled for now */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  disabled
                >
                  <UserPlus className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add (Coming soon)</TooltipContent>
            </Tooltip>

            {/* Divider */}
            <div className="h-8 w-px bg-border mx-1" />

            {/* End call button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  onClick={hangUp}
                  disabled={isEndingCall}
                >
                  <PhoneOff className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>End call</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Keypad modal */}
      <KeypadModal open={isKeypadOpen} onOpenChange={setIsKeypadOpen} />
    </>
  );
}
