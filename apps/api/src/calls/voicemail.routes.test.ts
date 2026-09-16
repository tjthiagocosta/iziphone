import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import type { ApiConfig } from '../config.js';
import {
  createApiRouteApp,
  testApiConfig,
} from '../test/route-test-helpers.js';
import { voicemailRoutes } from './voicemail.routes.js';

const agent: AuthUser = {
  id: 'user-7',
  email: 'agent@example.com',
  name: 'Agent Seven',
  role: 'AGENT',
  emailVerified: true,
};

const supervisor: AuthUser = { ...agent, id: 'user-8', role: 'SUPERVISOR' };

const agentScope = {
  OR: [{ userId: 'user-7' }, { departmentId: { in: ['dept-1'] } }],
};

/** What the route reads of a call: its voicemail entries, newest first. */
const select = {
  events: {
    where: { eventType: 'VOICEMAIL_COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  },
};

const recording =
  'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Recordings/REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function callWithVoicemail(recordingUrl: string = recording) {
  return {
    events: [
      { metadata: { recordingUrl, duration: 18, context: 'voicemail' } },
    ],
  };
}

const MEBIBYTE = 1024 * 1024;
const voicemailBytes = Buffer.from('fictional mp3 bytes');

function audio(
  body: BodyInit = voicemailBytes,
  headers: Record<string, string> = {
    'content-type': 'audio/mpeg',
    'content-length': String(voicemailBytes.byteLength),
  },
) {
  return new Response(body, { status: 200, headers });
}

/** Settles the way `fetch` and its body do once their signal is aborted. */
function abortedBy(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

/** A body of `chunks` one-mebibyte pieces, with no declared length. */
function mebibytes(chunks: number) {
  let sent = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(MEBIBYTE));
    },
  });
}

