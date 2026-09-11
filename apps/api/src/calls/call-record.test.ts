import { describe, expect, test } from 'vitest';
import { type PersistedCall, toCallRecordDto } from './call-record.js';

const persisted: PersistedCall = {
  id: 'call-1',
  conversationUuid: 'conversation-1',
  callerLegUuid: 'leg-caller',
  agentLegUuid: null,
  externalLegUuid: null,
  from: '+15155550104',
  to: '+15155550101',
  status: 'completed',
  duration: 42,
  recordingUrl: null,
  transcript: null,
  direction: 'inbound',
  provider: 'TWILIO',
  userId: 'user-1',
  departmentId: null,
  user: { id: 'user-1', email: 'agent@example.com' },
  department: null,
  events: [],
  createdAt: new Date('2026-03-20T00:00:00.000Z'),
  updatedAt: new Date('2026-03-20T00:04:12.000Z'),
};

/** The phone number row for our own leg, which the service resolves. */
const line = {
  id: 'number-1',
  phoneNumber: '+15155550101',
  label: 'Support',
};

describe('toCallRecordDto', () => {
  test('names the line the call was on', () => {
    expect(toCallRecordDto(persisted, null, line).line).toEqual(line);
    expect(toCallRecordDto(persisted, null, null).line).toBeNull();
  });

  test('publishes the timestamps as ISO strings', () => {
    expect(toCallRecordDto(persisted, null, line)).toMatchObject({
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:04:12.000Z',
    });
  });

  test('publishes no field the response shape does not describe', () => {
    const extra = { ...persisted, internalNote: 'not for the client' };

    expect(toCallRecordDto(extra, null, line)).not.toHaveProperty(
      'internalNote',
    );
  });

  test('reads a direction the API never writes as outbound', () => {
    expect(
      toCallRecordDto({ ...persisted, direction: 'internal' }, null, line),
    ).toMatchObject({ direction: 'outbound' });
  });

  test('reports a voicemail from the timeline entry, not the recording', () => {
    expect(toCallRecordDto(persisted, null, line).hasVoicemail).toBe(false);
    expect(
      toCallRecordDto(
        { ...persisted, recordingUrl: 'https://example.com/a.mp3' },
        null,
        line,
      ).hasVoicemail,
    ).toBe(false);
    expect(
      toCallRecordDto({ ...persisted, events: [{ id: 'event-1' }] }, null, line)
        .hasVoicemail,
    ).toBe(true);
  });

  test('keeps a status the API does not recognise', () => {
    expect(
      toCallRecordDto({ ...persisted, status: 'queued' }, null, line),
    ).toMatchObject({
      status: 'queued',
    });
  });
});
