import { afterEach, describe, expect, test, vi } from 'vitest';
import { VoicemailService } from './voicemail.service.js';

/*
 * The route tests cover what the service answers. What they cannot show is
 * pacing: `inject` takes a body as fast as it comes, and only the stream
 * itself can be read the way a slow client reads it.
 */

const credentials = {
  accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authToken: 'not-a-real-twilio-token',
};

const call = {
  events: [
    {
      metadata: {
        recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Recordings/REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      },
    },
  ],
};

const PIECE_BYTES = 64 * 1024;

/** A body that fails once its signal is aborted, as the body of `fetch` does. */
function pieces(count: number, signal: AbortSignal) {
  let sent = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason));
    },
    pull(controller) {
      if (sent === count) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(PIECE_BYTES));
    },
  });
}

describe('VoicemailService', () => {
  /** Opens a voicemail of four pieces, and says what became of the exchange. */
  async function openVoicemail() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const exchange: { signal?: AbortSignal } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, init) => {
        const signal = init?.signal ?? new AbortController().signal;
        exchange.signal = signal;
        return new Response(pieces(4, signal), {
          headers: { 'content-type': 'audio/mpeg' },
        });
      }),
    );
    const service = new VoicemailService(
      { call: { findFirst: vi.fn(async () => call) } } as never,
      credentials,
      { warn: vi.fn() },
    );

    const media = await service.open({}, 'conversation-1');
    return { stream: media.stream, exchange };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  test('does not hold a slow client to the time Twilio is given', async () => {
    const { stream, exchange } = await openVoicemail();
    const download = stream[Symbol.asyncIterator]();
    const first = await download.next();

    // Four minutes over the first piece, with more already waiting for it.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(exchange.signal?.aborted).toBe(false);

    let received: number = first.value.byteLength;
    for (;;) {
      const next = await download.next();
      if (next.done) {
        break;
      }
      received += next.value.byteLength;
    }

    expect(received).toBe(4 * PIECE_BYTES);
    expect(exchange.signal?.aborted).toBe(true);
  });

  test('lets go of Twilio when the client stops taking the audio', async () => {
    const { stream, exchange } = await openVoicemail();
    const download = stream[Symbol.asyncIterator]();
    await download.next();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(exchange.signal?.aborted).toBe(true);
    await expect(download.next()).rejects.toMatchObject({ statusCode: 502 });
  });

  test('lets go of Twilio when the response goes away before it is read', async () => {
    const { stream, exchange } = await openVoicemail();
    const closed = new Promise((resolve) => stream.once('close', resolve));

    stream.destroy();
    await closed;

    expect(exchange.signal?.aborted).toBe(true);
  });
});
