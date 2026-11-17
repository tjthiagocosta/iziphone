'use client';

import type {
  ImportPhoneNumber,
  MessagingServicesResponse,
  OwnedPhoneNumber,
} from '@repo/dto';
import { ArrowLeft, Check, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { useOwnedNumbers } from '@/hooks/use-admin-phone-numbers';
import { useMessagingServices } from '@/hooks/use-messaging-services';
import { formatPhoneNumber } from '@/lib/phone-number';
import {
  attachedToday,
  importTerms,
  NUMBER_TYPE_LABELS,
} from '@/lib/phone-numbers/number-terms';
import {
  chosenHolder,
  type OwnerSelection,
  ownerOf,
  RESERVE_SELECTION,
} from '@/lib/phone-numbers/owner-selection';
import {
  choiceOf,
  mayChooseServiceOnImport,
  presetValue,
  requestFieldOf,
} from '@/lib/phone-numbers/texting-registration';
import { cn } from '@/lib/utils';
import { CapabilityBadges } from './CapabilityBadges';
import { MessagingServicePicker } from './MessagingServicePicker';
import { OwnerPicker } from './OwnerPicker';
import { TermsList } from './TermsList';

type Step = 'choose' | 'confirm';

interface ImportNumberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rejects with the reason when the number was not added. */
  onImport: (data: ImportPhoneNumber) => Promise<void>;
  isLoading?: boolean;
}

/**
 * Adds a number the Twilio account already holds: one bought or restored in
 * the Twilio Console, or one that served something else until now.
 */
