import { describe, expect, test } from 'vitest';
import { CallRecordSchema } from './call.schemas.js';

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
  createdAt: '2026-03-20T00:00:00.000Z',
  updatedAt: '2026-03-20T00:04:12.000Z',
};

describe('CallRecordSchema', () => {
  test('describes a call without a recording URL', () => {
    expect(CallRecordSchema.parse(record)).toEqual(record);
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
