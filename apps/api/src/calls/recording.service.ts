import { Readable } from 'node:stream';
import type {
  CallRecordingContext,
  CallRecordingDeletionReason,
  Prisma,
  PrismaClient,
} from '@repo/db';
import type { CallRecordingDeletion } from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { TwilioCredentials } from '../config.js';
import { HttpError } from '../infra/index.js';
import type { MediaStore } from '../media-store/index.js';
import { toRecordingDeletion } from './call-record.js';
import {
  copyPlan,
  playbackSource,
  recordingObjectKey,
} from './recording-copy.js';
import { claimableCopyWhere } from './retention.js';
import {
  type TwilioRecordingRef,
  twilioRecordingRef,
  twilioRecordingSid,
} from './twilio-recording.js';

/**
 * How long Twilio gets to answer, and then to hand over each further piece of
 * the audio. A stall this long is given up on; a long recording that keeps
 * arriving is not.
 */
const TWILIO_WAIT_MS = 30_000;

/**
 * The most a recording of each context can weigh, as the 32 kbps MP3 this
 * asks for. The call controller records a voicemail for at most 120 seconds,
 * under half a megabyte, so anything past 5 MiB is not a voicemail. A
 * conference recording is the whole call; 64 MiB is about four and a half
 * hours of it.
 */
const MAX_MEDIA_BYTES: Record<CallRecordingContext, number> = {
  VOICEMAIL: 5 * 1024 * 1024,
  CONFERENCE: 64 * 1024 * 1024,
};

/**
 * How many times a deletion reads the row again when a copy landed under it.
 * Two would do; the third is for the copy that lands during the second.
 */
const DELETE_ATTEMPTS = 3;

/** What Twilio documents for recording media: `audio/mpeg`, and `audio/x-wav` for WAV. */
const AUDIO_CONTENT_TYPES = new Set(['audio/mpeg', 'audio/x-wav', 'audio/wav']);

/** The columns of a recording the service decides from. */
export const RECORDING_SELECT = {
  id: true,
  context: true,
  recordingSid: true,
  providerUrl: true,
  objectKey: true,
  providerDeletedAt: true,
  deletedAt: true,
  deletionReason: true,
} satisfies Prisma.CallRecordingSelect;

export type CallRecordingRow = Prisma.CallRecordingGetPayload<{
  select: typeof RECORDING_SELECT;
}>;

/** A recording the call controller announced as complete. */
export interface RecordingAnnouncement {
  callId: string;
  conversationUuid: string;
  context: CallRecordingContext;
  /** The URL Twilio announced the recording at. */
  providerUrl: string;
  duration: number | undefined;
}

export interface RecordingMedia {
  contentType: string;
  /** Null when the audio is streamed from Twilio and its length was not declared. */
  contentLength: number | null;
  body: Buffer | Readable;
}

/** What a copy attempt got done, for the sweep that has to report it. */
export interface RecordingCopyResult {
  /** The audio is now in the media store. */
  copied: boolean;
  /** Twilio no longer holds the recording. */
  providerDeleted: boolean;
}

/** What became of a request to delete a recording's audio. */
export type RecordingDeletion =
  | {
      outcome: 'deleted';
      /** This deletion is also what removed the recording at Twilio. */
      providerDeleted: boolean;
      /** What is now stored against the row, for the reply to publish. */
      deletion: CallRecordingDeletion;
    }
  /**
   * Somebody else deleted it first; nothing was changed. Their deletion is
   * what is stored, so a manual delete that lost to the sweep reports the
   * sweep's reason. Null only when the row itself is gone.
   */
  | { outcome: 'already-deleted'; deletion: CallRecordingDeletion | null }
  /** The store refused; the recording is still playable and still owed. */
  | { outcome: 'failed' };

/** The audio Twilio is sending, read piece by piece as it is consumed. */
interface ProviderAudio {
  contentType: string;
  /** Null when Twilio declared no length that can be trusted. */
  contentLength: number | null;
  pieces: AsyncGenerator<Uint8Array, void>;
}

