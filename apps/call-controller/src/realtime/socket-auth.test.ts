import { signJWT } from '@repo/events';
import { describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import {
  createSocketAuthMiddleware,
  registerTokenRefresh,
} from './socket-auth.js';
import type { TypedSocket } from './socket-server.js';

const authSecret = 'a-fictional-secret-that-is-long-enough';
const log = createFakeLogger();

function buildFakeSocket(token: unknown) {
  const handlers = new Map<string, (data: unknown) => Promise<void>>();
  const socket = {
    handshake: { auth: { token } },
    data: {},
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (data: unknown) => Promise<void>) => {
      handlers.set(event, handler);
    }),
  };
  return { socket: socket as unknown as TypedSocket, raw: socket, handlers };
}

async function runMiddleware(token: unknown) {
  const fake = buildFakeSocket(token);
  const error = await new Promise<Error | undefined>((resolve) => {
    createSocketAuthMiddleware(authSecret, log)(fake.socket, resolve);
  });
  return { ...fake, error };
}

describe('createSocketAuthMiddleware', () => {
  test('accepts a token signed with the shared secret', async () => {
    const token = await signJWT(
      { sub: 'user-1', email: 'agent@example.com', role: 'AGENT' },
      authSecret,
    );

    const { error, raw } = await runMiddleware(token);

    expect(error).toBeUndefined();
    expect(raw.data).toEqual({
      userId: 'user-1',
      email: 'agent@example.com',
      role: 'AGENT',
      connectedAt: expect.any(String),
    });
  });

  test('rejects a missing token', async () => {
    const { error } = await runMiddleware(undefined);

    expect(error?.message).toBe('Authentication failed: token required');
  });

  test('rejects a token signed with another secret', async () => {
    const token = await signJWT(
      { sub: 'user-1', email: 'agent@example.com', role: 'AGENT' },
      'a-different-secret-that-is-long-enough',
    );

    const { error, raw } = await runMiddleware(token);

    expect(error?.message).toBe('Authentication failed: invalid token');
    expect(raw.data).toEqual({});
  });
});

describe('registerTokenRefresh', () => {
  test('swaps in the claims of a valid replacement token', async () => {
    const { socket, raw, handlers } = buildFakeSocket('ignored');
    registerTokenRefresh(socket, authSecret);
    const token = await signJWT(
      { sub: 'user-2', email: 'other@example.com', role: 'SUPERVISOR' },
      authSecret,
    );

    await handlers.get('auth:refresh')?.({ token });

    expect(raw.data).toEqual({
      userId: 'user-2',
      email: 'other@example.com',
      role: 'SUPERVISOR',
    });
    expect(raw.emit).toHaveBeenCalledWith('auth:refreshed', { success: true });
  });

  test('reports an invalid replacement token without touching the session', async () => {
    const { socket, raw, handlers } = buildFakeSocket('ignored');
    registerTokenRefresh(socket, authSecret);

    await handlers.get('auth:refresh')?.({ token: 'not-a-jwt' });

    expect(raw.data).toEqual({});
    expect(raw.emit).toHaveBeenCalledWith('auth:refreshed', {
      success: false,
      error: 'Invalid token',
    });
  });
});
