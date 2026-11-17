'use client';

import type { MessagingServicesResponse } from '@repo/dto';
import { useEffect, useState } from 'react';
import { MessagingServicePicker } from '@/components/admin/phone-numbers/MessagingServicePicker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NO_SERVICE } from '@/lib/phone-numbers/texting-registration';

interface DefaultMessagingServiceFormProps {
  services: MessagingServicesResponse | null;
  isLoading: boolean;
  error: Error | null;
  isSaving: boolean;
  saveError: Error | null;
  onRetry: () => void;
  onSave: (messagingServiceSid: string | null) => void;
}

/**
 * The messaging service a new local number joins unless the admin picks
 * another one on Buy or Add. Only one whose campaign may register texts, and
 * that passes incoming texts on to iziphone, can be the default.
 */
export function DefaultMessagingServiceForm({
  services,
  isLoading,
  error,
  isSaving,
  saveError,
  onRetry,
  onSave,
}: DefaultMessagingServiceFormProps) {
  const stored = services?.defaultSid ?? null;
  const [draft, setDraft] = useState<string>(stored ?? NO_SERVICE);

  // A save answers with what was stored, and a reload with what is stored.
  useEffect(() => setDraft(stored ?? NO_SERVICE), [stored]);

  const missing =
    stored !== null &&
    services?.services != null &&
    !services.services.some((service) => service.sid === stored);
  const chosen = draft === NO_SERVICE ? null : draft;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(chosen);
      }}
    >
      <div className="space-y-2 max-w-xl">
        <Label htmlFor="default-messaging-service">New numbers join</Label>
        <MessagingServicePicker
          id="default-messaging-service"
          services={services}
          isLoading={isLoading}
          error={error}
          value={missing && draft === stored ? null : draft}
          onChange={setDraft}
          onRetry={onRetry}
          purpose="default"
          noneLabel="None: new numbers join no messaging service"
          disabled={isSaving}
        />
        {missing && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            The messaging service set as the default is no longer on your Twilio
            account, so new numbers join none. Choose another one, or None.
          </p>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        A US local number’s texts are delivered only while it is a sender of a
        messaging service whose A2P 10DLC campaign is approved. Brands and
        campaigns are registered in the Twilio Console; iziphone only adds
        numbers to the services that hold them, and never changes a service’s
        own settings. A service cannot be the default while its campaign is
        missing or was not approved, or while it sends its senders’ incoming
        texts to an address of its own.
      </p>

      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {saveError.message}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSaving || isLoading || (chosen === stored && !missing)}
      >
        {isSaving ? 'Saving…' : 'Save default'}
      </Button>
    </form>
  );
}
