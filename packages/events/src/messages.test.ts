import { describe, expect, test } from 'vitest';
import { CHANNELS } from './channels.js';
import {
  CallEndedEventSchema,
  CallHoldEventSchema,
  CallIncomingEventSchema,
  CallRecordingReadyEventSchema,
  CHANNEL_SCHEMAS,
} from './messages.js';

describe('CHANNEL_SCHEMAS', () => {
  test('has a schema for every channel', () => {
    expect(Object.keys(CHANNEL_SCHEMAS).sort()).toEqual(
      Object.values(CHANNELS).sort(),
    );
  });
});

describe('CallIncomingEventSchema', () => {
  test('defaults the direction to inbound', () => {
    const parsed = CallIncomingEventSchema.parse({
      conversationUuid: 'conv-1',
      from: '+15555550100',
      to: '+15555550199',
      timestamp: '2026-04-21T12:00:00.000Z',
    });
    expect(parsed.direction).toBe('inbound');
  });

  test('accepts timestamps with a zone offset', () => {
    const result = CallIncomingEventSchema.safeParse({
      conversationUuid: 'conv-1',
      from: '+15555550100',
      to: '+15555550199',
      timestamp: '2026-04-21T09:00:00-03:00',
    });
    expect(result.success).toBe(true);
  });
});

describe('CallEndedEventSchema', () => {
  test('rejects unknown end statuses and negative durations', () => {
    const base = {
      conversationUuid: 'conv-1',
      timestamp: '2026-04-21T12:00:00.000Z',
    };
    expect(
      CallEndedEventSchema.safeParse({
        ...base,
        duration: 5,
        status: 'dropped',
      }).success,
    ).toBe(false);
    expect(
      CallEndedEventSchema.safeParse({
        ...base,
        duration: -1,
        status: 'completed',
      }).success,
    ).toBe(false);
  });
});

describe('CallRecordingReadyEventSchema', () => {
  test('requires a URL for the recording', () => {
    const result = CallRecordingReadyEventSchema.safeParse({
      conversationUuid: 'conv-1',
      recordingUrl: 'not a url',
      timestamp: '2026-04-21T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('CallHoldEventSchema', () => {
  test('is the shape of both the held and the resumed channel', () => {
    expect(CHANNEL_SCHEMAS[CHANNELS.CALL_HELD]).toBe(CallHoldEventSchema);
    expect(CHANNEL_SCHEMAS[CHANNELS.CALL_RESUMED]).toBe(CallHoldEventSchema);
  });

  test('needs no agent, for a resume the controller did by itself', () => {
    const base = {
      conversationUuid: 'conv-1',
      timestamp: '2026-04-21T12:00:00.000Z',
    };
    expect(CallHoldEventSchema.parse(base)).toEqual(base);
    expect(
      CallHoldEventSchema.parse({ ...base, userId: 'user-1', legUuid: 'CA1' })
        .userId,
    ).toBe('user-1');
  });
});
