import { describe, expect, test, vi } from 'vitest';
import { InMemoryMediaStore } from '../media-store/index.js';
import { CallRecordingService } from './recording.service.js';

/*
 * The subscriber and route tests cover a recording from its announcement to
 * its deletion at Twilio. What they cannot reach is a recording found in a
 * later state: copied but not yet deleted at Twilio, settled, or lost.
 */

const credentials = {
  accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authToken: 'not-a-real-twilio-token',
};
const recordingSid = 'REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const providerUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Recordings/${recordingSid}`;
const key = `recordings/conv-1/${recordingSid}.mp3`;

const announced = {
  id: 'recording-1',
  context: 'VOICEMAIL' as const,
  recordingSid,
  providerUrl,
  objectKey: null,
  providerDeletedAt: null,
  deletedAt: null,
  deletionReason: null,
};

function createService(options: { credentials?: typeof credentials | null }) {
  const db = {
    call: { findFirst: vi.fn() },
    callRecording: {
      upsert: vi.fn(),
      update: vi.fn(async () => ({ id: 'recording-1' })),
      // Claiming a copy, and marking a deletion: both take the row when
      // nothing else has.
      updateMany: vi.fn(
        async (_args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => ({ count: 1 }),
      ),
      findFirst: vi.fn(),
    },
  };
  const mediaStore = new InMemoryMediaStore();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 204 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const service = new CallRecordingService(
    db as never,
    mediaStore,
    options.credentials === undefined ? credentials : options.credentials,
    log,
  );

  return { service, db, mediaStore, log, fetchMock };
}

describe('CallRecordingService.copy', () => {
  test('only deletes at Twilio a recording whose copy exists', async () => {
    const { service, db, fetchMock } = createService({});

    await service.copy({ ...announced, objectKey: key }, 'conv-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${providerUrl}.json`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(db.callRecording.update).toHaveBeenCalledWith({
      where: { id: 'recording-1' },
      data: { providerDeletedAt: expect.any(Date) },
    });
  });

  test('leaves a recording copied and deleted alone', async () => {
    const { service, db, fetchMock } = createService({});

    await service.copy(
      {
        ...announced,
        objectKey: key,
        providerDeletedAt: new Date('2026-03-20T10:05:00.000Z'),
      },
      'conv-1',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.callRecording.update).not.toHaveBeenCalled();
  });

  test('does not fetch what Twilio no longer has', async () => {
    const { service, db, fetchMock, mediaStore } = createService({});

    await service.copy(
      {
        ...announced,
        providerDeletedAt: new Date('2026-03-20T10:05:00.000Z'),
      },
      'conv-1',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaStore.keys()).toEqual([]);
    expect(db.callRecording.update).not.toHaveBeenCalled();
  });

  test('keeps the recording at Twilio when the deployment has no credentials', async () => {
    const { service, fetchMock, log, mediaStore } = createService({
      credentials: null,
    });

    await service.copy(announced, 'conv-1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaStore.keys()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      { conversationUuid: 'conv-1', recordingSid },
      'Cannot copy the recording without Twilio credentials; playback will fetch it from Twilio',
    );
  });

  test('keeps the copy when the deletion cannot be recorded', async () => {
    const { service, db, log } = createService({});
    db.callRecording.update.mockRejectedValueOnce(new Error('db down'));

    const result = await service.copy(
      { ...announced, objectKey: key },
      'conv-1',
    );

    expect(result).toEqual({ copied: false, providerDeleted: false });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationUuid: 'conv-1', recordingSid }),
      'Deleted the recording at Twilio but could not record it',
    );
  });

  test('claims the copy before fetching, and takes over one gone stale', async () => {
    const { service, db } = createService({});

    await service.copy(announced, 'conv-1');

    expect(db.callRecording.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'recording-1',
        objectKey: null,
        deletedAt: null,
        OR: [
          { copyStartedAt: null },
          { copyStartedAt: { lt: expect.any(Date) } },
        ],
      },
      data: { copyStartedAt: expect.any(Date) },
    });
  });

  test('leaves a recording another copy has claimed to that copy', async () => {
    const { service, db, fetchMock, mediaStore, log } = createService({});
    db.callRecording.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.copy(announced, 'conv-1');

    expect(result).toEqual({ copied: false, providerDeleted: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mediaStore.keys()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      { conversationUuid: 'conv-1', recordingSid },
      'This recording is being copied elsewhere or is already deleted; leaving it alone',
    );
  });

  test('copies once when the subscriber and a sweep reach for it together', async () => {
    const { service, db, mediaStore, fetchMock } = createService({});
    let claimTaken = false;
    db.callRecording.updateMany.mockImplementation(async (args) => {
      // Only the claim is contested; the release is not a claim.
      if (args.data.copyStartedAt instanceof Date) {
        if (claimTaken) return { count: 0 };
        claimTaken = true;
        return { count: 1 };
      }
      return { count: 1 };
    });
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(Buffer.from('fictional mp3 bytes'), {
            status: 200,
            headers: { 'content-type': 'audio/mpeg' },
          }),
    );

    const results = await Promise.all([
      service.copy(announced, 'conv-1'),
      service.copy(announced, 'conv-1'),
    ]);

    expect(results.filter((result) => result.copied)).toHaveLength(1);
    expect(mediaStore.keys()).toEqual([key]);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method !== 'DELETE'),
    ).toHaveLength(1);
  });

  test('hands the claim back when the copy got nowhere', async () => {
    const { service, db, fetchMock } = createService({});
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await service.copy(announced, 'conv-1');

    expect(db.callRecording.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'recording-1', copyStartedAt: expect.any(Date) },
      data: { copyStartedAt: null },
    });
  });
});

