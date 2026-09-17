import type { IncomingCall } from '@repo/dto';
import { describe, expect, test, vi } from 'vitest';
import { notifyIncomingCall } from './incoming-call-notifier.js';
import type { PresenceService } from './presence.service.js';
import type { TypedSocketServer } from './socket-server.js';

const call: IncomingCall = {
  conversationUuid: 'CAcall1',
  from: '+15555550123',
  to: '+15555550100',
};

function buildFakes(online: Map<string, string[]>) {
  const emit = vi.fn();
  const to = vi.fn((_socketIds: string[]) => ({ emit }));
  return {
    deps: {
      io: { to } as unknown as Pick<TypedSocketServer, 'to'>,
      presence: {
        socketIdsOf: vi.fn<PresenceService['socketIdsOf']>(async () => online),
        addCallParticipants: vi.fn<PresenceService['addCallParticipants']>(
          async () => undefined,
        ),
      },
    },
    to,
    emit,
  };
}

describe('notifyIncomingCall', () => {
  test('offers the call to every connected softphone of each online user', async () => {
    const { deps, to, emit } = buildFakes(
      new Map([
        ['user-1', ['socket-tab-a', 'socket-tab-b']],
        ['user-3', ['socket-3']],
      ]),
    );

    const reached = await notifyIncomingCall(
      deps,
      ['user-1', 'user-2', 'user-3'],
      call,
    );

    expect(reached).toEqual(['user-1', 'user-3']);
    expect(to).toHaveBeenCalledExactlyOnceWith([
      'socket-tab-a',
      'socket-tab-b',
      'socket-3',
    ]);
    expect(emit).toHaveBeenCalledExactlyOnceWith('incoming_call', call);
  });

  test('remembers the users it reached so they hear when the call ends', async () => {
    const { deps } = buildFakes(new Map([['user-1', ['socket-1']]]));

    await notifyIncomingCall(deps, ['user-1', 'user-2'], call);

    expect(deps.presence.addCallParticipants).toHaveBeenCalledWith('CAcall1', [
      'user-1',
    ]);
  });

  test('reaches nobody when nobody is online', async () => {
    const { deps, to } = buildFakes(new Map());

    await expect(
      notifyIncomingCall(deps, ['user-1', 'user-2'], call),
    ).resolves.toEqual([]);

    expect(to).not.toHaveBeenCalled();
    expect(deps.presence.addCallParticipants).not.toHaveBeenCalled();
  });
});
