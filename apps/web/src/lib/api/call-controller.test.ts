import { AVAILABILITY_LOOKUP_MAX_USERS } from '@repo/dto';
import { describe, expect, test, vi } from 'vitest';
import {
  fetchAvailability,
  fetchOwnAvailability,
  requestDoNotDisturb,
} from './call-controller';

function stubFetch(answer: (url: URL) => unknown) {
  const fetchMock = vi.fn(async (input: string) => {
    return new Response(JSON.stringify(answer(new URL(input))), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const idsIn = (url: URL) => url.searchParams.get('userIds')?.split(',') ?? [];

describe('fetchAvailability', () => {
  test('asks about every teammate, in lists the controller accepts', async () => {
    const userIds = Array.from(
      { length: AVAILABILITY_LOOKUP_MAX_USERS + 3 },
      (_, i) => `user-${i}`,
    );
    const fetchMock = stubFetch((url) => ({
      users: idsIn(url).map((userId) => ({
        userId,
        state: 'available',
        revision: 1,
      })),
    }));

    const users = await fetchAvailability('realtime-token', userIds);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const asked = fetchMock.mock.calls.map(([url]) => idsIn(new URL(url)));
    expect(asked.map((ids) => ids.length)).toEqual([
      AVAILABILITY_LOOKUP_MAX_USERS,
      3,
    ]);
    expect(users.map((user) => user.userId)).toEqual(userIds);
  });

  test('asks nothing about nobody', async () => {
    const fetchMock = stubFetch(() => ({ users: [] }));

    await expect(fetchAvailability('realtime-token', [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('refuses an answer that is not availability', async () => {
    stubFetch(() => ({ users: [{ userId: 'user-1', state: 'away' }] }));

    await expect(
      fetchAvailability('realtime-token', ['user-1']),
    ).rejects.toThrow();
  });
});

describe('own availability', () => {
  const snapshot = {
    availability: { userId: 'user-1', state: 'dnd', revision: 4 },
    doNotDisturb: true,
  };

  test('reads it with the realtime token', async () => {
    const fetchMock = stubFetch(() => snapshot);

    await expect(fetchOwnAvailability('realtime-token')).resolves.toEqual(
      snapshot,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new URL(url).pathname).toBe('/api/voice/availability/me');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer realtime-token',
    );
  });

  test('switches do not disturb and answers with where the user stands now', async () => {
    const fetchMock = stubFetch(() => snapshot);

    await expect(requestDoNotDisturb('realtime-token', true)).resolves.toEqual(
      snapshot,
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new URL(url).pathname).toBe(
      '/api/voice/availability/me/do-not-disturb',
    );
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ doNotDisturb: true });
  });
});
