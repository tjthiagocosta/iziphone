import type {
  CallEventType,
  CallRecordingContext,
  CallRecordingDeletionReason,
} from '@repo/db';

/*
 * The rules of owning a recording that need no I/O. Twilio makes the
 * recording and announces it; the API copies it into the media store, and
 * only once the copy is recorded does it delete the recording at Twilio.
 * Everything here decides from where a recording stands: whether a copy
 * exists, and whether Twilio still has the original.
 */

/** Where a recording stands, as its row records it. */
export interface RecordingWhereabouts {
  /** The copy in the media store; null until one exists, and again once deleted. */
  objectKey: string | null;
  /** When the recording was deleted at Twilio; null while Twilio still has it. */
  providerDeletedAt: Date | null;
  /** When the audio was deleted here, by the retention policy or by hand. */
  deletedAt: Date | null;
  deletionReason: CallRecordingDeletionReason | null;
}

export type PlaybackSource =
  | { source: 'store'; key: string }
  /** Fetch from Twilio, and a fetch that succeeds completes the copy. */
  | { source: 'provider' }
  /** Deleted on purpose; the reason is what the caller is told. */
  | { source: 'deleted'; reason: CallRecordingDeletionReason | null }
  /** No copy, and Twilio no longer has it: there is nothing to play. */
  | { source: 'gone' };

export type CopyPlan =
  /** Fetch from Twilio, store, record the copy, then delete at Twilio. */
  | { copy: 'fetch' }
  /** There is nothing to copy; only the deletion at Twilio is still owed. */
  | { copy: 'skip'; deleteAtProvider: true }
  /** Copied and deleted, or lost on both sides: nothing left to do. */
  | { copy: 'skip'; deleteAtProvider: false };

/** Where playback reads the audio from. */
export function playbackSource(
  recording: RecordingWhereabouts,
): PlaybackSource {
  // Checked first: a deleted recording is not fetched from Twilio again.
  if (recording.deletedAt !== null) {
    return { source: 'deleted', reason: recording.deletionReason };
  }

  if (recording.objectKey !== null) {
    return { source: 'store', key: recording.objectKey };
  }

  return recording.providerDeletedAt === null
    ? { source: 'provider' }
    : { source: 'gone' };
}

/**
 * What a copy attempt does. A recording with no copy is fetched only while
 * Twilio still has it; one with a copy but not yet deleted at Twilio (an
 * earlier deletion failed) owes only the deletion. A deleted recording is
 * never fetched, and still owes Twilio the deletion when it was deleted here
 * before a copy was ever made.
 */
export function copyPlan(recording: RecordingWhereabouts): CopyPlan {
  if (recording.deletedAt !== null) {
    return {
      copy: 'skip',
      deleteAtProvider: recording.providerDeletedAt === null,
    };
  }

  if (recording.objectKey === null) {
    return recording.providerDeletedAt === null
      ? { copy: 'fetch' }
      : { copy: 'skip', deleteAtProvider: false };
  }

  return recording.providerDeletedAt === null
    ? { copy: 'skip', deleteAtProvider: true }
    : { copy: 'skip', deleteAtProvider: false };
}

/**
 * Where the copy lives in the media store. Stored on the row rather than
 * derived on read: a conversation can be renamed by a migration, the key
 * cannot.
 */
export function recordingObjectKey(
  conversationUuid: string,
  recordingSid: string,
): string {
  return `recordings/${conversationUuid}/${recordingSid}.mp3`;
}

/**
 * The context the call controller announces a recording with: `voicemail`
 * for a message left when nobody answered, `conference` for the call itself.
 * An absent context is a voicemail, which is all the controller recorded
 * before it named contexts.
 */
export function recordingContextOf(
  context: string | undefined,
): CallRecordingContext {
  return context === undefined || context === 'voicemail'
    ? 'VOICEMAIL'
    : 'CONFERENCE';
}

/** The timeline entry a completed recording of each context writes. */
export function recordingEventType(
  context: CallRecordingContext,
): Extract<CallEventType, 'VOICEMAIL_COMPLETED' | 'RECORDING_COMPLETED'> {
  return context === 'VOICEMAIL'
    ? 'VOICEMAIL_COMPLETED'
    : 'RECORDING_COMPLETED';
}
