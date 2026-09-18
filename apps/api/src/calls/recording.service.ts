import { Readable } from 'node:stream';
import type { CallRecordingContext, Prisma, PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import type { TwilioCredentials } from '../config.js';
import { HttpError } from '../infra/index.js';
import type { MediaStore } from '../media-store/index.js';
import {
  copyPlan,
  playbackSource,
  recordingObjectKey,
} from './recording-copy.js';
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

/** What Twilio documents for recording media: `audio/mpeg`, and `audio/x-wav` for WAV. */
const AUDIO_CONTENT_TYPES = new Set(['audio/mpeg', 'audio/x-wav', 'audio/wav']);

/** The columns of a recording the service decides from. */
const RECORDING_SELECT = {
  id: true,
  context: true,
  recordingSid: true,
  providerUrl: true,
  objectKey: true,
  providerDeletedAt: true,
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
  contentLength: number;
  body: Buffer | Readable;
}

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
    private readonly mediaStore: Pick<MediaStore, 'put' | 'get'>,
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
   * the reason logged, and the next play tries again.
   */
  async copy(
    recording: CallRecordingRow,
    conversationUuid: string,
  ): Promise<void> {
    const plan = copyPlan(recording);
    if (plan.copy === 'skip' && !plan.deleteAtProvider) {
      return;
    }

    const provider = this.providerAccess(recording, conversationUuid);
    if (provider.status !== 'ok') {
      if (provider.status === 'no-credentials') {
        this.log.warn(
          { conversationUuid, recordingSid: recording.recordingSid },
          'Cannot copy the recording without Twilio credentials; playback will fetch it from Twilio',
        );
      }
      return;
    }

    if (plan.copy === 'skip') {
      await this.deleteAtProvider(recording, provider, conversationUuid);
      return;
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
      return;
    }
    if (fetched.status !== 'ok') {
      return;
    }

    if (await this.store(recording, conversationUuid, fetched)) {
      await this.deleteAtProvider(recording, provider, conversationUuid);
    }
  }

  /**
   * The audio of a call's voicemail. Every failure is an `HttpError`: 404 for
   * a call outside the scope or without a voicemail, 503 without Twilio
   * credentials while the copy is still owed, 410 once neither side has the
   * recording, and 502 for anything else that goes wrong upstream.
   */
  async openVoicemail(
    scope: Prisma.CallWhereInput,
    conversationUuid: string,
  ): Promise<RecordingMedia> {
    const call = await this.db.call.findFirst({
      where: { conversationUuid, ...scope },
      select: {
        recordings: {
          where: { context: 'VOICEMAIL' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: RECORDING_SELECT,
        },
      },
    });

    if (!call) {
      throw new HttpError('Call not found', 404);
    }

    const recording = call.recordings[0];
    if (!recording) {
      throw new HttpError('This call has no voicemail', 404);
    }

    return this.open(recording, conversationUuid);
  }

  private async open(
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

    if (source.source === 'gone') {
      throw new HttpError('This voicemail is no longer available', 410);
    }

    const provider = this.providerAccess(recording, conversationUuid);
    if (provider.status === 'no-credentials') {
      throw new HttpError('Twilio credentials are not configured', 503);
    }
    if (provider.status === 'refused') {
      throw new HttpError('The voicemail could not be loaded', 502);
    }

    const fetched = await this.fetchFromProvider(
      recording,
      provider,
      conversationUuid,
    );
    if (fetched.status === 'not-found') {
      throw new HttpError('This voicemail is no longer available', 410);
    }
    if (fetched.status === 'failed') {
      throw playbackFailure(fetched.reason);
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

    if (await this.store(recording, conversationUuid, audio)) {
      await this.deleteAtProvider(recording, provider, conversationUuid);
    }

    return {
      contentType: audio.contentType,
      contentLength: audio.body.byteLength,
      body: audio.body,
    };
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

    try {
      await this.db.callRecording.update({
        where: { id: recording.id },
        data: { objectKey: key, storedAt: new Date() },
      });
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
   * Deletes the recording at Twilio, and records that it did. Twilio answers
   * 204 for a deletion and 404 for a recording it no longer has, which is
   * the same outcome. Anything else is logged and left for a later sweep,
   * with the copy kept: deleting is the one step that cannot be undone, so
   * it is never retried here.
   */
  private async deleteAtProvider(
    recording: CallRecordingRow,
    provider: Extract<ProviderAccess, { status: 'ok' }>,
    conversationUuid: string,
  ): Promise<void> {
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
      return;
    }

    if (status !== 204 && status !== 404) {
      this.log.warn(
        { ...context, status },
        'Twilio did not delete the recording; it stays there until a later sweep',
      );
      return;
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
    }
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
      ? 'The voicemail is too large to play'
      : 'The voicemail could not be loaded',
    502,
  );
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
