'use client';

import type { PhoneNumberResponse } from '@repo/dto';
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
import { releaseTerms } from '@/lib/phone-numbers/number-terms';
import { TermsList } from './TermsList';

interface ReleaseNumberDialogProps {
  /** The number to release; the dialog is open while it is set. */
  phoneNumber: PhoneNumberResponse | null;
  onClose: () => void;
  /** Reports its own failure through `error`. */
  onConfirm: () => void;
  isLoading: boolean;
  error: string | null;
}

/** Confirms giving a number in the reserve back to Twilio. */
export function ReleaseNumberDialog({
  phoneNumber,
  onClose,
  onConfirm,
  isLoading,
  error,
}: ReleaseNumberDialogProps) {
  return (
    <Dialog
      open={phoneNumber !== null}
      // Closing mid-request would hide a refusal only this dialog shows.
      onOpenChange={(open) => !open && !isLoading && onClose()}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            Release{' '}
            {phoneNumber ? formatPhoneNumber(phoneNumber.phoneNumber) : ''}?
          </DialogTitle>
          <DialogDescription>
            Only numbers in the reserve can be released.
          </DialogDescription>
        </DialogHeader>

        {phoneNumber && (
          <TermsList terms={releaseTerms(phoneNumber.provider)} />
        )}

        {error && (
          <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Keep the number
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? 'Releasing...' : 'Release number'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
