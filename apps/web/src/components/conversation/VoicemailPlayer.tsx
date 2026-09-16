'use client';

import { AlertCircle, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVoicemailPlayback } from '@/hooks/use-voicemail-playback';

interface VoicemailPlayerProps {
  conversationUuid: string;
}

/** Plays one call's voicemail. Nothing is downloaded until the user asks. */
export function VoicemailPlayer({ conversationUuid }: VoicemailPlayerProps) {
  /*
   * The key is what ties the audio to the call: a parent that reuses this
   * element for another call gets a new player, never the last call's
   * voicemail or the answer to its download.
   */
  return (
    <CallVoicemail key={conversationUuid} conversationUuid={conversationUuid} />
  );
}

function CallVoicemail({ conversationUuid }: VoicemailPlayerProps) {
  const { playback, src, play, reportUnplayable } =
    useVoicemailPlayback(conversationUuid);

  if (playback.status === 'failed') {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
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
      </div>
    );
  }

  if (playback.status === 'ready' && src) {
    return (
      /*
       * `autoPlay` because the user has just asked to hear it; where the
       * browser refuses to start sound by itself, the controls are there to
       * press.
       */
      // biome-ignore lint/a11y/useMediaCaption: a caller's voicemail has no caption track; its transcript, when there is one, is on the card under the player.
      <audio
        controls
        autoPlay
        src={src}
        onError={reportUnplayable}
        aria-label="Voicemail"
        className="mt-3 h-10 w-full"
      />
    );
  }

  const isLoading = playback.status !== 'idle';

  return (
    <Button
      variant="outline"
      size="sm"
      className="mt-3"
      onClick={play}
      disabled={isLoading}
      aria-busy={isLoading}
    >
      {isLoading ? <Loader2 className="animate-spin" /> : <Play />}
      {isLoading ? 'Loading voicemail…' : 'Play voicemail'}
    </Button>
  );
}
