import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import type { ApiConfig } from '../config.js';
import { InMemoryMediaStore } from '../media-store/index.js';
import {
  createApiRouteApp,
  testApiConfig,
} from '../test/route-test-helpers.js';
import { recordingRoutes } from './recording.routes.js';

const agent: AuthUser = {
  id: 'user-7',
  email: 'agent@example.com',
  name: 'Agent Seven',
  role: 'AGENT',
  emailVerified: true,
};

const supervisor: AuthUser = { ...agent, id: 'user-8', role: 'SUPERVISOR' };
const admin: AuthUser = { ...agent, id: 'user-9', role: 'ADMIN' };

const agentScope = {
  OR: [{ userId: 'user-7' }, { departmentId: { in: ['dept-1'] } }],
};

const accountSid = 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const recordingSid = 'REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const recording = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}`;
const recordingKey = `recordings/conversation-1/${recordingSid}.mp3`;

/** A voicemail as Twilio announced it: no copy yet, still at Twilio. */
function announced(providerUrl: string = recording) {
  return {
    id: 'recording-1',
    context: 'VOICEMAIL' as const,
    recordingSid,
    providerUrl,
    objectKey: null,
    providerDeletedAt: null,
    deletedAt: null,
    deletionReason: null,
  };
}

/** A voicemail copied into the store and deleted at Twilio. */
const settled = {
  ...announced(),
  objectKey: recordingKey,
  providerDeletedAt: new Date('2026-03-20T10:05:00.000Z'),
};

/** The recording of the call itself, which only some roles may hear. */
const conference = { ...announced(), context: 'CONFERENCE' as const };

const MEBIBYTE = 1024 * 1024;
const voicemailBytes = Buffer.from('fictional mp3 bytes');
const copiedBytes = Buffer.from('fictional mp3 bytes of the copy');

function audio(
  body: BodyInit = voicemailBytes,
  headers: Record<string, string> = {
    'content-type': 'audio/mpeg',
    'content-length': String(voicemailBytes.byteLength),
  },
) {
  return new Response(body, { status: 200, headers });
}

const deleted = () => new Response(null, { status: 204 });

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