/** The audio, held whole; only a voicemail is, on its way to the user. */
interface BufferedAudio {
  contentType: string;
  body: Buffer;
}

type FetchResult =
  | ({ status: 'ok' } & ProviderAudio)
  /** Twilio has no media for the recording: not ready yet, or deleted. */
  | { status: 'not-found' }
  | { status: 'failed'; reason: 'unreachable' | 'too-large' | 'upstream' };

/** Why the audio stopped arriving from Twilio before its end. */
class RecordingInterrupted extends Error {
  constructor(readonly reason: 'too-large' | 'cut-off') {
    super(`The recording was ${reason}`);
    this.name = 'RecordingInterrupted';
  }
}

type ProviderAccess =
  | { status: 'ok'; ref: TwilioRecordingRef; credentials: TwilioCredentials }
  | { status: 'no-credentials' }
  /** The stored URL is not a recording of the account the API holds credentials for. */
  | { status: 'refused' };

/**
 * Owns the recordings Twilio makes of calls. Twilio announces a recording;
 * this records it, copies the audio into the media store and, once the copy
 * is recorded, deletes the recording at Twilio. Playback reads the copy, and
 * falls back to fetching from Twilio while there is none: a copy can fail
 * (Twilio not ready yet, a timeout, the store down) and nothing may be lost
 * for it. A play that had to fall back completes the copy on the way.
 *
 * The recording's URL is fetched with the account's credentials on the
 * user's behalf, so the browser is handed audio and never the URL. Nothing
 * Twilio answered is passed on except the audio itself, and the URL is never
 * logged.
 */
export class CallRecordingService {
  constructor(
    private readonly db: Pick<PrismaClient, 'call' | 'callRecording'>,
    private readonly mediaStore: Pick<MediaStore, 'put' | 'get' | 'delete'>,
    private readonly credentials: TwilioCredentials | null,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  ) {}

  /**
   * Records the recording Twilio announced, so that it can be played from
   * Twilio at once and copied. Null, with the reason logged, when the URL is
   * not a Twilio recording: there is no SID to keep, and the call controller
   * only ever passes on what Twilio sent it.
   */
  async register(
    announcement: RecordingAnnouncement,
  ): Promise<CallRecordingRow | null> {
    const recordingSid = twilioRecordingSid(announcement.providerUrl);
    if (!recordingSid) {
      this.log.error(
        {
          conversationUuid: announcement.conversationUuid,
          context: announcement.context,
        },
        'Dropped a recording whose URL is not a Twilio recording',
      );
      return null;
    }

    return this.db.callRecording.upsert({
      where: { recordingSid },
      create: {
        callId: announcement.callId,
        context: announcement.context,
        recordingSid,
        providerUrl: announcement.providerUrl,
        duration: announcement.duration ?? null,
      },
      // A recording announced twice is the one already known.
      update: {},
      select: RECORDING_SELECT,
    });
  }

