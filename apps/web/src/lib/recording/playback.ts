import type { CallRecordingSummary } from '@repo/dto';

/*
 * What the player on a call's card is doing, and what each thing that can
 * happen to it changes. Kept free of React and of the network so the rules can
 * be tested; `useRecordingPlayback` does the download and owns the object URL
 * the audio element plays.
 *
 * Nothing is downloaded until the user asks: a thread can hold many
 * recordings, and each one is a request the API serves from the store or
 * forwards to the provider.
 */

export type RecordingPlayback =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; audio: Blob }
  | { status: 'failed'; message: string };

export type RecordingPlaybackEvent =
  | { type: 'requested' }
  | { type: 'loaded'; audio: Blob }
  /**
   * `status` is the API's answer, or null when there was none to read;
   * `message` what it said, which for a recording that is gone says why.
   */
  | { type: 'failed'; status: number | null; message?: string }
  /** The browser could not play what was downloaded. */
  | { type: 'unplayable' };

export const IDLE_RECORDING: RecordingPlayback = { status: 'idle' };

/** How a recording of each kind is called in a sentence about it. */
export function recordingNoun(recording: CallRecordingSummary): string {
  return recording.context === 'VOICEMAIL' ? 'voicemail' : 'call recording';
}

/**
 * What to say on a call whose timeline records a voicemail that has no
 * recording of its own, and null when there is nothing to explain. It happens
 * for a call from before recordings were rows, and for one whose recording
 * never reached us, so the card says so instead of announcing a voicemail
 * above nothing at all.
 */
export function missingVoicemailNotice(
  hasVoicemail: boolean,
  recordings: readonly CallRecordingSummary[],
): string | null {
  if (
    !hasVoicemail ||
    recordings.some((recording) => recording.context === 'VOICEMAIL')
  ) {
    return null;
  }

  return 'No audio was kept for this voicemail';
}

/**
 * Why a recording cannot be played any more, or null while it can be. The
 * audio of a deleted recording is gone for good; the row stays so the call's
 * history still says there was one and what became of it.
 */
export function deletionNotice(recording: CallRecordingSummary): string | null {
  if (recording.deletion === null) {
    return null;
  }

  const noun = recordingNoun(recording);

  return recording.deletion.reason === 'RETENTION_POLICY'
    ? `This ${noun} was deleted by the retention policy`
    : `This ${noun} was deleted`;
}

/**
 * A failed download, read from what the API answered. 410 is a recording that
 * is gone, and the API says why (deleted here, or no longer at the provider),
 * so its own words are shown. 404 is a call that is no longer the user's to
 * see, or a recording that is not on it. Everything else (the provider
 * unreachable, the network, a rate limit) is a recording that did not arrive
 * this time.
 *
 * Every failure can be tried again, the first kinds too: a recording that
 * reaches the call a moment after its card was drawn answers 404 until it
 * does, and a retry that changes nothing costs one request.
 */
export function recordingFailure(
  status: number | null,
  message?: string,
): Extract<RecordingPlayback, { status: 'failed' }> {
  if (status === 410 && message) {
    return { status: 'failed', message };
  }

  return {
    status: 'failed',
    message:
      status === 404 || status === 410
        ? 'This recording is no longer available'
        : 'This recording could not be loaded',
  };
}

/** Whether pressing play starts a download from here. */
export function canRequestRecording(playback: RecordingPlayback): boolean {
  return playback.status === 'idle' || playback.status === 'failed';
}

/**
 * An event that does not belong to the current state leaves it alone: a
 * second press while loading, or the answer to a download nobody is waiting
 * for any more.
 */
export function recordingPlaybackReducer(
  playback: RecordingPlayback,
  event: RecordingPlaybackEvent,
): RecordingPlayback {
  switch (event.type) {
    case 'requested':
      return canRequestRecording(playback) ? { status: 'loading' } : playback;
    case 'loaded':
      return playback.status === 'loading'
        ? { status: 'ready', audio: event.audio }
        : playback;
    case 'failed':
      return playback.status === 'loading'
        ? recordingFailure(event.status, event.message)
        : playback;
    case 'unplayable':
      return playback.status === 'ready'
        ? { status: 'failed', message: 'This recording could not be played' }
        : playback;
  }
}
