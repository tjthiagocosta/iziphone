'use client';

import type { AccessLinkResponse } from '@repo/dto';
import { Check, Copy } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { accessLinkExpiryWords, accessLinkNotice } from '@/lib/access-link';

interface AccessLinkDialogProps {
  /** The link just issued, or null when there is none to show. */
  link: AccessLinkResponse | null;
  /** Who it was issued for, to say so on the dialog. */
  recipient: string | null;
  onClose: () => void;
}

/**
 * Shows an admin the link that was just issued. It is shown whether or not the
 * email went out: the system has to work before SMTP is configured, and an
 * admin on the phone with somebody should not have to wait for mail.
 */
export function AccessLinkDialog({
  link,
  recipient,
  onClose,
}: AccessLinkDialogProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopy = async () => {
    if (!link) return;

    try {
      await navigator.clipboard.writeText(link.url);
      setIsCopied(true);
      setCopyFailed(false);
    } catch {
      // Clipboard access can be refused; the link is on screen to select.
      setCopyFailed(true);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setIsCopied(false);
      setCopyFailed(false);
      onClose();
    }
  };

  return (
    <Dialog open={link !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {link?.purpose === 'RESET' ? 'Password reset link' : 'Invite link'}
          </DialogTitle>
          <DialogDescription>
            {recipient ? `For ${recipient}. ` : ''}
            {link ? accessLinkNotice(link) : ''}
          </DialogDescription>
        </DialogHeader>

        {link && (
          <div className="space-y-2 py-2">
            <div className="flex gap-2">
              <Input readOnly value={link.url} aria-label="Access link" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleCopy}
                aria-label="Copy link"
              >
                {isCopied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {accessLinkExpiryWords(link)}
            </p>
            {copyFailed && (
              <p className="text-xs text-destructive">
                Your browser would not let us copy it. Select the link above and
                copy it by hand.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