  /**
   * Copies the recording into the store and deletes it at Twilio. Nothing
   * here throws: any failure leaves the recording playable from Twilio, with
   * the reason logged, and the next play or sweep tries again.
   *
   * The copy is claimed on the row first, so a redelivered event, a fallback
   * play and the retention sweep meeting on one recording fetch it once
   * between them rather than once each.
   */
  async copy(
    recording: CallRecordingRow,
    conversationUuid: string,
  ): Promise<RecordingCopyResult> {
    const nothingDone: RecordingCopyResult = {
      copied: false,
      providerDeleted: false,
    };
    const plan = copyPlan(recording);
    if (plan.copy === 'skip' && !plan.deleteAtProvider) {
      return nothingDone;
    }

    const provider = this.providerAccess(recording, conversationUuid);
    if (provider.status !== 'ok') {
      if (provider.status === 'no-credentials') {
        this.log.warn(
          { conversationUuid, recordingSid: recording.recordingSid },
          'Cannot copy the recording without Twilio credentials; playback will fetch it from Twilio',
        );
      }
      return nothingDone;
    }

    if (plan.copy === 'skip') {
      return {
        copied: false,
        providerDeleted: await this.deleteAtProvider(
          recording,
          provider,
          conversationUuid,
        ),
      };
    }

    const claim = await this.claimCopy(recording, conversationUuid);
    if (!claim) {
      return nothingDone;
    }

    const fetched = await this.fetchFromProvider(
      recording,
      provider,
      conversationUuid,
    );
    if (fetched.status === 'not-found') {
      this.log.info(
        { conversationUuid, recordingSid: recording.recordingSid },
        'Recording not yet available at Twilio; playback will fetch it from Twilio until it is copied',
      );
      await this.releaseCopyClaim(recording, claim);
      return nothingDone;
    }
    if (fetched.status !== 'ok') {
      await this.releaseCopyClaim(recording, claim);
      return nothingDone;
    }

    if (await this.store(recording, conversationUuid, fetched)) {
      return {
        copied: true,
        providerDeleted: await this.deleteAtProvider(
          recording,
          provider,
          conversationUuid,
        ),
      };
    }

    await this.releaseCopyClaim(recording, claim);
    return nothingDone;
  }

  /**
   * Deletes the recording's audio: the copy from the store, and the original
   * at Twilio when it is still there. The row stays, marked with when and why,
   * so the call's history says the recording was deleted instead of offering a
   * player for audio that is gone.
   *
   * The store is emptied before the row is marked: a store that refuses leaves
   * a recording that still plays and is deleted again on the next attempt,
   * where the other order would leave a row nobody can play and an object
   * nobody knows about.
   *
   * The caller's row was read some time ago and a copy may have landed since,
   * so the key it held is pinned in the guard. A row that moved is read again
   * and deleted with the key it has now; the audio the copy wrote is never
   * left behind with nothing pointing at it.
   */
  async deleteAudio(
    recording: CallRecordingRow,
    conversationUuid: string,
    reason: CallRecordingDeletionReason,
  ): Promise<RecordingDeletion> {
    const context = { conversationUuid, recordingSid: recording.recordingSid };
    let row = recording;

    for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
      if (row.deletedAt !== null) {
        return {
          outcome: 'already-deleted',
          deletion: toRecordingDeletion(row.deletedAt, row.deletionReason),
        };
      }

      if (row.objectKey !== null) {
        try {
          await this.mediaStore.delete(row.objectKey);
        } catch (error) {
          this.log.warn(
            { ...context, err: error },
            'Could not delete the recording from the store; it stays until a later attempt',
          );
          return { outcome: 'failed' };
        }
      }

      const deletedAt = new Date();
      const { count } = await this.db.callRecording.updateMany({
        where: { id: row.id, deletedAt: null, objectKey: row.objectKey },
        data: { deletedAt, deletionReason: reason, objectKey: null },
      });

      if (count === 1) {
        this.log.info(
          { ...context, reason, context: row.context },
          'Deleted a recording',
        );

        // Deleted here before the copy ever succeeded: Twilio still has the
        // only one, and a deletion nobody asked for would leave it there.
        let providerDeleted = false;
        if (row.providerDeletedAt === null) {
          const provider = this.providerAccess(row, conversationUuid);
          if (provider.status === 'ok') {
            providerDeleted = await this.deleteAtProvider(
              row,
              provider,
              conversationUuid,
            );
          }
        }

        return {
          outcome: 'deleted',
          providerDeleted,
          deletion: { reason, at: deletedAt.toISOString() },
        };
      }

      const current = await this.db.callRecording.findFirst({
        where: { id: row.id },
        select: RECORDING_SELECT,
      });

      if (!current) {
        return { outcome: 'already-deleted', deletion: null };
      }

      row = current;
    }