describe('CallRecordingService.deleteAudio', () => {
  async function stored(mediaStore: InMemoryMediaStore) {
    await mediaStore.put({
      key,
      contentType: 'audio/mpeg',
      body: Buffer.from('fictional mp3 bytes'),
    });
  }

  test('empties the store, marks the row and reports the deletion', async () => {
    const { service, db, mediaStore, log } = createService({});
    await stored(mediaStore);

    const result = await service.deleteAudio(
      {
        ...announced,
        objectKey: key,
        providerDeletedAt: new Date('2026-03-20T10:05:00.000Z'),
      },
      'conv-1',
      'RETENTION_POLICY',
    );

    expect(result).toEqual({
      outcome: 'deleted',
      providerDeleted: false,
      deletion: { reason: 'RETENTION_POLICY', at: expect.any(String) },
    });
    expect(mediaStore.keys()).toEqual([]);
    expect(db.callRecording.updateMany).toHaveBeenCalledWith({
      where: { id: 'recording-1', deletedAt: null, objectKey: key },
      data: {
        deletedAt: expect.any(Date),
        deletionReason: 'RETENTION_POLICY',
        objectKey: null,
      },
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ recordingSid, reason: 'RETENTION_POLICY' }),
      'Deleted a recording',
    );
  });

  test('deletes at Twilio a recording deleted before it was ever copied', async () => {
    const { service, fetchMock } = createService({});

    const result = await service.deleteAudio(announced, 'conv-1', 'MANUAL');

    expect(result).toEqual({
      outcome: 'deleted',
      providerDeleted: true,
      deletion: { reason: 'MANUAL', at: expect.any(String) },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${providerUrl}.json`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  test('keeps the recording playable when the store refuses', async () => {
    const { service, db, mediaStore, log } = createService({});
    await stored(mediaStore);
    vi.spyOn(mediaStore, 'delete').mockRejectedValue(new Error('bucket down'));

    const result = await service.deleteAudio(
      { ...announced, objectKey: key },
      'conv-1',
      'RETENTION_POLICY',
    );

    expect(result).toEqual({ outcome: 'failed' });
    expect(db.callRecording.updateMany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recordingSid }),
      'Could not delete the recording from the store; it stays until a later attempt',
    );
  });

  test('changes nothing for a recording already deleted', async () => {
    const { service, db, fetchMock } = createService({});

    const result = await service.deleteAudio(
      {
        ...announced,
        deletedAt: new Date('2026-03-20T10:05:00.000Z'),
        deletionReason: 'MANUAL',
      },
      'conv-1',
      'RETENTION_POLICY',
    );

    // The stored deletion is reported, not the one this call asked for.
    expect(result).toEqual({
      outcome: 'already-deleted',
      deletion: { reason: 'MANUAL', at: '2026-03-20T10:05:00.000Z' },
    });
    expect(db.callRecording.updateMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('empties the store when a copy landed after the row was read', async () => {
    const { service, db, mediaStore } = createService({});
    await stored(mediaStore);
    // The sweep read the row while the copy was still owed; the copy completed
    // before the deletion reached the database.
    db.callRecording.updateMany.mockImplementation(async (args) => ({
      count: args.where.objectKey === key ? 1 : 0,
    }));
    // The copy also deleted the recording at Twilio on its way.
    db.callRecording.findFirst.mockResolvedValue({
      ...announced,
      objectKey: key,
      providerDeletedAt: new Date('2026-03-20T10:05:00.000Z'),
    });

    const result = await service.deleteAudio(
      { ...announced, providerDeletedAt: null },
      'conv-1',
      'RETENTION_POLICY',
    );

    expect(result).toEqual({
      outcome: 'deleted',
      providerDeleted: false,
      deletion: { reason: 'RETENTION_POLICY', at: expect.any(String) },
    });
    expect(mediaStore.keys()).toEqual([]);
  });

  test('gives up when a copy keeps landing under the deletion', async () => {
    const { service, db, mediaStore, log } = createService({});
    await stored(mediaStore);
    db.callRecording.updateMany.mockResolvedValue({ count: 0 });
    db.callRecording.findFirst.mockResolvedValue({
      ...announced,
      objectKey: key,
    });

    const result = await service.deleteAudio(
      { ...announced, objectKey: key, providerDeletedAt: new Date() },
      'conv-1',
      'RETENTION_POLICY',
    );

    expect(result).toEqual({ outcome: 'failed' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recordingSid }),
      'A copy kept landing while the recording was being deleted; it stays until a later attempt',
    );
  });

  test('reports the deletion the sweep made, not the one that was asked for', async () => {
    const { service, db, mediaStore } = createService({});
    await stored(mediaStore);
    db.callRecording.updateMany.mockResolvedValue({ count: 0 });
    // The retention sweep marked the row between the read and this write.
    db.callRecording.findFirst.mockResolvedValue({
      ...announced,
      deletedAt: new Date('2026-03-20T10:05:00.000Z'),
      deletionReason: 'RETENTION_POLICY',
    });

    const result = await service.deleteAudio(
      { ...announced, objectKey: key, providerDeletedAt: new Date() },
      'conv-1',
      'MANUAL',
    );

    expect(result).toEqual({
      outcome: 'already-deleted',
      deletion: { reason: 'RETENTION_POLICY', at: '2026-03-20T10:05:00.000Z' },
    });
  });

  test('reports no deletion when the row itself is gone', async () => {
    const { service, db, mediaStore } = createService({});
    await stored(mediaStore);
    db.callRecording.updateMany.mockResolvedValue({ count: 0 });
    db.callRecording.findFirst.mockResolvedValue(null);

    const result = await service.deleteAudio(
      { ...announced, objectKey: key, providerDeletedAt: new Date() },
      'conv-1',
      'MANUAL',
    );

    expect(result).toEqual({ outcome: 'already-deleted', deletion: null });
  });
});