describe('voicemailRoutes', () => {
  let app: FastifyInstance;

  const findFirst = vi.fn(async (): Promise<unknown> => null);
  const findMemberships = vi.fn(async () => [{ departmentId: 'dept-1' }]);
  const fetchMock = vi.fn<typeof fetch>();

  async function buildApp(
    options: { user?: AuthUser | null; config?: Partial<ApiConfig> } = {},
  ) {
    return createApiRouteApp(voicemailRoutes, {
      user: options.user === undefined ? agent : options.user,
      config: options.config,
      db: {
        call: { findFirst },
        userDepartment: { findMany: findMemberships },
      } as never,
    });
  }

  function play() {
    return app.inject({
      method: 'GET',
      url: '/api/calls/conversation-1/voicemail',
    });
  }

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    findFirst.mockResolvedValue(callWithVoicemail());
    findMemberships.mockResolvedValue([{ departmentId: 'dept-1' }]);
    fetchMock.mockImplementation(async () => audio());
    app = await buildApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  test('plays the voicemail of a call the agent may see', async () => {
    const response = await play();

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(voicemailBytes);
    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationUuid: 'conversation-1', ...agentScope },
      select,
    });
  });

  test('describes the audio and keeps it out of shared caches', async () => {
    const response = await play();

    expect(response.headers).toMatchObject({
      'content-type': 'audio/mpeg',
      'content-length': String(voicemailBytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(JSON.stringify(response.headers)).not.toContain('twilio');
  });

  test('asks Twilio for the MP3 with the account credentials', async () => {
    await play();

    const { accountSid, authToken } = testApiConfig.twilio ?? {};
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${recording}.mp3`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      },
      signal: expect.any(AbortSignal),
    });
  });

  test('reads the voicemail entry, not the last recording of the call', async () => {
    findFirst.mockResolvedValue({
      // What a conference recording leaves on the row; the route never asks for it.
      recordingUrl: recording.replace('REb', 'REc'),
      ...callWithVoicemail(),
    });

    await play();

    expect(fetchMock).toHaveBeenCalledWith(
      `${recording}.mp3`,
      expect.anything(),
    );
  });

  test('lets a supervisor play the voicemail of any call', async () => {
    await app.close();
    app = await buildApp({ user: supervisor });

    const response = await play();

    expect(response.statusCode).toBe(200);
    expect(findMemberships).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationUuid: 'conversation-1' },
      select,
    });
  });

  test('answers 404 for a call outside the agent scope, as for one that does not exist', async () => {
    findFirst.mockResolvedValue(null);

    const response = await play();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Call not found',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('answers 404 for a call that left no voicemail', async () => {
    findFirst.mockResolvedValue({ events: [] });

    const response = await play();

    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('answers 401 to a signed-out request before reading anything', async () => {
    await app.close();
    app = await buildApp({ user: null });

    const response = await play();

    expect(response.statusCode).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('answers 503 when the deployment has no Twilio credentials', async () => {
    await app.close();
    app = await buildApp({ config: { twilio: null } });

    const response = await play();

    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'another host',
      stored: recording.replace('api.twilio.com', 'recordings.example.com'),
    },
    {
      name: 'a host that only starts like Twilio',
      stored: recording.replace('api.twilio.com', 'api.twilio.com.example.com'),
    },
    { name: 'plain http', stored: recording.replace('https:', 'http:') },
  ])(
    'sends no request, and so no credentials, for a stored URL on $name',
    async ({ stored }) => {
      const warn = vi.spyOn(app.log, 'warn');
      findFirst.mockResolvedValue(callWithVoicemail(stored));

      const response = await play();

      expect(response.statusCode).toBe(502);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.body).not.toContain(new URL(stored).hostname);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        new URL(stored).hostname,
      );
    },
  );

  test('sends no request for a recording of an account other than its own', async () => {
    const warn = vi.spyOn(app.log, 'warn');
    findFirst.mockResolvedValue(
      callWithVoicemail(
        recording.replace(
          'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'ACcccccccccccccccccccccccccccccccc',
        ),
      ),
    );

    const response = await play();

    expect(response.statusCode).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ACcccc');
  });

  test('answers 410 once Twilio no longer has the recording', async () => {
    fetchMock.mockResolvedValue(
      new Response('<TwilioResponse>not found</TwilioResponse>', {
        status: 404,
        headers: { 'content-type': 'application/xml' },
      }),
    );

    const response = await play();

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error: 'Gone',
      message: 'This voicemail is no longer available',
    });
  });

  test.each([
    { name: 'refuses the credentials', status: 401 },
    { name: 'fails', status: 500 },
  ])(
    'answers 502 without the upstream body when Twilio $name',
    async ({ status }) => {
      fetchMock.mockResolvedValue(
        new Response('upstream detail', {
          status,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      );

      const response = await play();

      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain('upstream detail');
    },
  );

  test('answers 502 when Twilio cannot be reached, without quoting the failure', async () => {
    const warn = vi.spyOn(app.log, 'warn');
    fetchMock.mockRejectedValue(
      new TypeError(`fetch failed for ${recording}.mp3`),
    );

    const response = await play();

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('twilio');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('api.twilio.com');
  });

  test('gives up on a Twilio that does not answer within 30 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockImplementation((_url, init) => abortedBy(init?.signal));

    const pending = play();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).statusCode).toBe(502);
  });

  test('cuts the response off when Twilio stops sending midway', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let pulls = 0;
    fetchMock.mockImplementation(async (_url, init) =>
      audio(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(new Uint8Array(1024));
              return;
            }
            return abortedBy(init?.signal);
          },
        }),
        { 'content-type': 'audio/mpeg' },
      ),
    );

    // The first piece went out with a 200; see the cap test below.
    const cutOff = expect(play()).rejects.toThrow();
    await vi.waitFor(() => expect(pulls).toBe(2));
    await vi.advanceTimersByTimeAsync(30_000);

    await cutOff;
  });

  test('answers 502 when the download stalls before the first byte', async () => {
    fetchMock.mockResolvedValue(
      audio(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new DOMException('timed out', 'TimeoutError'));
          },
        }),
        { 'content-type': 'audio/mpeg', 'content-length': '4096' },
      ),
    );

    const response = await play();

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: 'Bad Gateway',
      message: 'The voicemail could not be loaded',
    });
  });

  test('relays only audio', async () => {
    fetchMock.mockResolvedValue(
      audio('<html>sign in</html>', { 'content-type': 'text/html' }),
    );

    const response = await play();

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('sign in');
  });

  test('relays the WAV Twilio would send by default', async () => {
    fetchMock.mockResolvedValue(
      audio(voicemailBytes, { 'content-type': 'audio/x-wav; charset=binary' }),
    );

    const response = await play();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/x-wav');
  });

  test('refuses a recording that declares more than a voicemail can weigh', async () => {
    const body = mebibytes(1);
    fetchMock.mockResolvedValue(
      audio(body, {
        'content-type': 'audio/mpeg',
        'content-length': String(5 * MEBIBYTE + 1),
      }),
    );

    const response = await play();

    expect(response.statusCode).toBe(502);
    // Refused on the declaration: the exchange was ended, not read to the end.
    expect(body.locked).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  test('answers 502 when the first piece alone is over the cap', async () => {
    fetchMock.mockResolvedValue(
      audio(new Uint8Array(5 * MEBIBYTE + 1), { 'content-type': 'audio/mpeg' }),
    );

    const response = await play();

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: 'Bad Gateway',
      message: 'The voicemail is too large to play',
    });
  });

  test('cuts the response off when an undeclared body runs past the cap', async () => {
    fetchMock.mockResolvedValue(
      audio(mebibytes(6), { 'content-type': 'audio/mpeg' }),
    );

    // The status line went out with the first piece, so the only honest
    // signal left is a response that never completes.
    await expect(play()).rejects.toThrow();
  });

  test('relays a full-length voicemail whose length Twilio did not declare', async () => {
    fetchMock.mockResolvedValue(
      audio(mebibytes(2), { 'content-type': 'audio/mpeg' }),
    );

    const response = await play();

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBe(2 * MEBIBYTE);
  });

  test('does not pass on the length of a body fetch has decoded', async () => {
    fetchMock.mockResolvedValue(
      audio(voicemailBytes, {
        'content-type': 'audio/mpeg',
        'content-encoding': 'gzip',
        'content-length': '7',
      }),
    );

    const response = await play();

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(voicemailBytes);
  });

  test('does not fetch a recording to answer a HEAD', async () => {
    const response = await app.inject({
      method: 'HEAD',
      url: '/api/calls/conversation-1/voicemail',
    });

    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
