'use client';

import type { PhoneNumberAssignment } from '@repo/dto';
import { ChevronsUpDown, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { getDepartments, getUsers } from '@/lib/api/admin';
import {
  type OwnerKind,
  type OwnerSelection,
  withKind,
} from '@/lib/phone-numbers/owner-selection';

const KINDS: { kind: OwnerKind; label: string }[] = [
  { kind: 'user', label: 'A user' },
  { kind: 'department', label: 'A department' },
  { kind: 'reserve', label: 'The reserve' },
];

interface OwnerPickerProps {
  /** Tells apart the radio ids of two pickers on one page. */
  id: string;
  value: OwnerSelection;
  onChange: (selection: OwnerSelection) => void;
  disabled?: boolean;
}

/** Chooses who holds a number: a user, a department, or nobody (the reserve). */
export function OwnerPicker({
  id,
  value,
  onChange,
  disabled = false,
}: OwnerPickerProps) {
  return (
    <div className="space-y-3">
      <RadioGroup
        value={value.kind}
        onValueChange={(kind) => onChange(withKind(value, kind as OwnerKind))}
        className="flex flex-wrap gap-x-4 gap-y-2"
        disabled={disabled}
      >
        {KINDS.map(({ kind, label }) => (
          <div key={kind} className="flex items-center gap-2">
            <RadioGroupItem value={kind} id={`${id}-${kind}`} />
            <Label htmlFor={`${id}-${kind}`} className="font-normal">
              {label}
            </Label>
          </div>
        ))}
      </RadioGroup>

      {value.kind !== 'reserve' && (
        <HolderSearch
          kind={value.kind}
          selected={value.holder}
          onSelect={(holder) => onChange({ kind: value.kind, holder })}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function HolderSearch({
  kind,
  selected,
  onSelect,
  disabled,
}: {
  kind: 'user' | 'department';
  selected: PhoneNumberAssignment | null;
  onSelect: (holder: PhoneNumberAssignment) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { holders, isLoading, error } = useHolderSearch(kind, search, open);
  const noun = kind === 'user' ? 'user' : 'department';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          disabled={disabled}
        >
          <span className="truncate">
            {selected ? selected.name : `Choose a ${noun}...`}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${noun}s...`}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {isLoading ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : error ? (
              <p className="p-4 text-sm text-destructive">{error}</p>
            ) : (
              <>
                <CommandEmpty>No {noun}s found.</CommandEmpty>
                <CommandGroup>
                  {holders.map((holder) => (
                    <CommandItem
                      key={holder.id}
                      value={holder.id}
                      onSelect={() => {
                        onSelect({
                          type: kind,
                          id: holder.id,
                          name: holder.name,
                        });
                        setOpen(false);
                        setSearch('');
                      }}
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{holder.name}</p>
                        {holder.detail && (
                          <p className="truncate text-sm text-muted-foreground">
                            {holder.detail}
                          </p>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface HolderOption {
  id: string;
  name: string;
  detail: string | null;
}

/**
 * How long typing must pause before the holders are searched: one request per
 * name, not per keystroke, since an office shares one rate limit.
 */
const TYPING_PAUSE_MS = 300;

/** The users or departments matching `search`, read while the list is open. */
function useHolderSearch(
  kind: 'user' | 'department',
  search: string,
  enabled: boolean,
) {
  const [holders, setHolders] = useState<HolderOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Answers can arrive out of order while someone types; only the last counts.
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const request = ++latest.current;
    const query = { search: search.trim() || undefined, limit: 20 };

    setIsLoading(true);
    setError(null);

    const load = (): Promise<HolderOption[]> =>
      kind === 'user'
        ? getUsers(query).then(({ users }) =>
            users.map((user) => ({
              id: user.id,
              name: user.name || user.email,
              detail: user.name ? user.email : null,
            })),
          )
        : getDepartments(query).then(({ departments }) =>
            departments.map((department) => ({
              id: department.id,
              name: department.name,
              detail: null,
            })),
          );

    const timer = setTimeout(
      () => {
        load()
          .then((options) => {
            if (request === latest.current) {
              setHolders(options);
            }
          })
          .catch((err: unknown) => {
            if (request === latest.current) {
              setHolders([]);
              setError(
                err instanceof Error ? err.message : `Could not load ${kind}s`,
              );
            }
          })
          .finally(() => {
            if (request === latest.current) {
              setIsLoading(false);
            }
          });
      },
      query.search ? TYPING_PAUSE_MS : 0,
    );

    return () => clearTimeout(timer);
  }, [kind, search, enabled]);

  return { holders, isLoading, error };
}
