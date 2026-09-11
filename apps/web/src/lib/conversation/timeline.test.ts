import type { CallRecord, Message } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import { buildTimeline, timelineFloor } from './timeline';

const now = new Date('2026-03-20T15:00:00');

function message(id: string, createdAt: string): Message {
  return {
    id,
    conversationId: 'conversation-a',
    direction: 'INBOUND',
    channel: 'SMS',
    status: 'DELIVERED',
    body: 'Hey',
    from: '+15155550105',
    to: '+15155550101',
    failureCode: null,
    failureReason: null,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    createdAt,
    attachments: [],
  };
}

function call(id: string, createdAt: string): CallRecord {
  return {
    id,
    conversationUuid: `conversation-${id}`,
    callerLegUuid: null,
    agentLegUuid: null,
    externalLegUuid: null,
    from: '+15155550105',
    to: '+15155550101',
    status: 'completed',
    duration: 42,
    recordingUrl: null,
    transcript: null,
    direction: 'inbound',
    provider: 'TWILIO',
    userId: null,
    departmentId: null,
    user: null,
    department: null,
    contact: null,
    line: null,
    hasVoicemail: false,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('buildTimeline', () => {
  test('interleaves calls and messages in the order they happened', () => {
    const days = buildTimeline(
      [
        message('m1', '2026-03-20T09:00:00'),
        message('m2', '2026-03-20T11:00:00'),
      ],
      [call('c1', '2026-03-20T10:00:00')],
      now,
    );

    expect(days).toHaveLength(1);
    expect(days[0]?.entries.map((entry) => entry.key)).toEqual([
      'message:m1',
      'call:c1',
      'message:m2',
    ]);
  });

  test('reads oldest first, the way a thread is scrolled', () => {
    const days = buildTimeline(
      [
        message('m1', '2026-03-18T09:00:00'),
        message('m2', '2026-03-20T09:00:00'),
      ],
      [],
      now,
    );

    expect(days.map((day) => day.label)).toEqual(['Wednesday', 'Today']);
  });

  test('groups by the calendar day, not by elapsed hours', () => {
    const days = buildTimeline(
      [
        message('m1', '2026-03-19T23:40:00'),
        message('m2', '2026-03-20T00:10:00'),
      ],
      [],
      now,
    );

    expect(days.map((day) => day.label)).toEqual(['Yesterday', 'Today']);
  });

  test('leaves out an entry whose timestamp is not a time', () => {
    expect(buildTimeline([message('m1', 'not a date')], [], now)).toEqual([]);
  });

  test('keeps a stable order for two things recorded at the same instant', () => {
    const days = buildTimeline(
      [message('m2', '2026-03-20T09:00:00')],
      [call('c1', '2026-03-20T09:00:00')],
      now,
    );

    expect(days[0]?.entries.map((entry) => entry.key)).toEqual([
      'call:c1',
      'message:m2',
    ]);
  });

  test('prepending older messages does not reorder the newer ones', () => {
    const newer = [message('m3', '2026-03-20T09:00:00')];
    const older = [message('m1', '2026-03-18T09:00:00')];

    const first = buildTimeline(newer, [], now);
    const extended = buildTimeline([...older, ...newer], [], now);

    expect(extended[extended.length - 1]?.entries).toEqual(first[0]?.entries);
  });
});

describe('timelineFloor', () => {
  test('holds back a day whose calls have not been fetched yet', () => {
    const messages = [message('m1', '2026-03-18T09:00:00')];
    const calls = [call('c1', '2026-03-20T09:00:00')];
    const floor = timelineFloor(
      { oldest: Date.parse('2026-03-18T09:00:00'), exhausted: true },
      { oldest: Date.parse('2026-03-20T09:00:00'), exhausted: false },
    );

    expect(
      buildTimeline(messages, calls, now, floor).map((day) => day.label),
    ).toEqual(['Today']);
  });

  test('shows everything once both histories are fully loaded', () => {
    const messages = [message('m1', '2026-03-18T09:00:00')];
    const calls = [call('c1', '2026-03-20T09:00:00')];
    const floor = timelineFloor(
      { oldest: Date.parse('2026-03-18T09:00:00'), exhausted: true },
      { oldest: Date.parse('2026-03-20T09:00:00'), exhausted: true },
    );

    expect(buildTimeline(messages, calls, now, floor)).toHaveLength(2);
  });
});
