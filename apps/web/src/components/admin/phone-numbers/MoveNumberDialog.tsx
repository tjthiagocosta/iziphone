'use client';

import type { PhoneNumberOwner, PhoneNumberResponse } from '@repo/dto';
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
import { formatPhoneNumber } from '@/lib/phone-number';
import { moveTerms } from '@/lib/phone-numbers/number-terms';
import {
  chosenHolder,
  type OwnerSelection,
  ownerOf,
  RESERVE_SELECTION,
  sameHolder,
  selectionOf,
} from '@/lib/phone-numbers/owner-selection';
import { OwnerPicker } from './OwnerPicker';
import { TermsList } from './TermsList';

interface MoveNumberDialogProps {
  /** The number to move; the dialog is open while it is set. */
  phoneNumber: PhoneNumberResponse | null;
  /** Opens with the reserve already chosen, for "Move to reserve". */
  toReserve?: boolean;
  onClose: () => void;
  /** Reports its own failure through `error`. */
  onConfirm: (owner: PhoneNumberOwner | null) => void;
  isLoading: boolean;
  error: string | null;
}

/** Gives a number to a user or department, or takes it into the reserve. */
export function MoveNumberDialog({
  phoneNumber,
  toReserve = false,
  onClose,
  onConfirm,
  isLoading,
  error,
}: MoveNumberDialogProps) {
  const current = phoneNumber?.assignedTo ?? null;
  // Null until the admin chooses: the dialog then shows the holder the number
  // has now, which a fresh read of it may change, so an untouched dialog
  // never moves the number back to a holder it no longer has.
  const [chosen, setChosen] = useState<OwnerSelection | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const opening = phoneNumber ? `${phoneNumber.id}:${toReserve}` : null;

  // Each opening starts over. A reload of the number behind the open dialog,
  // as after a refused move, keeps the admin's choice.
  if (opening !== openedFor) {
    setOpenedFor(opening);
    setChosen(null);
  }

  const selection =
    chosen ?? (toReserve ? RESERVE_SELECTION : selectionOf(current));
  const target = chosenHolder(selection);
  const changed = target !== undefined && !sameHolder(current, target);
  const confirmLabel =
    target === null ? 'Move to reserve' : current ? 'Move' : 'Assign';

  return (
    <Dialog
      open={phoneNumber !== null}
      // Closing mid-request would hide a refusal only this dialog shows.
      onOpenChange={(open) => !open && !isLoading && onClose()}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            {current ? 'Move' : 'Assign'}{' '}
            {phoneNumber ? formatPhoneNumber(phoneNumber.phoneNumber) : ''}
          </DialogTitle>
          <DialogDescription>
            {current
              ? `Now with ${current.name} (${current.type}).`
              : 'Now in the reserve: nobody answers it.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <OwnerPicker
            id="move-owner"
            value={selection}
            onChange={setChosen}
            disabled={isLoading}
          />

          {changed && target !== undefined && (
            <TermsList terms={moveTerms(current, target)} />
          )}

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
              if (changed && target !== undefined) {
                onConfirm(ownerOf(target));
              }
            }}
            disabled={isLoading || !changed}
          >
            {isLoading ? 'Saving...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
