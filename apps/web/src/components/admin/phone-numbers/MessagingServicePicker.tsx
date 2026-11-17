'use client';

import type { MessagingServicesResponse } from '@repo/dto';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  NO_SERVICE,
  optionRefusal,
  type ServicePurpose,
  serviceOptionLabel,
} from '@/lib/phone-numbers/texting-registration';

interface MessagingServicePickerProps {
  id: string;
  services: MessagingServicesResponse | null;
  isLoading: boolean;
  error: Error | null;
  /** A service's sid, `NO_SERVICE`, or null while there is nothing to pick. */
  value: string | null;
  onChange: (value: string) => void;
  onRetry: () => void;
  purpose: ServicePurpose;
  /** Whether "None" is offered; a move always names a service. */
  allowNone?: boolean;
  noneLabel?: string;
  /** The service the number is in now, listed but not chosen again. */
  currentSid?: string | null;
  disabled?: boolean;
}

/**
 * The account's messaging services, each with its campaign. One whose
 * campaign registers nothing, or that cannot be the default, is listed but
 * cannot be picked, and says why.
 */
export function MessagingServicePicker({
  id,
  services,
  isLoading,
  error,
  value,
  onChange,
  onRetry,
  purpose,
  allowNone = true,
  noneLabel = 'None: it does not text yet',
  currentSid = null,
  disabled = false,
}: MessagingServicePickerProps) {
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading the messaging services from Twilio…
      </p>
    );
  }

  if (error || !services?.services) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>
          {error?.message ??
            'The messaging services on your Twilio account could not be read.'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={disabled}
        >
          <RefreshCw className="mr-2 h-3 w-3" />
          Try again
        </Button>
      </div>
    );
  }

  const list = services.services;

  if (list.length === 0 && !allowNone) {
    return (
      <p className="text-sm text-muted-foreground">
        Your Twilio account has no messaging services. Create one with an A2P
        10DLC campaign in the Twilio Console first.
      </p>
    );
  }

  return (
    <Select
      value={value ?? undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Choose a messaging service" />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NO_SERVICE}>{noneLabel}</SelectItem>}
        {list.map((service) => {
          const refusal =
            service.sid === currentSid
              ? 'it is in this one now'
              : optionRefusal(service, purpose);
          const isDefault =
            purpose === 'number' && service.sid === services.defaultSid;

          return (
            <SelectItem
              key={service.sid}
              value={service.sid}
              disabled={refusal !== null}
            >
              {serviceOptionLabel(service, list)}
              {isDefault ? ' (default)' : ''}
              {refusal ? ` (${refusal})` : ''}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
