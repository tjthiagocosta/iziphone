'use client';

import type { CallRecordingSummary } from '@repo/dto';
import { AlertCircle, Loader2, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/admin/shared/ConfirmDialog';
import { PermissionGate } from '@/components/auth/PermissionGate';
import { Button } from '@/components/ui/button';
import { useRecordingPlayback } from '@/hooks/use-recording-playback';
import { deleteRecording } from '@/lib/api/calls';
import { deletionNotice, recordingNoun } from '@/lib/recording/playback';

interface RecordingPlayerProps {
  conversationUuid: string;
  recording: CallRecordingSummary;
}

/**
 * Plays one recording of one call, and lets an admin delete it. Nothing is
 * downloaded until the user asks.
 *
 * The recording of the call itself is for supervisors and admins, which is the
 * same rule the API enforces; an agent sees the voicemails of their own calls
 * and nothing else.
 */
export function RecordingPlayer({
  conversationUuid,
  recording,
}: RecordingPlayerProps) {
  /*
   * The key is what ties the audio to the recording: a parent that reuses this
   * element for another one gets a new player, never the last recording or the
   * answer to its download.
   */
  const player = (
    <CallRecording
      key={recording.id}
      conversationUuid={conversationUuid}
      recording={recording}
    />
  );

  return recording.context === 'VOICEMAIL' ? (
    player
  ) : (
    <PermissionGate permission="recordings:listen">{player}</PermissionGate>
  );
}

function CallRecording({ conversationUuid, recording }: RecordingPlayerProps) {
  const { playback, src, play, reportUnplayable } = useRecordingPlayback(
    conversationUuid,
    recording.id,
  );
  /*
   * What this tab knows about the deletion it just made. The call is reloaded
   * on the next poll and then carries the deletion itself; until it does, the
   * card would otherwise still offer to play audio that is gone.
   */
  const [deletedHere, setDeletedHere] = useState<CallRecordingSummary | null>(
    null,
  );

  const current = deletedHere ?? recording;
  const noun = recordingNoun(current);
  const notice = deletionNotice(current);

  if (notice) {
    return (
      <p
        className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="recording-deleted"
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {notice}
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {playback.status === 'failed' ? (
        <>
          <p
            role="alert"
            className="flex items-center gap-1.5 text-xs text-destructive"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {playback.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={play}
          >
            Try again
          </Button>
        </>
      ) : playback.status === 'ready' && src ? (
        /*
         * `autoPlay` because the user has just asked to hear it; where the
         * browser refuses to start sound by itself, the controls are there to
         * press.
         */
        // biome-ignore lint/a11y/useMediaCaption: a recording of a call has no caption track; its transcript, when there is one, is on the card under the player.
        <audio
          controls
          autoPlay
          src={src}
          onError={reportUnplayable}
          aria-label={noun === 'voicemail' ? 'Voicemail' : 'Call recording'}
          className="h-10 w-full"
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={play}
          disabled={playback.status === 'loading'}
          aria-busy={playback.status === 'loading'}
        >
          {playback.status === 'loading' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Play />
          )}
          {playback.status === 'loading' ? `Loading ${noun}…` : `Play ${noun}`}
        </Button>
      )}

      <PermissionGate roles={['ADMIN']}>
        <DeleteRecordingButton
          conversationUuid={conversationUuid}
          recording={current}
          onDeleted={(deleted) => setDeletedHere(deleted)}
        />
      </PermissionGate>
    </div>
  );
}

interface DeleteRecordingButtonProps extends RecordingPlayerProps {
  onDeleted: (recording: CallRecordingSummary) => void;
}

/**
 * Deletes a recording before its retention policy would. The audio cannot be
 * brought back, so the button asks first.
 */
function DeleteRecordingButton({
  conversationUuid,
  recording,
  onDeleted,
}: DeleteRecordingButtonProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noun = recordingNoun(recording);

  const confirm = async () => {
    setIsDeleting(true);
    setError(null);

    try {
      // The reply says what is stored, which is the retention policy's
      // deletion when the sweep reached this recording first.
      const deleted = await deleteRecording(conversationUuid, recording.id);
      setIsConfirming(false);
      onDeleted({ ...recording, deletion: deleted.deletion });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `This ${noun} could not be deleted`,
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground"
        onClick={() => setIsConfirming(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </Button>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={isConfirming}
        onOpenChange={(open) => !open && setIsConfirming(false)}
        title={`Delete this ${noun}?`}
        description={`The audio is deleted for everyone and cannot be recovered. The call keeps saying there was a ${noun} and that it was deleted.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => void confirm()}
        isLoading={isDeleting}
      />
    </>
  );
}
