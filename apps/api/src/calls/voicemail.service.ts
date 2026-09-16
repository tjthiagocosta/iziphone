import { Readable } from 'node:stream';
import type { Prisma, PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import type { TwilioCredentials } from '../config.js';
import { HttpError } from '../infra/index.js';
import {
  twilioRecordingMediaUrl,
  voicemailRecordingUrl,
} from './voicemail-recording.js';

/**
 * How long Twilio gets to answer, and then to hand over each further piece of
 * the audio. It is not a deadline for the whole download: the audio is passed
 * on at the pace the client takes it, and a slow client is not a slow Twilio.
 */
const TWILIO_WAIT_MS = 30_000;

/**
 * How long the client gets to take the audio. This is what stands between a
 * client that stopped reading and the connection to Twilio it would hold open
 * with it: `fetch` does not give up on a body nobody is reading. A link that
 * needs longer than this for half a megabyte could not carry a call either.
 */
const DOWNLOAD_DEADLINE_MS = 5 * 60_000;

/**
 * The call controller records at most 120 seconds. That is under half a
 * megabyte as the 32 kbps MP3 this asks for and under two as WAV, so anything
 * past this is not a voicemail.
 */
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

/** What Twilio documents for recording media: `audio/mpeg`, and `audio/x-wav` for WAV. */
const AUDIO_CONTENT_TYPES = new Set(['audio/mpeg', 'audio/x-wav', 'audio/wav']);

export interface VoicemailMedia {
  contentType: string;
  /** Null when Twilio did not declare it; the stream is capped either way. */
  contentLength: number | null;
  stream: Readable;
}

/**
 * Opens the audio of a call's voicemail. The recording lives at Twilio behind
 * the account's credentials; this fetches it on the user's behalf so the
 * browser is handed audio and never the recording's URL.
 *
 * Every failure is an `HttpError`: 404 for a call outside the scope or without
 * a voicemail, 503 without Twilio credentials, 410 once Twilio no longer has
 * the recording, and 502 for anything else that goes wrong upstream. Nothing
 * Twilio answered is passed on except the audio itself, and the recording's
 * URL is never logged.
 */
export class VoicemailService {
  constructor(
    private readonly db: Pick<PrismaClient, 'call'>,
    private readonly credentials: TwilioCredentials | null,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
  ) {}

  async open(
    scope: Prisma.CallWhereInput,
    conversationUuid: string,
  ): Promise<VoicemailMedia> {
    const call = await this.db.call.findFirst({
      where: { conversationUuid, ...scope },
      select: {
        events: {
          where: { eventType: 'VOICEMAIL_COMPLETED' },
          orderBy: { createdAt: 'desc' },
          select: { metadata: true },
        },
      },
    });

    if (!call) {
      throw new HttpError('Call not found', 404);
    }

    const storedUrl = voicemailRecordingUrl(call.events);
    if (!storedUrl) {
      throw new HttpError('This call has no voicemail', 404);
    }

    if (!this.credentials) {
      throw new HttpError('Twilio credentials are not configured', 503);
    }

    const mediaUrl = twilioRecordingMediaUrl(
      storedUrl,
      this.credentials.accountSid,
    );
    if (!mediaUrl) {
      this.log.warn(
        { conversationUuid },
        'Refused to fetch a voicemail whose stored URL is not a Twilio recording of this account',
      );
      throw new HttpError('The voicemail could not be loaded', 502);
    }

    // Ends the exchange with Twilio, whichever side gives up on it.
    const exchange = new AbortController();
    const response = await this.fetchMedia(
      mediaUrl,
      this.credentials,
      exchange,
      conversationUuid,
    );

    if (response.status === 404) {
      exchange.abort();
      throw new HttpError('This voicemail is no longer available', 410);
    }

    const contentType = response.ok ? audioContentType(response) : null;
    const contentLength = declaredLength(response);

    if (
      !contentType ||
      !response.body ||
      (contentLength !== null && contentLength > MAX_MEDIA_BYTES)
    ) {
      exchange.abort();
      this.log.warn(
        {
          conversationUuid,
          status: response.status,
          contentType: response.headers.get('content-type'),
          contentLength,
        },
        'Twilio did not answer with a voicemail recording',
      );
      throw new HttpError('The voicemail could not be loaded', 502);
    }

    const stream = Readable.from(relay(response.body, exchange), {
      objectMode: false,
    });
    const deadline = setTimeout(
      () =>
        stream.destroy(new HttpError('The voicemail could not be loaded', 502)),
      DOWNLOAD_DEADLINE_MS,
    );
    // However the response ends (the audio did, a failure, a client that
    // left, a reply that never read it), the exchange with Twilio ends too.
    stream.once('close', () => {
      clearTimeout(deadline);
      exchange.abort();
    });

    return { contentType, contentLength, stream };
  }

  /**
   * `mediaUrl` comes from `twilioRecordingMediaUrl` and nowhere else, which
   * is what keeps the credentials on Twilio's host. A redirect is followed,
   * as `fetch` does by default, and the Fetch standard drops `Authorization`
   * when a redirect leaves the origin, so they do not travel with it.
   */
  private async fetchMedia(
    mediaUrl: string,
    { accountSid, authToken }: TwilioCredentials,
    exchange: AbortController,
    conversationUuid: string,
  ): Promise<Response> {
    try {
      return await inTime(
        exchange,
        fetch(mediaUrl, {
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          },
          signal: exchange.signal,
        }),
      );
    } catch (error) {
      this.log.warn(
        // The name only: the message of a fetch failure can quote the URL.
        {
          conversationUuid,
          reason: error instanceof Error ? error.name : 'unknown',
        },
        'Could not reach Twilio for a voicemail recording',
      );
      throw new HttpError('The voicemail could not be loaded', 502);
    }
  }
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

function audioContentType(response: Response): string | null {
  const declared = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();

  return declared && AUDIO_CONTENT_TYPES.has(declared) ? declared : null;
}

/**
 * The length to pass on, when it can be trusted: `fetch` decodes a compressed
 * body but keeps the header of the compressed one.
 */
function declaredLength(response: Response): number | null {
  if (response.headers.has('content-encoding')) {
    return null;
  }

  const declared = response.headers.get('content-length');
  return declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
}

/**
 * Passes the audio on piece by piece, so nothing is held in memory, and stops
 * at the cap whatever length Twilio declared. The clock runs only while a
 * piece is awaited from Twilio: between pieces this waits for the client to
 * take what it has, for as long as that takes.
 *
 * A failure before the first piece still reaches the error handler as a 502;
 * after it the status line has gone out, and all that is left is to cut the
 * response short, which the client sees as a failed download rather than as a
 * short voicemail.
 */
async function* relay(
  body: ReadableStream<Uint8Array>,
  exchange: AbortController,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let received = 0;

  try {
    for (;;) {
      const piece = await inTime(exchange, reader.read());
      if (piece.done) {
        return;
      }

      received += piece.value.byteLength;
      if (received > MAX_MEDIA_BYTES) {
        throw new HttpError('The voicemail is too large to play', 502);
      }
      yield piece.value;
    }
  } catch (error) {
    throw error instanceof HttpError
      ? error
      : new HttpError('The voicemail could not be loaded', 502);
  }
}
