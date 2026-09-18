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
};

function createService(options: { credentials?: typeof credentials | null }) {
  const db = {
    call: { findFirst: vi.fn() },
    callRecording: {
      upsert: vi.fn(),
      update: vi.fn(async () => ({ id: 'recording-1' })),
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

    await service.copy({ ...announced, objectKey: key }, 'conv-1');

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationUuid: 'conv-1', recordingSid }),
      'Deleted the recording at Twilio but could not record it',
    );
  });
});
