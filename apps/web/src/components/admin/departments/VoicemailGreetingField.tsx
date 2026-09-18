'use client';

import { Loader2, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  checkGreetingFile,
  GREETING_FILE_ACCEPT,
  GREETING_MAX_SIZE_LABEL,
} from '@/lib/voicemail/greeting-file';

interface VoicemailGreetingFieldProps {
  /** Where the current greeting plays from, or null when callers hear the built-in one. */
  greetingUrl: string | null;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  isLoading?: boolean;
}

/**
 * The recording a department plays before the beep. The file is public by
 * its unguessable URL, which is what Twilio plays and what the audio element
 * here plays; nothing is downloaded until the admin presses play.
 */
export function VoicemailGreetingField({
  greetingUrl,
  onUpload,
  onRemove,
  isLoading = false,
}: VoicemailGreetingFieldProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const disabled = isLoading || busy !== null;

  const handleFileChosen = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again after a refusal fires the event.
    event.target.value = '';

    if (!file) {
      return;
    }

    const check = checkGreetingFile(file);

    if (!check.ok) {
      setMessage(check.message);
      return;
    }

    setBusy('uploading');
    setMessage(null);
    try {
      await onUpload(file);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The upload did not go through',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    setBusy('removing');
    setMessage(null);
    try {
      await onRemove();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The greeting could not be removed',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <Label>Voicemail Greeting</Label>
      <input
        ref={fileInput}
        type="file"
        accept={GREETING_FILE_ACCEPT}
        className="hidden"
        onChange={handleFileChosen}
        aria-label="Choose a greeting file"
      />

      {greetingUrl ? (
        <div className="space-y-2 rounded-md border p-3">
          {/* biome-ignore lint/a11y/useMediaCaption: a greeting has no text track; its words are the admin's own recording */}
          <audio controls preload="none" src={greetingUrl} className="w-full" />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
              disabled={disabled}
            >
              {busy === 'uploading' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={handleRemove}
              disabled={disabled}
            >
              {busy === 'removing' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <p className="text-sm text-muted-foreground">
            Callers hear the built-in greeting.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={disabled}
          >
            {busy === 'uploading' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Upload
          </Button>
        </div>
      )}

      {message ? (
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          MP3, WAV or AIFF, up to {GREETING_MAX_SIZE_LABEL}. Played before the
          beep when a call goes to voicemail.
        </p>
      )}
    </div>
  );
}
