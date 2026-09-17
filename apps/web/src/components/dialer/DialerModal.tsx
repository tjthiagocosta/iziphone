'use client';

import { Delete, Phone, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CallLinePicker } from '@/components/call';
import { useCall } from '@/components/providers/CallProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useMessageConversations } from '@/hooks/use-message-conversations';
import { avatarColorFor } from '@/lib/avatar-color';
import { initialsOf } from '@/lib/initials';
import { formatPhoneNumber } from '@/lib/phone-number';
import { callFromChosenLine } from '@/lib/telephony/call-line';
import { cn } from '@/lib/utils';

interface DialerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const QUICK_DIAL_COUNT = 6;

const KEYPAD_KEYS = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

/*
 * A typed number belongs to no conversation, so the line it is called from is
 * the one chosen in the picker under the number. The other party sees that
 * line as the caller, and the call is kept on it.
 */
export function DialerModal({ open, onOpenChange }: DialerModalProps) {
  const [phoneNumber, setPhoneNumber] = useState('');
  const {
    makeCall,
    deviceStatus,
    callLines,
    reloadCallLines,
    chosenCallLineId,
  } = useCall();
  const eligibility = callFromChosenLine(callLines, chosenCallLineId);
  const callLine = eligibility.canCall ? eligibility.line.phoneNumber : null;

  // The lines are about to be chosen from, and an administrator may have
  // changed them since the tab was opened.
  useEffect(() => {
    if (open) {
      reloadCallLines();
    }
  }, [open, reloadCallLines]);
  const { conversations } = useMessageConversations({
    limit: QUICK_DIAL_COUNT,
  });

  const handleKeyPress = useCallback((digit: string) => {
    setPhoneNumber((prev) => prev + digit);
  }, []);

  const handleBackspace = useCallback(() => {
    setPhoneNumber((prev) => prev.slice(0, -1));
  }, []);

  const handleCall = useCallback(async () => {
    if (phoneNumber.trim() && deviceStatus === 'ready' && callLine) {
      await makeCall(phoneNumber, callLine);
      onOpenChange(false);
    }
  }, [phoneNumber, deviceStatus, callLine, makeCall, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 bg-popover border-border">
        <DialogTitle className="sr-only">New call</DialogTitle>

        <div className="px-6 pt-6 pb-4">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              placeholder="Type a number"
              className="pl-12 h-12 text-lg bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 focus-visible:border-primary placeholder:text-muted-foreground/50"
            />
            {phoneNumber && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8"
                onClick={handleBackspace}
                aria-label="Delete the last digit"
              >
                <Delete className="h-5 w-5" />
              </Button>
            )}
          </div>
          <CallLinePicker className="mt-3" />
        </div>

        {conversations.length > 0 && (
          <div className="px-6 pb-4">
            <div className="flex items-center justify-center gap-4">
              {conversations.map(({ id, contact }) => (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setPhoneNumber(contact.phoneNumber)}
                      className="flex flex-col items-center gap-1 group"
                    >
                      <Avatar className="h-12 w-12 transition-transform group-hover:scale-105">
                        <AvatarFallback
                          className={cn(
                            avatarColorFor(contact.id),
                            'text-white',
                          )}
                        >
                          {initialsOf(
                            contact.name,
                            contact.phoneNumber.slice(-2),
                          )}
                        </AvatarFallback>
                      </Avatar>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {contact.name ?? formatPhoneNumber(contact.phoneNumber)}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        )}

        <div className="px-6 pb-6">
          <div className="grid grid-cols-3 gap-4">
            {KEYPAD_KEYS.map((key) => (
              <button
                type="button"
                key={key.digit}
                onClick={() => handleKeyPress(key.digit)}
                className="flex flex-col items-center justify-center h-16 rounded-full hover:bg-secondary transition-colors"
              >
                <span className="text-2xl font-light">{key.digit}</span>
                {key.letters && (
                  <span className="text-[10px] text-muted-foreground tracking-widest">
                    {key.letters}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex flex-col items-center gap-2 mt-6">
            <Button
              type="button"
              onClick={() => void handleCall()}
              disabled={
                !phoneNumber.trim() || deviceStatus !== 'ready' || !callLine
              }
              className="h-14 w-14 rounded-full bg-green-600 hover:bg-green-700 disabled:bg-muted disabled:text-muted-foreground"
              aria-label="Call"
            >
              <Phone className="h-6 w-6" />
            </Button>
            {deviceStatus !== 'ready' && (
              <p className="text-xs text-muted-foreground">
                Your phone is not connected yet.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
