'use client';

import {
  type AvailablePhoneNumber,
  type ContainsAt,
  type MonthlyPrice,
  type PhoneNumberType,
  type PurchasePhoneNumber,
  type SearchAvailableNumbers,
  SUPPORTED_NUMBER_COUNTRY,
} from '@repo/dto';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAvailableNumbers } from '@/hooks/use-admin-phone-numbers';
import { ApiError } from '@/lib/api/client';
import { formatPhoneNumber } from '@/lib/phone-number';
import {
  EMPTY_NUMBER_SEARCH,
  type NumberSearchField,
  type NumberSearchForm,
  toSearchQuery,
} from '@/lib/phone-numbers/number-search';
import {
  formatPrice,
  moveTerms,
  NUMBER_TYPE_LABELS,
  type PurchaseFailure,
  purchaseFailureFrom,
  purchaseTerms,
} from '@/lib/phone-numbers/number-terms';
import {
  chosenHolder,
  type OwnerSelection,
  ownerOf,
  RESERVE_SELECTION,
} from '@/lib/phone-numbers/owner-selection';
import { cn } from '@/lib/utils';
import { CapabilityBadges } from './CapabilityBadges';
import { OwnerPicker } from './OwnerPicker';
import { TermsList } from './TermsList';

type Step = 'search' | 'results' | 'confirm';

interface PurchaseNumberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rejects with the reason when the number was not bought. */
  onPurchase: (data: PurchasePhoneNumber) => Promise<void>;
  isLoading?: boolean;
}

