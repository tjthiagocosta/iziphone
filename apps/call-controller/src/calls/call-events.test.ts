import { describe, expect, test, vi } from 'vitest';
import { createCallEventPublisher } from './call-events.js';

describe('createCallEventPublisher', () => {
  test('stamps the event and publishes it on its channel', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:34:56.000Z'));
    const publish = vi.fn(async () => 1);
    const events = createCallEventPublisher({ publish });

    await events.callMissed({
      conversationUuid: 'CAcall1',
      from: '+15555550101',
      to: '+15555550102',
      departmentId: 'dept-1',
    });

    expect(publish).toHaveBeenCalledWith(
      'call:missed',
      JSON.stringify({
        conversationUuid: 'CAcall1',
        from: '+15555550101',
        to: '+15555550102',
        departmentId: 'dept-1',
        timestamp: '2026-09-08T12:34:56.000Z',
      }),
    );
    vi.useRealTimers();
  });

  test('publishes a hold and a resume on their own channels', async () => {
    const publish = vi.fn(async (_channel: string, _message: string) => 1);
    const events = createCallEventPublisher({ publish });
    const event = {
      conversationUuid: 'CAcall1',
      userId: 'user-1',
      legUuid: 'CAcall1',
    };

    await events.callHeld(event);
    await events.callResumed(event);

    expect(publish.mock.calls.map(([channel]) => channel)).toEqual([
      'call:held',
      'call:resumed',
    ]);
    expect(JSON.parse(String(publish.mock.calls[0]?.[1]))).toMatchObject({
      ...event,
      timestamp: expect.any(String),
    });
  });

  test('rejects an event that does not match its schema', async () => {
    const publish = vi.fn(async () => 1);
    const events = createCallEventPublisher({ publish });

    await expect(
      events.callRecordingReady({
        conversationUuid: 'CAcall1',
        recordingUrl: 'not a url',
      }),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});
