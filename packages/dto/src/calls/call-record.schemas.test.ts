import { describe, expect, test } from 'vitest';
import {
  CallRecordSchema,
  RecordingDeletedResponseSchema,
} from './call.schemas.js';

const record = {
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
  userId: null,
  departmentId: 'dept-1',
  user: null,
  department: { id: 'dept-1', name: 'Support' },
  contact: null,
  line: null,
  hasVoicemail: true,
  recordings: [
    {
      id: 'recording-1',
      context: 'VOICEMAIL',
      duration: 21,
      deletion: null,
      createdAt: '2026-03-20T00:04:12.000Z',
    },
  ],
  createdAt: '2026-03-20T00:00:00.000Z',
  updatedAt: '2026-03-20T00:04:12.000Z',
};

describe('CallRecordSchema', () => {
  test('describes a call without a recording URL', () => {
    expect(CallRecordSchema.parse(record)).toEqual(record);
  });

  test('says what became of a recording that was deleted', () => {
    const parsed = CallRecordSchema.parse({
      ...record,
      recordings: [
        {
          ...record.recordings[0],
          deletion: {
            reason: 'RETENTION_POLICY',
            at: '2026-06-20T00:00:00.000Z',
          },
        },
      ],
    });

    expect(parsed.recordings[0]?.deletion).toEqual({
      reason: 'RETENTION_POLICY',
      at: '2026-06-20T00:00:00.000Z',
    });
  });

  test('refuses a deletion reason nobody could have written', () => {
    expect(
      CallRecordSchema.safeParse({
        ...record,
        recordings: [
          {
            ...record.recordings[0],
            deletion: { reason: 'EXPIRED', at: '2026-06-20T00:00:00.000Z' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('drops a recording URL an older API still sends', () => {
    const parsed = CallRecordSchema.parse({
      ...record,
      recordingUrl:
        'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Recordings/REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(parsed).not.toHaveProperty('recordingUrl');
    expect(parsed.hasVoicemail).toBe(true);
  });
});

describe('RecordingDeletedResponseSchema', () => {
  test('describes the deletion a delete answered with', () => {
    const reply = {
      id: 'recording-1',
      deletion: { reason: 'MANUAL', at: '2026-06-20T00:00:00.000Z' },
    };

    expect(RecordingDeletedResponseSchema.parse(reply)).toEqual(reply);
  });

  test('has no shape for a recording whose audio is still there', () => {
    expect(
      RecordingDeletedResponseSchema.safeParse({
        id: 'recording-1',
        deletion: null,
      }).success,
    ).toBe(false);
  });
});
