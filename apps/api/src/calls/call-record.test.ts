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
  transcript: null,
  direction: 'inbound',
  provider: 'TWILIO',
  userId: 'user-1',
  departmentId: null,
  user: { id: 'user-1', email: 'agent@example.com' },
  department: null,
  events: [],
  recordings: [],
  createdAt: new Date('2026-03-20T00:00:00.000Z'),
  updatedAt: new Date('2026-03-20T00:04:12.000Z'),
};

/**
 * The row as Prisma returns it once Twilio has recorded the call: the column
 * is still read from the database, although the mapper has no use for it.
 */
const recorded = {
  ...persisted,
  recordingUrl:
    'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Recordings/REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const voicemail = {
  id: 'recording-1',
  context: 'VOICEMAIL' as const,
  duration: 12,
  deletedAt: null,
  deletionReason: null,
  createdAt: new Date('2026-03-20T00:05:00.000Z'),
};

const conference = {
  ...voicemail,
  id: 'recording-2',
  context: 'CONFERENCE' as const,
  duration: 42,
};

/** The phone number row for our own leg, which the service resolves. */
const line = {
  id: 'number-1',
  phoneNumber: '+15155550101',
  label: 'Support',
};

describe('toCallRecordDto', () => {
  test('names the line the call was on', () => {
    expect(toCallRecordDto(persisted, null, line, 'ADMIN').line).toEqual(line);
    expect(toCallRecordDto(persisted, null, null, 'ADMIN').line).toBeNull();
  });

  test('publishes the timestamps as ISO strings', () => {
    expect(toCallRecordDto(persisted, null, line, 'ADMIN')).toMatchObject({
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:04:12.000Z',
    });
  });

  test('publishes no field the response shape does not describe', () => {
    const extra = { ...persisted, internalNote: 'not for the client' };

    expect(toCallRecordDto(extra, null, line, 'ADMIN')).not.toHaveProperty(
      'internalNote',
    );
  });

  test('reads a direction the API never writes as outbound', () => {
    expect(
      toCallRecordDto(
        { ...persisted, direction: 'internal' },
        null,
        line,
        'ADMIN',
      ),
    ).toMatchObject({ direction: 'outbound' });
  });

  test('never publishes the recording URL the row holds', () => {
    expect(toCallRecordDto(recorded, null, line, 'ADMIN')).not.toHaveProperty(
      'recordingUrl',
    );
  });

  test('reports a voicemail from the timeline entry, not the recording', () => {
    expect(toCallRecordDto(persisted, null, line, 'ADMIN').hasVoicemail).toBe(
      false,
    );
    expect(toCallRecordDto(recorded, null, line, 'ADMIN').hasVoicemail).toBe(
      false,
    );
    expect(
      toCallRecordDto(
        { ...persisted, events: [{ id: 'event-1' }] },
        null,
        line,
        'ADMIN',
      ).hasVoicemail,
    ).toBe(true);
  });

  test('keeps a status the API does not recognise', () => {
    expect(
      toCallRecordDto({ ...persisted, status: 'queued' }, null, line, 'ADMIN'),
    ).toMatchObject({
      status: 'queued',
    });
  });
});

describe('the recordings a call publishes', () => {
  const call = { ...persisted, recordings: [voicemail, conference] };

  test('tells an agent about the voicemail and not about the conference', () => {
    const record = toCallRecordDto(call, null, line, 'AGENT');

    expect(record.recordings.map((recording) => recording.id)).toEqual([
      'recording-1',
    ]);
  });

  test('tells the roles that may listen about both', () => {
    for (const role of ['SUPERVISOR', 'ADMIN'] as const) {
      const record = toCallRecordDto(call, null, line, role);

      expect(record.recordings.map((recording) => recording.id)).toEqual([
        'recording-1',
        'recording-2',
      ]);
    }
  });

  test('publishes a deletion with the reason the row holds', () => {
    const deleted = {
      ...voicemail,
      deletedAt: new Date('2026-04-01T09:30:00.000Z'),
      deletionReason: 'RETENTION_POLICY' as const,
    };

    expect(
      toCallRecordDto(
        { ...persisted, recordings: [deleted] },
        null,
        line,
        'AGENT',
      ).recordings[0]?.deletion,
    ).toEqual({
      reason: 'RETENTION_POLICY',
      at: '2026-04-01T09:30:00.000Z',
    });
  });

  test('reads a deletion recorded without a reason as a manual one', () => {
    const deleted = {
      ...voicemail,
      deletedAt: new Date('2026-04-01T09:30:00.000Z'),
    };

    expect(
      toCallRecordDto(
        { ...persisted, recordings: [deleted] },
        null,
        line,
        'AGENT',
      ).recordings[0]?.deletion?.reason,
    ).toBe('MANUAL');
  });
});