    this.log.warn(
      context,
      'A copy kept landing while the recording was being deleted; it stays until a later attempt',
    );
    return { outcome: 'failed' };
  }

  /**
   * The recording of a call the caller may see, or a 404 that does not say
   * whether the call, the recording or the caller's access is what is missing.
   */
  async findInScope(
    scope: Prisma.CallWhereInput,
    conversationUuid: string,
    recordingId: string,
  ): Promise<CallRecordingRow> {
    const recording = await this.db.callRecording.findFirst({
      where: { id: recordingId, call: { conversationUuid, ...scope } },
      select: RECORDING_SELECT,
    });

    if (!recording) {
      throw new HttpError('Recording not found', 404);
    }

    return recording;
  }

  /**
   * The audio of a recording. Every failure is an `HttpError`: 503 without
   * Twilio credentials while the copy is still owed, 410 once the recording is
   * deleted or neither side has it, and 502 for anything that goes wrong
   * upstream.
   *
   * A voicemail fetched from Twilio because the copy is still owed completes
   * that copy on its way to the user. A recording of a whole call does not: it
   * is streamed straight through, because holding hours of audio in memory to
   * save the sweep one fetch is the wrong trade.
   */
  async open(
    recording: CallRecordingRow,
    conversationUuid: string,
  ): Promise<RecordingMedia> {
    const source = playbackSource(recording);

    if (source.source === 'store') {
      const stored = await this.mediaStore.get(source.key);
      if (stored) {
        return stored;
      }

      // The row says there is a copy and the store has none. Whatever
      // happened to it, Twilio may still have the recording.
      this.log.warn(
        { conversationUuid, recordingSid: recording.recordingSid },
        'The copy of the recording is missing from the store',
      );
      return this.open({ ...recording, objectKey: null }, conversationUuid);
    }

    if (source.source === 'deleted') {
      throw new HttpError(deletedMessage(source.reason), 410);
    }

    if (source.source === 'gone') {
      throw new HttpError('This recording is no longer available', 410);
    }

    const provider = this.providerAccess(recording, conversationUuid);
    if (provider.status === 'no-credentials') {
      throw new HttpError('Twilio credentials are not configured', 503);
    }
    if (provider.status === 'refused') {
      throw new HttpError('The recording could not be loaded', 502);
    }

    const fetched = await this.fetchFromProvider(
      recording,
      provider,
      conversationUuid,
    );
    if (fetched.status === 'not-found') {
      throw new HttpError('This recording is no longer available', 410);
    }
    if (fetched.status === 'failed') {
      throw playbackFailure(fetched.reason);
    }

    if (recording.context !== 'VOICEMAIL') {
      return {
        contentType: fetched.contentType,
        contentLength: fetched.contentLength,
        body: Readable.from(fetched.pieces, { objectMode: false }),
      };
    }

    // Fetched once: this play completes the copy on its way to the user. The
    // audio is held whole for that, which a voicemail's cap keeps small.
    let audio: BufferedAudio;
    try {
      audio = {
        contentType: fetched.contentType,
        body: await bufferAll(fetched.pieces),
      };
    } catch (error) {
      const reason = interruption(error);
      this.log.warn(
        { conversationUuid, recordingSid: recording.recordingSid, reason },
        'Twilio did not send the whole recording',
      );
      throw playbackFailure(reason);
    }

    // The user is served either way; the copy only happens if this play is the
    // one that claims it, so a play racing the sweep stores the audio once.
    const claim = await this.claimCopy(recording, conversationUuid);
    if (claim) {
      if (await this.store(recording, conversationUuid, audio)) {
        await this.deleteAtProvider(recording, provider, conversationUuid);
      } else {
        await this.releaseCopyClaim(recording, claim);
      }
    }

    return {
      contentType: audio.contentType,
      contentLength: audio.body.byteLength,
      body: audio.body,
    };
  }

  /**
   * Takes the copy of this recording for the caller, answering the moment the
   * claim was written, or null when somebody else holds it. A claim older than
   * `COPY_CLAIM_STALE_MS` belonged to an attempt that never finished and is
   * taken over.
   */
  private async claimCopy(
    recording: CallRecordingRow,
    conversationUuid: string,
  ): Promise<Date | null> {
    const now = new Date();

    const { count } = await this.db.callRecording.updateMany({
      where: { id: recording.id, ...claimableCopyWhere(now) },
      data: { copyStartedAt: now },
    });

    if (count === 1) {
      return now;
    }

    // Either another attempt holds the claim, or the recording was deleted
    // between the row being read and this write; neither is this one's to copy.
    this.log.info(
      { conversationUuid, recordingSid: recording.recordingSid },
      'This recording is being copied elsewhere or is already deleted; leaving it alone',
    );
    return null;
  }

  /**
   * Hands the claim back after an attempt that stored nothing, so the next one
   * starts at once instead of waiting for the claim to go stale. Guarded on
   * the moment this attempt wrote, so a claim already taken over is left alone.
   */
  private async releaseCopyClaim(
    recording: CallRecordingRow,
    claimedAt: Date,
  ): Promise<void> {
    await this.db.callRecording.updateMany({
      where: { id: recording.id, copyStartedAt: claimedAt },
      data: { copyStartedAt: null },
    });
  }

  private providerAccess(
    recording: CallRecordingRow,
    conversationUuid: string,
  ): ProviderAccess {
    if (!this.credentials) {
      return { status: 'no-credentials' };
    }

    const ref = twilioRecordingRef(
      recording.providerUrl,
      this.credentials.accountSid,
    );
    if (!ref) {
      this.log.warn(
        { conversationUuid, recordingSid: recording.recordingSid },
        'Refused to fetch a recording whose stored URL is not a Twilio recording of this account',
      );
      return { status: 'refused' };
    }

    return { status: 'ok', ref, credentials: this.credentials };
  }

  /**
   * Puts the audio in the store and records the copy on the row. False, with
   * the reason logged, when either failed: the recording stays playable from
   * Twilio, and an object the row does not know of is overwritten by the
   * next attempt.
   *
   * Audio still arriving from Twilio is streamed into the store, so a
   * recording of a whole call never sits in memory; every call is recorded,
   * and their copies run whenever calls end. The store needs the length for
   * that, so the rare recording Twilio declares no length for is held whole,
   * within its cap.
   */
  private async store(
    recording: CallRecordingRow,
    conversationUuid: string,
    audio: ProviderAudio | BufferedAudio,
  ): Promise<boolean> {
    const key = recordingObjectKey(conversationUuid, recording.recordingSid);
    const context = { conversationUuid, recordingSid: recording.recordingSid };

    try {
      if (!('pieces' in audio)) {
        await this.mediaStore.put({ key, ...audio });
      } else if (audio.contentLength !== null) {
        await this.mediaStore.put({
          key,
          contentType: audio.contentType,
          contentLength: audio.contentLength,
          body: Readable.from(audio.pieces, { objectMode: false }),
        });
      } else {
        await this.mediaStore.put({
          key,
          contentType: audio.contentType,
          body: await bufferAll(audio.pieces),
        });
      }
    } catch (error) {
      if (error instanceof RecordingInterrupted) {
        this.log.warn(
          { ...context, reason: error.reason },
          'Twilio did not send the whole recording; playback keeps fetching it from Twilio',
        );
      } else {
        this.log.warn(
          { ...context, err: error },
          'Could not store the recording; playback keeps fetching it from Twilio',
        );
      }
      return false;
    }

    /*
     * Guarded on the deletion: a recording deleted while this copy was running
     * must not come back as an object nothing points at. The deletion left the
     * row saying the audio is gone, so what this copy just stored is the only
     * thing left to clean up.
     */
    try {
      const { count } = await this.db.callRecording.updateMany({
        where: { id: recording.id, deletedAt: null },
        data: { objectKey: key, storedAt: new Date() },
      });

      if (count !== 1) {
        await this.discard(key, context);
        return false;
      }
    } catch (error) {
      this.log.warn(
        { ...context, err: error },
        'Stored the recording but could not record the copy; playback keeps fetching it from Twilio',
      );
      return false;
    }

    return true;
  }

  /**
   * Drops audio the row does not point at, so that a recording deleted while
   * its copy was running leaves nothing behind. A store that refuses leaves an
   * object nothing references; it is logged, and the next copy overwrites the
   * key.
   */
  private async discard(
    key: string,
    context: { conversationUuid: string; recordingSid: string },
  ): Promise<void> {
    this.log.info(
      context,
      'The recording was deleted while it was being copied; dropping the copy',
    );

    try {
      await this.mediaStore.delete(key);
    } catch (error) {
      this.log.warn(
        { ...context, err: error },
        'Could not drop the copy of a recording that was deleted while it was being copied',
      );
    }
  }

  /**
   * Deletes the recording at Twilio, and records that it did. Twilio answers
   * 204 for a deletion and 404 for a recording it no longer has, which is
   * the same outcome. Anything else is logged and left for a later sweep,
   * with the copy kept: deleting is the one step that cannot be undone, so
   * it is never retried here.
   *
   * Answers whether Twilio's copy is gone *and* the row now says so: a
   * deletion the row did not record is owed again, and deleting a recording
   * Twilio no longer has costs one request.
   */
  private async deleteAtProvider(
    recording: CallRecordingRow,
    provider: Extract<ProviderAccess, { status: 'ok' }>,
    conversationUuid: string,
  ): Promise<boolean> {
    const context = { conversationUuid, recordingSid: recording.recordingSid };
    const exchange = new AbortController();
    let status: number;

    try {
      const response = await inTime(
        exchange,
        fetch(provider.ref.resourceUrl, {
          method: 'DELETE',
          headers: basicAuth(provider.credentials),
          signal: exchange.signal,
        }),
      );
      status = response.status;
      await response.body?.cancel();
    } catch (error) {
      this.log.warn(
        // The name only: the message of a fetch failure can quote the URL.
        { ...context, reason: error instanceof Error ? error.name : 'unknown' },
        'Could not reach Twilio to delete the recording; it stays there until a later sweep',
      );
      return false;
    }

    if (status !== 204 && status !== 404) {
      this.log.warn(
        { ...context, status },
        'Twilio did not delete the recording; it stays there until a later sweep',
      );
      return false;
    }

    try {
      await this.db.callRecording.update({
        where: { id: recording.id },
        data: { providerDeletedAt: new Date() },
      });
    } catch (error) {
      this.log.warn(
        { ...context, err: error },
        'Deleted the recording at Twilio but could not record it',
      );
      return false;
    }

    return true;
  }

  /**
   * Starts fetching the recording; the audio arrives as `pieces` is read,
   * within the cap of its context. `provider.ref` comes from
   * `twilioRecordingRef` and nowhere else, which is what keeps the credentials
   * on Twilio's host. A redirect is followed, as `fetch` does by default, and
   * the Fetch standard drops `Authorization` when a redirect leaves the
   * origin, so they do not travel with it.
   */
  private async fetchFromProvider(
    recording: CallRecordingRow,
    provider: Extract<ProviderAccess, { status: 'ok' }>,
    conversationUuid: string,
  ): Promise<FetchResult> {
    const context = { conversationUuid, recordingSid: recording.recordingSid };
    const maxBytes = MAX_MEDIA_BYTES[recording.context];
    // Ends the exchange with Twilio, whichever side gives up on it.
    const exchange = new AbortController();
    let response: Response;

    try {
      response = await inTime(
        exchange,
        fetch(provider.ref.mediaUrl, {
          headers: basicAuth(provider.credentials),
          signal: exchange.signal,
        }),
      );
    } catch (error) {
      this.log.warn(
        // The name only: the message of a fetch failure can quote the URL.
        { ...context, reason: error instanceof Error ? error.name : 'unknown' },
        'Could not reach Twilio for a recording',
      );
      return { status: 'failed', reason: 'unreachable' };
    }

    if (response.status === 404) {
      exchange.abort();
      return { status: 'not-found' };
    }

    const contentType = response.ok ? audioContentType(response) : null;
    const contentLength = declaredLength(response);
    const tooLarge = contentLength !== null && contentLength > maxBytes;

    if (!contentType || !response.body || tooLarge) {
      exchange.abort();
      this.log.warn(
        {
          ...context,
          status: response.status,
          contentType: response.headers.get('content-type'),
          contentLength,
        },
        'Twilio did not answer with a recording',
      );
      return { status: 'failed', reason: tooLarge ? 'too-large' : 'upstream' };
    }

    return {
      status: 'ok',
      contentType,
      contentLength,
      pieces: piecesWithin(response.body, exchange, maxBytes),
    };
  }
}