describe('recordingRoutes', () => {
  let app: FastifyInstance;
  let mediaStore: InMemoryMediaStore;

  const findFirst = vi.fn(async (): Promise<unknown> => null);
  const updateRecording = vi.fn(async () => ({ id: 'recording-1' }));
  const updateManyRecordings = vi.fn(async () => ({ count: 1 }));
  const findMemberships = vi.fn(async () => [{ departmentId: 'dept-1' }]);
  const createAuditEntry = vi.fn(async () => ({ id: 'audit-1' }));
  const fetchMock = vi.fn<typeof fetch>();

  async function buildApp(
    options: { user?: AuthUser | null; config?: Partial<ApiConfig> } = {},
  ) {
    return createApiRouteApp(recordingRoutes, {
      user: options.user === undefined ? agent : options.user,
      config: options.config,
      mediaStore,
      db: {
        callRecording: {
          findFirst,
          update: updateRecording,
          updateMany: updateManyRecordings,
        },
        userDepartment: { findMany: findMemberships },
        auditLog: { create: createAuditEntry },
      } as never,
    });
  }

  function play(recordingId = 'recording-1') {
    return app.inject({
      method: 'GET',
      url: `/api/calls/conversation-1/recordings/${recordingId}`,
    });
  }

  function remove(recordingId = 'recording-1') {
    return app.inject({
      method: 'DELETE',
      url: `/api/calls/conversation-1/recordings/${recordingId}`,
    });
  }

  /** What Twilio was asked, in order. */
  function twilioRequests() {
    return fetchMock.mock.calls.map(([url, init]) => ({
      method: init?.method ?? 'GET',
      url,
    }));
  }

  /** Twilio as a fallback play sees it: the MP3 on a GET, 204 on a DELETE. */
  function twilioAnswers(get: () => Response | Promise<Response> = audio) {
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'DELETE' ? deleted() : get(),
    );
  }

  beforeEach(async () => {
    vi.stubGlobal('fetch', fetchMock);
    mediaStore = new InMemoryMediaStore();
    findFirst.mockResolvedValue(announced());
    findMemberships.mockResolvedValue([{ departmentId: 'dept-1' }]);
    updateManyRecordings.mockResolvedValue({ count: 1 });
    twilioAnswers();
    app = await buildApp();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  describe('from the store', () => {
    beforeEach(async () => {
      findFirst.mockResolvedValue(settled);
      await mediaStore.put({
        key: recordingKey,
        contentType: 'audio/mpeg',
        body: copiedBytes,
      });
    });

    test('plays the copy without asking Twilio', async () => {
      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(copiedBytes);
      expect(response.headers).toMatchObject({
        'content-type': 'audio/mpeg',
        'content-length': String(copiedBytes.byteLength),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateRecording).not.toHaveBeenCalled();
    });

    test('plays the copy without Twilio credentials', async () => {
      await app.close();
      app = await buildApp({ config: { twilio: null } });

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(copiedBytes);
    });

    test('falls back to Twilio when the copy is missing from the store', async () => {
      const warn = vi.spyOn(app.log, 'warn');
      findFirst.mockResolvedValue({ ...settled, providerDeletedAt: null });
      await mediaStore.delete(recordingKey);

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(voicemailBytes);
      expect(warn).toHaveBeenCalledWith(
        { conversationUuid: 'conversation-1', recordingSid },
        'The copy of the recording is missing from the store',
      );
      expect(mediaStore.keys()).toEqual([recordingKey]);
    });

    test('answers 410 when the copy is missing and Twilio no longer has it', async () => {
      await mediaStore.delete(recordingKey);

      const response = await play();

      expect(response.statusCode).toBe(410);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('once the recording is deleted', () => {
    test('says the retention policy deleted it, and asks Twilio nothing', async () => {
      findFirst.mockResolvedValue({
        ...settled,
        objectKey: null,
        deletedAt: new Date('2026-06-20T10:05:00.000Z'),
        deletionReason: 'RETENTION_POLICY',
      });

      const response = await play();

      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({
        error: 'Gone',
        message: 'This recording was deleted by the retention policy',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('says a hand-deleted recording was deleted', async () => {
      findFirst.mockResolvedValue({
        ...settled,
        objectKey: null,
        deletedAt: new Date('2026-06-20T10:05:00.000Z'),
        deletionReason: 'MANUAL',
      });

      const response = await play();

      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({
        error: 'Gone',
        message: 'This recording was deleted',
      });
    });
  });

  describe('a recording of the call itself', () => {
    beforeEach(async () => {
      findFirst.mockResolvedValue({
        ...conference,
        objectKey: recordingKey,
        providerDeletedAt: new Date('2026-03-20T10:05:00.000Z'),
      });
      await mediaStore.put({
        key: recordingKey,
        contentType: 'audio/mpeg',
        body: copiedBytes,
      });
    });

    test.each([
      { name: 'a supervisor', user: supervisor },
      { name: 'an admin', user: admin },
    ])('plays for $name', async ({ user }) => {
      await app.close();
      app = await buildApp({ user });

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(copiedBytes);
    });

    test('is refused to an agent, who may still see the call', async () => {
      const response = await play();

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'Forbidden',
        message: 'Call recordings are for supervisors and admins',
      });
    });

    test('is streamed straight through while the copy is still owed', async () => {
      await app.close();
      app = await buildApp({ user: supervisor });
      findFirst.mockResolvedValue(conference);
      await mediaStore.delete(recordingKey);
      twilioAnswers(() =>
        audio(mebibytes(2), { 'content-type': 'audio/mpeg' }),
      );

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.byteLength).toBe(2 * MEBIBYTE);
      // Streamed, so nothing was stored and nothing deleted at Twilio on
      // the way: the sweep still owes the copy.
      expect(mediaStore.keys()).toEqual([]);
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
    });
  });

  describe('from Twilio, while the copy is owed', () => {
    test('plays the voicemail of a call the agent may see', async () => {
      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(voicemailBytes);
      expect(findFirst).toHaveBeenCalledWith({
        where: {
          id: 'recording-1',
          call: { conversationUuid: 'conversation-1', ...agentScope },
        },
        select: expect.any(Object),
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
      expect(fetchMock).toHaveBeenCalledWith(`${recording}.mp3`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
        signal: expect.any(AbortSignal),
      });
    });

    test('completes the copy on the way: stores it, records it, deletes it at Twilio', async () => {
      await play();

      expect(twilioRequests()).toEqual([
        { method: 'GET', url: `${recording}.mp3` },
        { method: 'DELETE', url: `${recording}.json` },
      ]);
      expect(mediaStore.keys()).toEqual([recordingKey]);
      await expect(mediaStore.head(recordingKey)).resolves.toEqual({
        contentType: 'audio/mpeg',
        contentLength: voicemailBytes.byteLength,
      });
      expect(updateManyRecordings).toHaveBeenCalledWith({
        where: { id: 'recording-1', deletedAt: null },
        data: { objectKey: recordingKey, storedAt: expect.any(Date) },
      });
      expect(updateRecording.mock.calls).toEqual([
        [
          {
            where: { id: 'recording-1' },
            data: { providerDeletedAt: expect.any(Date) },
          },
        ],
      ]);
    });

    test('drops the copy when the recording is deleted while it is being fetched', async () => {
      // The claim is taken, and the write that records the copy finds the
      // recording deleted by an admin in the meantime.
      updateManyRecordings
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(voicemailBytes);
      expect(mediaStore.keys()).toEqual([]);
      expect(updateRecording).not.toHaveBeenCalled();
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
    });

    test('serves the audio, and copies nothing, when another copy holds the claim', async () => {
      updateManyRecordings.mockResolvedValue({ count: 0 });

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(voicemailBytes);
      expect(mediaStore.keys()).toEqual([]);
      expect(updateRecording).not.toHaveBeenCalled();
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
    });

    test('plays the voicemail, and keeps it at Twilio, when the store refuses the copy', async () => {
      const warn = vi.spyOn(app.log, 'warn');
      vi.spyOn(mediaStore, 'put').mockRejectedValue(
        new Error('bucket unavailable'),
      );

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(voicemailBytes);
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
      expect(updateRecording).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ recordingSid }),
        'Could not store the recording; playback keeps fetching it from Twilio',
      );
    });

    test('plays the voicemail, and keeps the copy, when Twilio refuses to delete it', async () => {
      const warn = vi.spyOn(app.log, 'warn');
      fetchMock.mockImplementation(async (_url, init) =>
        init?.method === 'DELETE'
          ? new Response('upstream detail', { status: 500 })
          : audio(),
      );

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(mediaStore.keys()).toEqual([recordingKey]);
      expect(updateRecording).not.toHaveBeenCalled();
      expect(updateManyRecordings).toHaveBeenCalledWith({
        where: { id: 'recording-1', deletedAt: null },
        data: { objectKey: recordingKey, storedAt: expect.any(Date) },
      });
      expect(warn).toHaveBeenCalledWith(
        { conversationUuid: 'conversation-1', recordingSid, status: 500 },
        'Twilio did not delete the recording; it stays there until a later sweep',
      );
    });

    test('lets a supervisor play the voicemail of any call', async () => {
      await app.close();
      app = await buildApp({ user: supervisor });

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(findMemberships).not.toHaveBeenCalled();
      expect(findFirst).toHaveBeenCalledWith({
        where: {
          id: 'recording-1',
          call: { conversationUuid: 'conversation-1' },
        },
        select: expect.any(Object),
      });
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
        stored: recording.replace(
          'api.twilio.com',
          'api.twilio.com.example.com',
        ),
      },
      { name: 'plain http', stored: recording.replace('https:', 'http:') },
    ])(
      'sends no request, and so no credentials, for a stored URL on $name',
      async ({ stored }) => {
        const warn = vi.spyOn(app.log, 'warn');
        findFirst.mockResolvedValue(announced(stored));

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
        announced(
          recording.replace(accountSid, 'ACcccccccccccccccccccccccccccccccc'),
        ),
      );

      const response = await play();

      expect(response.statusCode).toBe(502);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('ACcccc');
    });

    test('answers 410 once Twilio no longer has the recording', async () => {
      twilioAnswers(
        () =>
          new Response('<TwilioResponse>not found</TwilioResponse>', {
            status: 404,
            headers: { 'content-type': 'application/xml' },
          }),
      );

      const response = await play();

      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({
        error: 'Gone',
        message: 'This recording is no longer available',
      });
      expect(mediaStore.keys()).toEqual([]);
      expect(updateRecording).not.toHaveBeenCalled();
    });

    test.each([
      { name: 'refuses the credentials', status: 401 },
      { name: 'fails', status: 500 },
    ])(
      'answers 502 without the upstream body when Twilio $name',
      async ({ status }) => {
        twilioAnswers(
          () =>
            new Response('upstream detail', {
              status,
              headers: { 'content-type': 'audio/mpeg' },
            }),
        );

        const response = await play();

        expect(response.statusCode).toBe(502);
        expect(response.body).not.toContain('upstream detail');
        expect(mediaStore.keys()).toEqual([]);
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

    test('answers 502 when Twilio stops sending midway', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let pulls = 0;
      twilioAnswers(() =>
        audio(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new Uint8Array(1024));
                return;
              }
              return abortedBy(fetchMock.mock.calls[0]?.[1]?.signal);
            },
          }),
          { 'content-type': 'audio/mpeg' },
        ),
      );

      const pending = play();
      await vi.waitFor(() => expect(pulls).toBe(2));
      await vi.advanceTimersByTimeAsync(30_000);

      const response = await pending;
      expect(response.statusCode).toBe(502);
      expect(mediaStore.keys()).toEqual([]);
    });

    test('answers 502 when the download stalls before the first byte', async () => {
      twilioAnswers(() =>
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
        message: 'The recording could not be loaded',
      });
    });

    test('relays only audio', async () => {
      twilioAnswers(() =>
        audio('<html>sign in</html>', { 'content-type': 'text/html' }),
      );

      const response = await play();

      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain('sign in');
      expect(mediaStore.keys()).toEqual([]);
    });

    test('relays the WAV Twilio would send by default', async () => {
      twilioAnswers(() =>
        audio(voicemailBytes, {
          'content-type': 'audio/x-wav; charset=binary',
        }),
      );

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('audio/x-wav');
      await expect(mediaStore.head(recordingKey)).resolves.toMatchObject({
        contentType: 'audio/x-wav',
      });
    });

    test('refuses a recording that declares more than a voicemail can weigh', async () => {
      const body = mebibytes(1);
      twilioAnswers(() =>
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

    test.each([
      {
        name: 'the first piece alone',
        body: () => new Uint8Array(5 * MEBIBYTE + 1),
      },
      { name: 'an undeclared body', body: () => mebibytes(6) },
    ])('answers 502 when $name runs past the cap', async ({ body }) => {
      twilioAnswers(() => audio(body(), { 'content-type': 'audio/mpeg' }));

      const response = await play();

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'Bad Gateway',
        message: 'The recording is too large to play',
      });
      expect(mediaStore.keys()).toEqual([]);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });

    test('relays a full-length voicemail whose length Twilio did not declare', async () => {
      twilioAnswers(() =>
        audio(mebibytes(2), { 'content-type': 'audio/mpeg' }),
      );

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.byteLength).toBe(2 * MEBIBYTE);
      expect(response.headers['content-length']).toBe(String(2 * MEBIBYTE));
    });

    test('passes on the length of the audio, not of a body fetch has decoded', async () => {
      twilioAnswers(() =>
        audio(voicemailBytes, {
          'content-type': 'audio/mpeg',
          'content-encoding': 'gzip',
          'content-length': '7',
        }),
      );

      const response = await play();

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(voicemailBytes);
      expect(response.headers['content-length']).toBe(
        String(voicemailBytes.byteLength),
      );
    });
  });

  describe('deleting a recording', () => {
    beforeEach(async () => {
      await app.close();
      app = await buildApp({ user: admin });
      findFirst.mockResolvedValue(settled);
      await mediaStore.put({
        key: recordingKey,
        contentType: 'audio/mpeg',
        body: copiedBytes,
      });
    });

    test('empties the store, marks the row and writes one audit entry', async () => {
      const response = await remove();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: 'recording-1',
        deletion: { reason: 'MANUAL', at: expect.any(String) },
      });
      expect(mediaStore.keys()).toEqual([]);
      expect(updateManyRecordings).toHaveBeenCalledWith({
        where: { id: 'recording-1', deletedAt: null, objectKey: recordingKey },
        data: {
          deletedAt: expect.any(Date),
          deletionReason: 'MANUAL',
          objectKey: null,
        },
      });
      expect(createAuditEntry).toHaveBeenCalledTimes(1);
      expect(createAuditEntry).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'recording.deleted',
          entityType: 'CallRecording',
          entityId: 'recording-1',
          userId: 'user-9',
          changes: { context: 'VOICEMAIL', reason: 'MANUAL' },
        }),
      });
    });

    test('reports the sweep’s deletion, and writes no second entry, for a recording already deleted', async () => {
      findFirst.mockResolvedValue({
        ...settled,
        objectKey: null,
        deletedAt: new Date('2026-06-20T10:05:00.000Z'),
        deletionReason: 'RETENTION_POLICY',
      });

      const response = await remove();

      expect(response.statusCode).toBe(200);
      // What is stored, not what this request asked for.
      expect(response.json()).toEqual({
        id: 'recording-1',
        deletion: {
          reason: 'RETENTION_POLICY',
          at: '2026-06-20T10:05:00.000Z',
        },
      });
      expect(createAuditEntry).not.toHaveBeenCalled();
    });

    test('answers 502, and keeps the recording, when the store refuses', async () => {
      vi.spyOn(mediaStore, 'delete').mockRejectedValue(
        new Error('bucket unavailable'),
      );

      const response = await remove();

      expect(response.statusCode).toBe(502);
      expect(updateManyRecordings).not.toHaveBeenCalled();
      expect(createAuditEntry).not.toHaveBeenCalled();
    });

    test('answers 404 for a recording that does not exist', async () => {
      findFirst.mockResolvedValue(null);

      const response = await remove('recording-404');

      expect(response.statusCode).toBe(404);
      expect(mediaStore.keys()).toEqual([recordingKey]);
    });

    test.each([
      { name: 'an agent', user: agent },
      { name: 'a supervisor', user: supervisor },
    ])('is refused to $name, who may hear it', async ({ user }) => {
      await app.close();
      app = await buildApp({ user });

      const response = await remove();

      expect(response.statusCode).toBe(403);
      expect(findFirst).not.toHaveBeenCalled();
      expect(mediaStore.keys()).toEqual([recordingKey]);
    });
  });

  test('answers 404 for a recording outside the agent scope, as for one that does not exist', async () => {
    findFirst.mockResolvedValue(null);

    const response = await play();

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Recording not found',
    });
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

  test('does not read a recording to answer a HEAD', async () => {
    const response = await app.inject({
      method: 'HEAD',
      url: '/api/calls/conversation-1/recordings/recording-1',
    });

    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
