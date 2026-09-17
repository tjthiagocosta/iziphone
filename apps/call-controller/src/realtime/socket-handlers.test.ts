import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import {
  type PresenceService,
  SOCKET_HEARTBEAT_MS,
} from './presence.service.js';
import { registerSocketHandlers } from './socket-handlers.js';
import type { TypedSocket, TypedSocketServer } from './socket-server.js';

const log = createFakeLogger();

/** The handlers on a server nobody has connected to yet. */
function start(deps: ReturnType<typeof buildDeps>) {
  let onConnection: ((socket: TypedSocket) => void) | undefined;
  const io = {
    on: vi.fn((_event: string, handler: (socket: TypedSocket) => void) => {
      onConnection = handler;
    }),
  };
  registerSocketHandlers(io as unknown as TypedSocketServer, {
    ...deps,
    redis: deps.redis as unknown as Pick<Redis, 'on'>,
    authSecret: 'a-fictional-secret-that-is-long-enough',
    log,
  });

  return {
    open(socketId: string) {
      const handlers = new Map<string, (data: unknown) => Promise<void>>();
      const socket = {
        id: socketId,
        data: { userId: 'user-1' },
        emit: vi.fn(),
        on: vi.fn(
          (event: string, handler: (data: unknown) => Promise<void>) => {
            handlers.set(event, handler);
          },
        ),
      };
      onConnection?.(socket as unknown as TypedSocket);

      return {
        socket,
        async send(event: string, data: unknown) {
          await handlers.get(event)?.(data);
        },
      };
    },
  };
}

function connect(deps: ReturnType<typeof buildDeps>) {
  return start(deps).open('socket-1');
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
    // Stands in for the ioredis client; only its `ready` event matters here.
    redis: new EventEmitter(),
    onCallRejected: vi.fn(
      async (_conversationUuid: string, _userId: string) => null,
    ),
  };
}

describe('registerSocketHandlers', () => {
  // Every connection starts a heartbeat; on fake timers none outlives its test.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    );
  });

  test('registers the socket again on every heartbeat while it stays connected', async () => {
    const deps = buildDeps();
    const { send } = connect(deps);
    await send('register_user', {});

    await vi.advanceTimersByTimeAsync(3 * SOCKET_HEARTBEAT_MS);

    expect(deps.presence.registerSocket).toHaveBeenCalledTimes(4);
    expect(deps.presence.registerSocket).toHaveBeenLastCalledWith(
      'user-1',
      'socket-1',
    );
  });

  test('stops registering the socket once it disconnects', async () => {
    const deps = buildDeps();
    const { send } = connect(deps);
    await send('register_user', {});
    await vi.advanceTimersByTimeAsync(SOCKET_HEARTBEAT_MS);

    await send('disconnect', 'transport close');
    await vi.advanceTimersByTimeAsync(10 * SOCKET_HEARTBEAT_MS);

    expect(deps.presence.registerSocket).toHaveBeenCalledTimes(2);
  });

  test('never registers a socket that did not ask for calls', async () => {
    const deps = buildDeps();
    connect(deps);

    await vi.advanceTimersByTimeAsync(3 * SOCKET_HEARTBEAT_MS);

    expect(deps.presence.registerSocket).not.toHaveBeenCalled();
  });

  test('a registration that could not be stored is made up for by the next heartbeat', async () => {
    const deps = buildDeps();
    deps.presence.registerSocket.mockRejectedValueOnce(new Error('redis down'));
    const { send } = connect(deps);
    await send('register_user', {});

    await vi.advanceTimersByTimeAsync(SOCKET_HEARTBEAT_MS);

    expect(deps.presence.registerSocket).toHaveBeenCalledTimes(2);
    await expect(
      deps.presence.registerSocket.mock.results[1]?.value,
    ).resolves.toBeUndefined();
  });

  test('keeps trying through a Redis outage, and says so once per outage rather than on every heartbeat', async () => {
    const deps = buildDeps();
    const { send } = connect(deps);
    await send('register_user', {});

    deps.presence.registerSocket.mockRejectedValue(new Error('redis down'));
    await vi.advanceTimersByTimeAsync(3 * SOCKET_HEARTBEAT_MS);
    expect(deps.presence.registerSocket).toHaveBeenCalledTimes(4);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to refresh socket registration',
    );

    deps.presence.registerSocket.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(SOCKET_HEARTBEAT_MS);
    deps.presence.registerSocket.mockRejectedValue(new Error('redis down'));
    await vi.advanceTimersByTimeAsync(2 * SOCKET_HEARTBEAT_MS);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  test('registers every connected socket again as soon as Redis is back, without waiting for a heartbeat', async () => {
    const deps = buildDeps();
    const server = start(deps);
    const tabA = server.open('socket-tab-a');
    const tabB = server.open('socket-tab-b');
    const neverAskedForCalls = server.open('socket-idle');
    await tabA.send('register_user', {});
    await tabB.send('register_user', {});
    await tabB.send('disconnect', 'transport close');
    deps.presence.registerSocket.mockClear();

    deps.redis.emit('ready');
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.presence.registerSocket.mock.calls).toEqual([
      ['user-1', 'socket-tab-a'],
    ]);
    await neverAskedForCalls.send('disconnect', 'transport close');
  });

  test('a registration that lands in Redis but is reported as failed is still undone once the socket has closed', async () => {
    const deps = buildDeps();
    const registered = new Set<string>();
    let loseTheReply = (): void => undefined;
    deps.presence.registerSocket.mockImplementation(
      (_userId, socketId) =>
        new Promise((_resolve, reject) => {
          loseTheReply = () => {
            registered.add(socketId);
            reject(new Error('connection lost'));
          };
        }),
    );
    deps.presence.unregisterSocket.mockImplementation(
      async (_userId, socketId) => {
        registered.delete(socketId);
      },
    );
    const { send } = connect(deps);

    const registering = send('register_user', {});
    await send('disconnect', 'transport close');
    loseTheReply();
    await registering;

    expect(registered).toEqual(new Set());
  });

  test('a registration still being stored when the socket closes does not leave it registered', async () => {
    const deps = buildDeps();
    const registered = new Set<string>();
    let finishRegistering = (): void => undefined;
    deps.presence.registerSocket.mockImplementation(
      (_userId, socketId) =>
        new Promise((resolve) => {
          finishRegistering = () => {
            registered.add(socketId);
            resolve();
          };
        }),
    );
    deps.presence.unregisterSocket.mockImplementation(
      async (_userId, socketId) => {
        registered.delete(socketId);
      },
    );
    const { send } = connect(deps);

    const registering = send('register_user', {});
    await send('disconnect', 'transport close');
    finishRegistering();
    await registering;

    expect(registered).toEqual(new Set());
  });

  test('a clean-up that fails after the socket closed does not hide why the registration failed', async () => {
    const deps = buildDeps();
    let failRegistering = (): void => undefined;
    deps.presence.registerSocket.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failRegistering = () => reject(new Error('registration lost'));
        }),
    );
    deps.presence.unregisterSocket.mockRejectedValue(new Error('redis down'));
    const { send } = connect(deps);

    const registering = send('register_user', {});
    await send('disconnect', 'transport close');
    failRegistering();
    await registering;

    expect(log.error).toHaveBeenCalledWith(
      { err: new Error('registration lost') },
      'Failed to register socket',
    );
    expect(log.error).toHaveBeenCalledWith(
      { err: new Error('redis down') },
      'Failed to unregister socket',
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
