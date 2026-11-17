'use client';

import type { MessagingServiceName } from '@repo/dto';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useMessagingServices } from '@/hooks/use-messaging-services';
import { formatPhoneNumber } from '@/lib/phone-number';
import {
  changeServiceTerms,
  choiceOf,
  hasServiceToJoin,
  NO_SERVICE,
  presetValue,
} from '@/lib/phone-numbers/texting-registration';
import { MessagingServicePicker } from './MessagingServicePicker';
import { TermsList } from './TermsList';

interface ChangeMessagingServiceDialogProps {
  /** The number to change; the dialog is open while it is set. */
  phoneNumber: string | null;
  /** The service the page last saw it in, null for none; the move names it. */
  current: MessagingServiceName | null;
  onClose: () => void;
  /** Reports its own failure through `error`. */
  onConfirm: (service: MessagingServiceName) => void;
  isLoading: boolean;
  error: string | null;
}

/** Adds a local number to a messaging service, or moves it to another one. */
export function ChangeMessagingServiceDialog({
  phoneNumber,
  current,
  onClose,
  onConfirm,
  isLoading,
  error,
}: ChangeMessagingServiceDialogProps) {
  const open = phoneNumber !== null;
  const messaging = useMessagingServices(open);
  // Null until the admin picks: a number in none starts on the default, a
  // number in a service on nothing, so an untouched dialog changes nothing.
  const [picked, setPicked] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  if (phoneNumber !== openedFor) {
    setOpenedFor(phoneNumber);
    setPicked(null);
  }

  // This dialog offers no "None", so without a usable default nothing is preset.
  const preset = current ? null : presetValue(messaging.data);
  const value = picked ?? (preset === NO_SERVICE ? null : preset);
  const choice = value === null ? null : choiceOf(messaging.data, value);
  const target = choice?.kind === 'service' ? choice.service : null;

  return (
    <Dialog
      open={open}
      // Closing mid-request would hide a refusal only this dialog shows.
      onOpenChange={(next) => !next && !isLoading && onClose()}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {current ? 'Change the campaign of' : 'Add'}{' '}
            {phoneNumber ? formatPhoneNumber(phoneNumber) : ''}
            {current ? '' : ' to a campaign'}
          </DialogTitle>
          <DialogDescription>
            {current
              ? `Now in the messaging service “${current.friendlyName}”.`
              : 'Now in no messaging service: US carriers block its texts.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <MessagingServicePicker
            id="change-messaging-service"
            services={messaging.data}
            isLoading={messaging.isLoading}
            error={messaging.error}
            value={value}
            onChange={setPicked}
            onRetry={() => void messaging.refetch()}
            purpose="number"
            allowNone={false}
            currentSid={current?.sid ?? null}
            disabled={isLoading}
          />

          {messaging.data?.services &&
            !hasServiceToJoin(messaging.data, current?.sid ?? null) && (
              <p className="text-sm text-muted-foreground">
                {current
                  ? 'No other messaging service on your Twilio account has a campaign this number can join.'
                  : 'No messaging service on your Twilio account has a campaign this number can join.'}{' '}
                Register one in the Twilio Console first.
              </p>
            )}

          {target && <TermsList terms={changeServiceTerms(current, target)} />}

          {error && (
            <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (target) {
                onConfirm({
                  sid: target.sid,
                  friendlyName: target.friendlyName,
                });
              }
            }}
            disabled={isLoading || !target}
          >
            {isLoading
              ? 'Saving...'
              : current
                ? 'Move to this messaging service'
                : 'Add to this messaging service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