function basicAuth({ accountSid, authToken }: TwilioCredentials) {
  return {
    authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
  };
}

function playbackFailure(
  reason: 'unreachable' | 'too-large' | 'upstream' | 'cut-off',
) {
  return new HttpError(
    reason === 'too-large'
      ? 'The recording is too large to play'
      : 'The recording could not be loaded',
    502,
  );
}

/** What a caller is told about a recording that was deleted on purpose. */
function deletedMessage(reason: CallRecordingDeletionReason | null): string {
  return reason === 'RETENTION_POLICY'
    ? 'This recording was deleted by the retention policy'
    : 'This recording was deleted';
}

/** What stopped the audio; anything but the cap is Twilio cutting it off. */
function interruption(error: unknown): 'too-large' | 'cut-off' {
  return error instanceof RecordingInterrupted ? error.reason : 'cut-off';
}

/** Waits for Twilio, and ends the exchange when the wait is too long. */
async function inTime<T>(
  exchange: AbortController,
  waiting: Promise<T>,
): Promise<T> {
  const timer = setTimeout(
    () =>
      exchange.abort(new DOMException('Twilio took too long', 'TimeoutError')),
    TWILIO_WAIT_MS,
  );

  try {
    return await waiting;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Yields the audio piece by piece and stops at the cap whatever length Twilio
 * declared, with a `RecordingInterrupted` for the reason. The clock runs
 * while a piece is awaited, so a stall ends the exchange and a long recording
 * that keeps arriving does not. However the reading ends, so does the
 * exchange: a reader that stops early leaves nothing open.
 */
async function* piecesWithin(
  body: ReadableStream<Uint8Array>,
  exchange: AbortController,
  maxBytes: number,
): AsyncGenerator<Uint8Array, void> {
  const reader = body.getReader();
  let received = 0;

  try {
    for (;;) {
      let piece: Awaited<ReturnType<typeof reader.read>>;
      try {
        piece = await inTime(exchange, reader.read());
      } catch {
        // The body failed or the wait ran out.
        throw new RecordingInterrupted('cut-off');
      }

      if (piece.done) {
        return;
      }

      received += piece.value.byteLength;
      if (received > maxBytes) {
        throw new RecordingInterrupted('too-large');
      }
      yield piece.value;
    }
  } finally {
    exchange.abort();
  }
}

async function bufferAll(pieces: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const held: Uint8Array[] = [];
  for await (const piece of pieces) {
    held.push(piece);
  }
  return Buffer.concat(held);
}

function audioContentType(response: Response): string | null {
  const declared = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();

  return declared && AUDIO_CONTENT_TYPES.has(declared) ? declared : null;
}

/**
 * The length Twilio declared, when it can be trusted: `fetch` decodes a
 * compressed body but keeps the header of the compressed one.
 */
function declaredLength(response: Response): number | null {
  if (response.headers.has('content-encoding')) {
    return null;
  }

  const declared = response.headers.get('content-length');
  return declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
}
