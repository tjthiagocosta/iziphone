/*
 * What the voicemail player on a call's card is doing, and what each thing
 * that can happen to it changes. Kept free of React and of the network so the
 * rules can be tested; `useVoicemailPlayback` does the download and owns the
 * object URL the audio element plays.
 *
 * Nothing is downloaded until the user asks: a thread can hold many
 * voicemails, and each one is a request the API forwards to the provider.
 */

export type VoicemailPlayback =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; audio: Blob }
  | { status: 'failed'; message: string };

export type VoicemailPlaybackEvent =
  | { type: 'requested' }
  | { type: 'loaded'; audio: Blob }
  /** `status` is the API's answer, or null when there was none to read. */
  | { type: 'failed'; status: number | null }
  /** The browser could not play what was downloaded. */
  | { type: 'unplayable' };

export const IDLE_VOICEMAIL: VoicemailPlayback = { status: 'idle' };

/**
 * A failed download, read from its status. 404 is a call that is no longer
 * the user's to see or whose voicemail names no recording, 410 a recording
 * the provider no longer has. Everything else (the provider unreachable, the
 * network, a rate limit) is a voicemail that did not arrive this time.
 *
 * Every failure can be tried again, the first kind too: a recording that
 * reaches the call's timeline a moment after its card was drawn answers 404
 * until it does, and a retry that changes nothing costs one request.
 */
export function voicemailFailure(
  status: number | null,
): Extract<VoicemailPlayback, { status: 'failed' }> {
  return {
    status: 'failed',
    message:
      status === 404 || status === 410
        ? 'This voicemail is no longer available'
        : 'This voicemail could not be loaded',
  };
}

/** Whether pressing play starts a download from here. */
export function canRequestVoicemail(playback: VoicemailPlayback): boolean {
  return playback.status === 'idle' || playback.status === 'failed';
}

/**
 * An event that does not belong to the current state leaves it alone: a
 * second press while loading, or the answer to a download nobody is waiting
 * for any more.
 */
export function voicemailPlaybackReducer(
  playback: VoicemailPlayback,
  event: VoicemailPlaybackEvent,
): VoicemailPlayback {
  switch (event.type) {
    case 'requested':
      return canRequestVoicemail(playback) ? { status: 'loading' } : playback;
    case 'loaded':
      return playback.status === 'loading'
        ? { status: 'ready', audio: event.audio }
        : playback;
    case 'failed':
      return playback.status === 'loading'
        ? voicemailFailure(event.status)
        : playback;
    case 'unplayable':
      return playback.status === 'ready'
        ? { status: 'failed', message: 'This voicemail could not be played' }
        : playback;
  }
}