export function PurchaseNumberDialog({
  open,
  onOpenChange,
  onPurchase,
  isLoading = false,
}: PurchaseNumberDialogProps) {
  const [step, setStep] = useState<Step>('search');
  const [form, setForm] = useState<NumberSearchForm>(EMPTY_NUMBER_SEARCH);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<NumberSearchField, string>>
  >({});
  const [lastQuery, setLastQuery] = useState<SearchAvailableNumbers | null>(
    null,
  );
  const [selected, setSelected] = useState<AvailablePhoneNumber | null>(null);
  const [label, setLabel] = useState('');
  const [owner, setOwner] = useState<OwnerSelection>(RESERVE_SELECTION);
  const [isPrimary, setIsPrimary] = useState(false);
  const [purchaseFailure, setPurchaseFailure] = useState<
    (PurchaseFailure & { phoneNumber: string }) | null
  >(null);
  // Until the purchase has answered and the list has reloaded, which the
  // page's own loading flag does not cover.
  const [isBuying, setIsBuying] = useState(false);

  const {
    numbers,
    monthlyPrice,
    isLoading: isSearching,
    isLoadingMore,
    error: searchError,
    addedByMore,
    search,
    searchMore,
    reset: resetSearch,
  } = useAvailableNumbers();

  useEffect(() => {
    if (!open) {
      setStep('search');
      setForm(EMPTY_NUMBER_SEARCH);
      setFieldErrors({});
      setLastQuery(null);
      setSelected(null);
      setLabel('');
      setOwner(RESERVE_SELECTION);
      setIsPrimary(false);
      setPurchaseFailure(null);
      resetSearch();
    }
  }, [open, resetSearch]);

  const runSearch = async (query: SearchAvailableNumbers) => {
    setSelected(null);
    setLastQuery(query);
    setStep('results');
    await search(query);
  };

  // Keeps the number chosen so far: "Show more" only adds to the list.
  const showMore = async () => {
    if (lastQuery) await searchMore(lastQuery);
  };

  const handleSearch = async () => {
    const request = toSearchQuery(form);

    if (!request.ok) {
      setFieldErrors(request.errors);
      return;
    }

    setFieldErrors({});
    await runSearch(request.query);
  };

  const holder = chosenHolder(owner);
  // A failure that may have bought a number holds back only that number.
  const failureOfSelected =
    purchaseFailure?.phoneNumber === selected?.phoneNumber
      ? purchaseFailure
      : null;

  const handleBuy = async () => {
    if (!selected || holder === undefined || isBuying) return;

    setPurchaseFailure(null);
    setIsBuying(true);

    try {
      await onPurchase({
        phoneNumber: selected.phoneNumber,
        country: SUPPORTED_NUMBER_COUNTRY,
        type: selected.type,
        label: label.trim() || undefined,
        owner: ownerOf(holder) ?? undefined,
        isPrimary: holder?.type === 'department' ? isPrimary : false,
      });
      onOpenChange(false);
    } catch (err) {
      setPurchaseFailure({
        ...purchaseFailureFrom(
          err instanceof ApiError ? err.status : undefined,
          err instanceof Error ? err.message : 'The number was not bought.',
        ),
        phoneNumber: selected.phoneNumber,
      });
    } finally {
      setIsBuying(false);
    }
  };

  // Closing while Twilio is asked would hide the answer, and a failure that
  // may have bought the number must be seen.
  const closeUnlessBuying = (next: boolean) => {
    if (!next && (isLoading || isBuying)) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={closeUnlessBuying}>
      <DialogContent className="sm:max-w-[600px] max-h-[90dvh] overflow-y-auto">
        {step === 'search' && (
          <SearchStep
            form={form}
            onChange={(changes) => setForm({ ...form, ...changes })}
            errors={fieldErrors}
            isLoading={isSearching}
            onSearch={handleSearch}
            onCancel={() => onOpenChange(false)}
          />
        )}

        {step === 'results' && (
          <ResultsStep
            query={lastQuery}
            numbers={numbers}
            monthlyPrice={monthlyPrice}
            selected={selected}
            onSelect={setSelected}
            isLoading={isSearching}
            isLoadingMore={isLoadingMore}
            addedByMore={addedByMore}
            error={searchError}
            onBack={() => setStep('search')}
            onShowMore={showMore}
            onContinue={() => {
              if (purchaseFailure?.mayRetry !== false) {
                setPurchaseFailure(null);
              }
              setStep('confirm');
            }}
          />
        )}

        {step === 'confirm' && selected && (
          <ConfirmStep
            number={selected}
            monthlyPrice={monthlyPrice}
            label={label}
            onLabelChange={setLabel}
            owner={owner}
            onOwnerChange={(next) => {
              setOwner(next);
              setIsPrimary(false);
            }}
            isPrimary={isPrimary}
            onIsPrimaryChange={setIsPrimary}
            error={failureOfSelected?.message ?? null}
            mayBuy={failureOfSelected?.mayRetry !== false}
            isLoading={isLoading || isBuying}
            onBack={() => setStep('results')}
            onBuy={handleBuy}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================
// Step 1: what to look for
// ============================================

function SearchStep({
  form,
  onChange,
  errors,
  isLoading,
  onSearch,
  onCancel,
}: {
  form: NumberSearchForm;
  onChange: (changes: Partial<NumberSearchForm>) => void;
  errors: Partial<Record<NumberSearchField, string>>;
  isLoading: boolean;
  onSearch: () => void;
  onCancel: () => void;
}) {
  const local = form.type === 'LOCAL';
  // Opened already when coming back to a search that used them.
  const [showFilters, setShowFilters] = useState(
    form.region !== '' || form.locality !== '' || form.contains !== '',
  );

  const containsField = (
    <div className="space-y-2">
      <SearchField
        id="number-contains"
        label="Digits or letters"
        value={form.contains}
        onChange={(value) =>
          onChange({ contains: value.replace(/[^0-9A-Za-z]/g, '') })
        }
        placeholder={local ? '0101' : 'HELP'}
        maxLength={10}
        error={errors.contains}
        hint="Letters stand for their keypad digits."
      />
      <RadioGroup
        value={form.containsAt}
        onValueChange={(value) => onChange({ containsAt: value as ContainsAt })}
        className="flex flex-wrap gap-x-4 gap-y-2"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="anywhere" id="contains-anywhere" />
          <Label htmlFor="contains-anywhere" className="font-normal">
            Anywhere in the number
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="end" id="contains-end" />
          <Label htmlFor="contains-end" className="font-normal">
            At the end
          </Label>
        </div>
      </RadioGroup>
    </div>
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <DialogHeader>
        <DialogTitle>Buy a number</DialogTitle>
        <DialogDescription>
          {local
            ? 'Enter an area code to see the numbers Twilio has for sale in it. '
            : 'Search the toll-free numbers Twilio has for sale. '}
          Searching is free; every number found takes calls and texts.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="number-type">Type</Label>
            <Select
              value={form.type}
              onValueChange={(value) =>
                onChange({ type: value as PhoneNumberType })
              }
            >
              <SelectTrigger id="number-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="LOCAL">
                  {NUMBER_TYPE_LABELS.LOCAL}
                </SelectItem>
                <SelectItem value="TOLL_FREE">
                  {NUMBER_TYPE_LABELS.TOLL_FREE}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {local && (
            <SearchField
              id="number-area-code"
              label="Area code"
              value={form.areaCode}
              onChange={(value) =>
                onChange({ areaCode: value.replace(/\D/g, '').slice(0, 3) })
              }
              placeholder="555"
              inputMode="numeric"
              maxLength={3}
              autoFocus
              error={errors.areaCode}
            />
          )}
        </div>

        {local ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 text-muted-foreground"
              aria-expanded={showFilters}
              aria-controls="number-more-filters"
              onClick={() => setShowFilters(!showFilters)}
            >
              <ChevronDown
                className={cn(
                  'mr-1 h-4 w-4 transition-transform',
                  showFilters && 'rotate-180',
                )}
              />
              {showFilters ? 'Fewer filters' : 'More filters'}
            </Button>

            {showFilters && (
              <div id="number-more-filters" className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <SearchField
                    id="number-region"
                    label="State"
                    value={form.region}
                    onChange={(value) =>
                      onChange({
                        region: value.replace(/[^A-Za-z]/g, '').slice(0, 2),
                      })
                    }
                    placeholder="TX"
                    maxLength={2}
                    className="uppercase"
                    error={errors.region}
                  />
                  <SearchField
                    id="number-locality"
                    label="City"
                    value={form.locality}
                    onChange={(value) => onChange({ locality: value })}
                    placeholder="Springfield"
                    maxLength={60}
                    error={errors.locality}
                  />
                </div>
                {containsField}
              </div>
            )}
          </>
        ) : (
          containsField
        )}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-2 h-4 w-4" />
          )}
          Search
        </Button>
      </DialogFooter>
    </form>
  );
}

function SearchField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  className,
  ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  className?: string;
  placeholder: string;
  maxLength: number;
  inputMode?: 'numeric';
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        className={className}
        {...input}
      />
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

// ============================================
// Step 2: pick one
// ============================================

function ResultsStep({
  query,
  numbers,
  monthlyPrice,
  selected,
  onSelect,
  isLoading,
  isLoadingMore,
  addedByMore,
  error,
  onBack,
  onShowMore,
  onContinue,
}: {
  query: SearchAvailableNumbers | null;
  numbers: AvailablePhoneNumber[];
  monthlyPrice: MonthlyPrice | null;
  selected: AvailablePhoneNumber | null;
  onSelect: (number: AvailablePhoneNumber) => void;
  isLoading: boolean;
  isLoadingMore: boolean;
  /** How many new numbers the last "Show more" added; null before one. */
  addedByMore: number | null;
  error: Error | null;
  onBack: () => void;
  onShowMore: () => void;
  onContinue: () => void;
}) {
  const areaCode = query?.areaCode;
  const found = `${numbers.length} number${numbers.length === 1 ? '' : 's'}${
    areaCode ? ` in area code ${areaCode}` : ' found'
  }`;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose a number</DialogTitle>
        <DialogDescription>
          {isLoading
            ? 'Searching Twilio...'
            : numbers.length > 0
              ? monthlyPrice
                ? `${found}, ${formatPrice(monthlyPrice)} a month each.`
                : `${found}.`
              : 'Nothing to choose from yet.'}
        </DialogDescription>
      </DialogHeader>

      <div className="py-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => `search-skeleton-${i}`).map(
              (key) => (
                <div
                  key={key}
                  className="flex items-center gap-3 p-3 border rounded-md"
                >
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-36 bg-muted animate-pulse rounded" />
                    <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                  </div>
                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                </div>
              ),
            )}
          </div>
        ) : error && numbers.length === 0 ? (
          <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
            The search failed: {error.message}
          </div>
        ) : numbers.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground">
              {areaCode
                ? `Twilio has no numbers for sale in area code ${areaCode} right now.`
                : 'Twilio has no numbers matching this search.'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {areaCode
                ? 'Busy area codes sell out. Try a neighbouring or overlay area code, or search a state under More filters.'
                : 'Try fewer digits, a nearby area code, or only a state.'}
            </p>
          </div>
        ) : (
          <>
            {error ? (
              <p className="mb-2 text-sm text-red-600 dark:text-red-400">
                Showing more failed: {error.message}
              </p>
            ) : addedByMore === 0 ? (
              <p className="mb-2 text-sm text-muted-foreground">
                Twilio had no other numbers for this search.
              </p>
            ) : null}
            <ScrollArea className="h-[min(360px,45dvh)]">
              <div
                className="space-y-2 pr-4"
                role="listbox"
                aria-label="Numbers"
              >
                {numbers.map((number) => {
                  const isSelected =
                    selected?.phoneNumber === number.phoneNumber;
                  const place = [number.locality, number.region]
                    .filter(Boolean)
                    .join(', ');

                  return (
                    <button
                      key={number.phoneNumber}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={cn(
                        'flex items-center gap-3 w-full p-3 border rounded-md text-left transition-colors',
                        isSelected
                          ? 'border-primary bg-accent'
                          : 'hover:bg-muted/50',
                      )}
                      onClick={() => onSelect(number)}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-mono font-medium">
                          {formatPhoneNumber(number.phoneNumber)}
                        </p>
                        {place && (
                          <p className="text-sm text-muted-foreground truncate">
                            {place}
                          </p>
                        )}
                      </div>
                      <CapabilityBadges
                        voice={number.capabilities.voice}
                        sms={number.capabilities.sms}
                        mms={number.capabilities.mms}
                        className="shrink-0 flex-nowrap"
                      />
                      {isSelected && (
                        <Check className="h-4 w-4 text-primary shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </>
        )}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Change search
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onShowMore}
          disabled={isLoading || isLoadingMore}
        >
          {isLoadingMore ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : numbers.length > 0 ? (
            <Plus className="mr-2 h-4 w-4" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {numbers.length > 0 ? 'Show more' : 'Try again'}
        </Button>
        <Button onClick={onContinue} disabled={!selected || isLoading}>
          Continue
        </Button>
      </DialogFooter>
    </>
  );
}

// ============================================
// Step 3: who gets it, what it costs
// ============================================

function ConfirmStep({
  number,
  monthlyPrice,
  label,
  onLabelChange,
  owner,
  onOwnerChange,
  isPrimary,
  onIsPrimaryChange,
  error,
  mayBuy,
  isLoading,
  onBack,
  onBuy,
}: {
  number: AvailablePhoneNumber;
  monthlyPrice: MonthlyPrice | null;
  label: string;
  onLabelChange: (value: string) => void;
  owner: OwnerSelection;
  onOwnerChange: (owner: OwnerSelection) => void;
  isPrimary: boolean;
  onIsPrimaryChange: (value: boolean) => void;
  error: string | null;
  /** Off after a failure that may have bought the number already. */
  mayBuy: boolean;
  isLoading: boolean;
  onBack: () => void;
  onBuy: () => void;
}) {
  const holder = chosenHolder(owner);
  const place = [number.locality, number.region].filter(Boolean).join(', ');
  const terms = [
    ...purchaseTerms(monthlyPrice, number.type),
    ...(holder === undefined ? [] : moveTerms(null, holder)),
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle>Buy {formatPhoneNumber(number.phoneNumber)}?</DialogTitle>
        <DialogDescription>
          {[place, NUMBER_TYPE_LABELS[number.type]].filter(Boolean).join(' · ')}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-4">
        <div className="space-y-2">
          <Label htmlFor="purchase-label">Label (optional)</Label>
          <Input
            id="purchase-label"
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
            id="purchase-owner"
            value={owner}
            onChange={onOwnerChange}
            disabled={isLoading}
          />
          {holder?.type === 'department' && (
            <div className="flex items-center justify-between gap-4 pt-1">
              <Label htmlFor="purchase-primary" className="font-normal">
                Make it the department's primary number
                <span className="block text-xs text-muted-foreground">
                  A department's first number is its primary anyway.
                </span>
              </Label>
              <Switch
                id="purchase-primary"
                checked={isPrimary}
                onCheckedChange={onIsPrimaryChange}
                disabled={isLoading}
              />
            </div>
          )}
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Before you buy</p>
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
          onClick={onBuy}
          disabled={isLoading || !mayBuy || holder === undefined}
        >
          {isLoading
            ? 'Buying...'
            : monthlyPrice
              ? `Buy for ${formatPrice(monthlyPrice)} a month`
              : 'Buy number'}
        </Button>
      </DialogFooter>
    </>
  );
}
