import { describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import type { PresenceService } from './presence.service.js';
import { registerSocketHandlers } from './socket-handlers.js';
import type { TypedSocket, TypedSocketServer } from './socket-server.js';

const log = createFakeLogger();

function connect(deps: ReturnType<typeof buildDeps>) {
  let onConnection: ((socket: TypedSocket) => void) | undefined;
  const io = {
    on: vi.fn((_event: string, handler: (socket: TypedSocket) => void) => {
      onConnection = handler;
    }),
  };
  registerSocketHandlers(io as unknown as TypedSocketServer, {
    ...deps,
    authSecret: 'a-fictional-secret-that-is-long-enough',
    log,
  });

  const handlers = new Map<string, (data: unknown) => Promise<void>>();
  const socket = {
    id: 'socket-1',
    data: { userId: 'user-1' },
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (data: unknown) => Promise<void>) => {
      handlers.set(event, handler);
    }),
  };
  onConnection?.(socket as unknown as TypedSocket);

  return {
    socket,
    async send(event: string, data: unknown) {
      await handlers.get(event)?.(data);
    },
  };
}

function buildDeps() {
  return {
    presence: {
      registerSocket: vi.fn<PresenceService['registerSocket']>(
        async () => undefined,
      ),
      unregisterSocket: vi.fn<PresenceService['unregisterSocket']>(
        async () => undefined,
      ),
    },
    onCallRejected: vi.fn(
      async (_conversationUuid: string, _userId: string) => null,
    ),
  };
}

describe('registerSocketHandlers', () => {
  test('registers the authenticated user, never the one in the payload', async () => {
    const deps = buildDeps();
    const { send } = connect(deps);

    await send('register_user', {
      userId: 'someone-else',
      deviceInfo: { platform: 'web' },
    });

    expect(deps.presence.registerSocket).toHaveBeenCalledWith(
      'user-1',
      'socket-1',
      { platform: 'web' },
    );
  });

  test('reports a registration that cannot be stored', async () => {
    const deps = buildDeps();
    deps.presence.registerSocket.mockRejectedValue(new Error('redis down'));
    const { socket, send } = connect(deps);

    await send('register_user', {});

    expect(socket.emit).toHaveBeenCalledWith('error', {
      message: 'Failed to register socket',
      code: 'REGISTRATION_FAILED',
    });
  });

  test('hands a rejected call to the caller with the user who rejected it', async () => {
    const deps = buildDeps();
    const { send } = connect(deps);

    await send('call_reject', { conversationUuid: 'CAcall1' });

    expect(deps.onCallRejected).toHaveBeenCalledWith('CAcall1', 'user-1');
  });

  test('rejects a malformed call_reject payload', async () => {
    const deps = buildDeps();
    const { socket, send } = connect(deps);

    await send('call_reject', { conversation: 'CAcall1' });

    expect(deps.onCallRejected).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      message: 'Invalid call payload',
      code: 'CALL_REJECT_FAILED',
    });
  });

  test('unregisters the socket that disconnected', async () => {
    const deps = buildDeps();
    const { send } = connect(deps);

    await send('disconnect', 'transport close');

    expect(deps.presence.unregisterSocket).toHaveBeenCalledWith(
      'user-1',
      'socket-1',
    );
  });
});