export function ImportNumberDialog({
  open,
  onOpenChange,
  onImport,
  isLoading = false,
}: ImportNumberDialogProps) {
  const [step, setStep] = useState<Step>('choose');
  const [selected, setSelected] = useState<OwnedPhoneNumber | null>(null);
  const [label, setLabel] = useState('');
  const [owner, setOwner] = useState<OwnerSelection>(RESERVE_SELECTION);
  const [isPrimary, setIsPrimary] = useState(false);
  /** The messaging service picked for a local number in none; see `MessagingServicePicker`. */
  const [serviceValue, setServiceValue] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Until the import has answered and the list has reloaded, which the
  // page's own loading flag does not cover.
  const [isAdding, setIsAdding] = useState(false);

  const owned = useOwnedNumbers(open);
  const choosesService = selected ? mayChooseServiceOnImport(selected) : false;
  const messaging = useMessagingServices(
    open && step === 'confirm' && choosesService,
  );

  // The picker starts on the default each time the services are read.
  useEffect(() => {
    setServiceValue(presetValue(messaging.data));
  }, [messaging.data]);

  useEffect(() => {
    if (!open) {
      setStep('choose');
      setSelected(null);
      setLabel('');
      setOwner(RESERVE_SELECTION);
      setIsPrimary(false);
      setServiceValue(null);
      setFailure(null);
    }
  }, [open]);

  const holder = chosenHolder(owner);

  const handleAdd = async () => {
    if (!selected || holder === undefined || isAdding) return;

    setFailure(null);
    setIsAdding(true);

    try {
      await onImport({
        phoneNumber: selected.phoneNumber,
        label: label.trim() || undefined,
        owner: ownerOf(holder) ?? undefined,
        isPrimary: holder?.type === 'department' ? isPrimary : false,
        messagingServiceSid: choosesService
          ? requestFieldOf(choiceOf(messaging.data, serviceValue))
          : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      // An import refused or failed before Twilio was changed may simply be
      // tried again; one that got further is refused as already listed.
      setFailure(
        err instanceof Error ? err.message : 'The number was not added.',
      );
    } finally {
      setIsAdding(false);
    }
  };

  // Closing while Twilio is asked would hide the answer.
  const closeUnlessAdding = (next: boolean) => {
    if (!next && (isLoading || isAdding)) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={closeUnlessAdding}>
      <DialogContent className="sm:max-w-[640px] max-h-[90dvh] overflow-y-auto">
        {step === 'choose' && (
          <ChooseStep
            numbers={owned.numbers}
            truncated={owned.truncated}
            isLoading={owned.isLoading}
            error={owned.error}
            selected={selected}
            onSelect={setSelected}
            onRetry={owned.refetch}
            onCancel={() => onOpenChange(false)}
            onContinue={() => {
              setFailure(null);
              setStep('confirm');
            }}
          />
        )}

        {step === 'confirm' && selected && (
          <ConfirmStep
            number={selected}
            label={label}
            onLabelChange={setLabel}
            owner={owner}
            onOwnerChange={(next) => {
              setOwner(next);
              setIsPrimary(false);
            }}
            isPrimary={isPrimary}
            onIsPrimaryChange={setIsPrimary}
            choosesService={choosesService}
            messaging={messaging}
            serviceValue={serviceValue}
            onServiceChange={setServiceValue}
            error={failure}
            isLoading={isLoading || isAdding}
            onBack={() => setStep('choose')}
            onAdd={handleAdd}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================
// Step 1: which number
// ============================================

function ChooseStep({
  numbers,
  truncated,
  isLoading,
  error,
  selected,
  onSelect,
  onRetry,
  onCancel,
  onContinue,
}: {
  numbers: OwnedPhoneNumber[];
  truncated: boolean;
  isLoading: boolean;
  error: Error | null;
  selected: OwnedPhoneNumber | null;
  onSelect: (number: OwnedPhoneNumber) => void;
  onRetry: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a number you own</DialogTitle>
        <DialogDescription>
          Numbers your Twilio account already holds that are not in this list.
          Adding one moves its calls and texts to iziphone and detaches what
          takes them today.
        </DialogDescription>
      </DialogHeader>

      <div className="py-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => `owned-skeleton-${i}`).map(
              (key) => (
                <div
                  key={key}
                  className="flex items-center gap-3 p-3 border rounded-md"
                >
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-36 bg-muted animate-pulse rounded" />
                    <div className="h-3 w-48 bg-muted animate-pulse rounded" />
                  </div>
                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                </div>
              ),
            )}
          </div>
        ) : error ? (
          <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
            The Twilio account could not be read: {error.message}
          </div>
        ) : numbers.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground">
              Every number on your Twilio account is in this list already.
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              A number bought in the Twilio Console shows here once Twilio lists
              it. Only US numbers can be added.
            </p>
          </div>
        ) : (
          <>
            {truncated && (
              <p className="mb-2 text-sm text-muted-foreground">
                Your account holds more numbers than can be listed at once; only
                the first ones are shown.
              </p>
            )}
            <ScrollArea className="h-[min(400px,50dvh)]">
              <div
                className="space-y-2 pr-4"
                role="listbox"
                aria-label="Numbers on your Twilio account"
              >
                {numbers.map((number) => (
                  <OwnedNumberOption
                    key={number.phoneNumber}
                    number={number}
                    isSelected={selected?.phoneNumber === number.phoneNumber}
                    onSelect={() => onSelect(number)}
                  />
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {error && (
          <Button type="button" variant="outline" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Try again
          </Button>
        )}
        <Button onClick={onContinue} disabled={!selected || isLoading}>
          Continue
        </Button>
      </DialogFooter>
    </>
  );
}

function OwnedNumberOption({
  number,
  isSelected,
  onSelect,
}: {
  number: OwnedPhoneNumber;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const today = attachedToday(number);
  const service = number.attached.messagingService;

  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      className={cn(
        'flex items-start gap-3 w-full p-3 border rounded-md text-left transition-colors',
        isSelected ? 'border-primary bg-accent' : 'hover:bg-muted/50',
      )}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-medium">
            {formatPhoneNumber(number.phoneNumber)}
          </span>
          <span className="text-xs text-muted-foreground">
            {NUMBER_TYPE_LABELS[number.type]}
          </span>
          {number.releasedHere && (
            <Badge variant="outline" className="text-xs">
              Released here before
            </Badge>
          )}
        </div>
        {number.friendlyName !== number.phoneNumber && (
          <p className="text-sm text-muted-foreground truncate">
            {number.friendlyName}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {today.length > 0
            ? `Today: ${today.join('; ')}`
            : 'Today: nothing takes its calls or texts.'}
        </p>
        {service && (
          <p className="text-xs text-muted-foreground">
            Messaging service: {service.friendlyName}
          </p>
        )}
      </div>
      <CapabilityBadges
        voice={number.capabilities.voice}
        sms={number.capabilities.sms}
        mms={number.capabilities.mms}
        fax={number.capabilities.fax}
        className="shrink-0 flex-nowrap"
      />
      {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
    </button>
  );
}

// ============================================
// Step 2: who gets it, what it changes
// ============================================

function ConfirmStep({
  number,
  label,
  onLabelChange,
  owner,
  onOwnerChange,
  isPrimary,
  onIsPrimaryChange,
  choosesService,
  messaging,
  serviceValue,
  onServiceChange,
  error,
  isLoading,
  onBack,
  onAdd,
}: {
  number: OwnedPhoneNumber;
  label: string;
  onLabelChange: (value: string) => void;
  owner: OwnerSelection;
  onOwnerChange: (owner: OwnerSelection) => void;
  isPrimary: boolean;
  onIsPrimaryChange: (value: boolean) => void;
  /** Whether it is a local number in no messaging service, which joins one here. */
  choosesService: boolean;
  messaging: {
    data: MessagingServicesResponse | null;
    isLoading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
  };
  serviceValue: string | null;
  onServiceChange: (value: string) => void;
  error: string | null;
  isLoading: boolean;
  onBack: () => void;
  onAdd: () => void;
}) {
  const holder = chosenHolder(owner);
  const terms = importTerms(
    number,
    holder,
    choosesService ? choiceOf(messaging.data, serviceValue) : undefined,
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add {formatPhoneNumber(number.phoneNumber)}?</DialogTitle>
        <DialogDescription>
          {[
            number.friendlyName !== number.phoneNumber
              ? number.friendlyName
              : null,
            NUMBER_TYPE_LABELS[number.type],
          ]
            .filter(Boolean)
            .join(' · ')}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-4">
        <div className="space-y-2">
          <Label htmlFor="import-label">Label (optional)</Label>
          <Input
            id="import-label"
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            placeholder="Main sales line"
            maxLength={50}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label>Who gets it</Label>
          <OwnerPicker
            id="import-owner"
            value={owner}
            onChange={onOwnerChange}
            disabled={isLoading}
          />
          {holder?.type === 'department' && (
            <div className="flex items-center justify-between gap-4 pt-1">
              <Label htmlFor="import-primary" className="font-normal">
                Make it the department's primary number
                <span className="block text-xs text-muted-foreground">
                  A department's first number is its primary anyway.
                </span>
              </Label>
              <Switch
                id="import-primary"
                checked={isPrimary}
                onCheckedChange={onIsPrimaryChange}
                disabled={isLoading}
              />
            </div>
          )}
        </div>

        {choosesService && (
          <div className="space-y-2">
            <Label htmlFor="import-messaging-service">
              Texting registration
            </Label>
            <MessagingServicePicker
              id="import-messaging-service"
              services={messaging.data}
              isLoading={messaging.isLoading}
              error={messaging.error}
              value={serviceValue}
              onChange={onServiceChange}
              onRetry={() => void messaging.refetch()}
              purpose="number"
              disabled={isLoading}
            />
          </div>
        )}

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Before you add it</p>
          <TermsList terms={terms} />
        </div>

        {error && (
          <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={isLoading}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={onAdd}
          disabled={
            isLoading ||
            holder === undefined ||
            (choosesService && messaging.isLoading)
          }
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Adding...
            </>
          ) : (
            'Move its calls and texts here'
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
