'use client';

import {
  Grid3X3,
  Mic,
  MicOff,
  Pause,
  PhoneOff,
  Play,
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
import { formatPhoneNumber } from '@/lib/phone-number';
import {
  type CallStatusTone,
  callStatusLine,
} from '@/lib/telephony/call-status-line';
import { cn } from '@/lib/utils';
import { KeypadModal } from './KeypadModal';
import { TransferPicker } from './TransferPicker';

const TONE_CLASS: Record<CallStatusTone, string> = {
  ringing: 'text-yellow-500',
  connecting: 'text-blue-500',
  connected: 'text-green-500',
  held: 'text-yellow-500',
  transferring: 'text-blue-500',
  ending: 'text-orange-500',
  over: 'text-muted-foreground',
};

/**
 * ActiveCallBar - Floating pill at bottom of screen during active calls
 * Shows call info and controls (mute, hold, transfer, keypad, end)
 */
export function ActiveCallBar() {
  const {
    callStatus,
    remoteNumber,
    callDuration,
    isMuted,
    isOnHold,
    isHoldPending,
    transfer,
    notice,
    endReason,
    error,
    isEndingCall,
    hangUp,
    toggleMute,
    toggleHold,
    cancelTransfer,
  } = useCall();

  const [isKeypadOpen, setIsKeypadOpen] = useState(false);

  const displayNumber = remoteNumber
    ? formatPhoneNumber(remoteNumber)
    : 'Unknown';
  const statusLine = callStatusLine(
    { callStatus, isOnHold, transfer, endReason },
    callDuration,
  );
  const isConnected = callStatus === 'connected';
  // While a transfer holds the call, hold and a second transfer are refused.
  const canControlCall = isConnected && !transfer;
  // Not before the controller confirms the ring: until then it may not have
  // a transfer to cancel yet.
  const canCancelTransfer = transfer?.status === 'ringing';
  const message = error ?? notice;

  return (
    <>
      {/* Floating pill bar */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
        {message && (
          <p
            role="status"
            className="max-w-md rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-lg"
          >
            {message}
          </p>
        )}
        <div
          className={cn(
            'flex items-center gap-4 bg-card border border-border rounded-2xl px-4 py-3 shadow-lg',
            isOnHold && 'border-yellow-500/60',
          )}
        >
          {/* Avatar and caller info */}
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-muted text-muted-foreground">
                <User className="h-5 w-5" />
              </AvatarFallback>
            </Avatar>

            <div className="flex flex-col">
              <span className="text-sm font-medium">{displayNumber}</span>
              <span className={cn('text-xs', TONE_CLASS[statusLine.tone])}>
                {statusLine.text}
              </span>
            </div>

            {transfer && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cancelTransfer}
                disabled={!canCancelTransfer}
              >
                Cancel
              </Button>
            )}
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

            {/* Hold button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-10 w-10 rounded-full',
                    isOnHold && 'bg-yellow-500/20 text-yellow-500',
                  )}
                  onClick={toggleHold}
                  disabled={!canControlCall || isHoldPending}
                  aria-label={isOnHold ? 'Resume' : 'Hold'}
                  aria-pressed={isOnHold}
                >
                  {isOnHold ? (
                    <Play className="h-5 w-5" />
                  ) : (
                    <Pause className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isOnHold ? 'Resume' : 'Hold'}</TooltipContent>
            </Tooltip>

            {/* Transfer button */}
            <TransferPicker disabled={!canControlCall || isHoldPending} />

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
