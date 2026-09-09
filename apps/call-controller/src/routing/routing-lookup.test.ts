import type { CachedRouting } from '@repo/events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { RoutingLookupService } from './routing-lookup.js';

const phoneNumber = '+15555550101';
const cacheKey = 'routing:phone:+15555550101';

const routing: CachedRouting = {
  type: 'USER',
  userIds: ['user-1'],
  userId: 'user-1',
  userName: 'Alex Example',
  cachedAt: '2026-09-08T12:00:00.000Z',
};

const log = createFakeLogger();

function buildService(cache: Record<string, string> = {}) {
  const redis = { get: vi.fn(async (key: string) => cache[key] ?? null) };
  const service = new RoutingLookupService({
    redis,
    internalApi: {
      url: 'http://api.example.com',
      token: 'a-fictional-internal-token-value',
    },
    log,
  });
  return { service, redis };
}

describe('RoutingLookupService', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  test('returns the cached routing without calling the API', async () => {
    const { service } = buildService({ [cacheKey]: JSON.stringify(routing) });

    await expect(service.lookupByPhone(phoneNumber)).resolves.toEqual(routing);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('asks the API with the internal token on a cache miss', async () => {
    fetchMock.mockResolvedValue(Response.json(routing));
    const { service } = buildService();

    await expect(service.lookupByPhone(phoneNumber)).resolves.toEqual(routing);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/internal/routing/by-phone/%2B15555550101',
      expect.objectContaining({
        headers: { Authorization: 'Bearer a-fictional-internal-token-value' },
      }),
    );
  });

  test('treats an unassigned number as no routing', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const { service } = buildService();

    await expect(service.lookupByPhone(phoneNumber)).resolves.toBeNull();
  });

  test('ignores a cache entry that does not match the schema', async () => {
    fetchMock.mockResolvedValue(Response.json(routing));
    const { service } = buildService({
      [cacheKey]: JSON.stringify({ type: 'TEAM', userIds: 'user-1' }),
    });

    await expect(service.lookupByPhone(phoneNumber)).resolves.toEqual(routing);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'cache', phoneNumberLast4: '0101' }),
      'Routing entry does not match the routing schema',
    );
  });

  test('stops calling the API after repeated failures and resumes after the reset window', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { service } = buildService();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.lookupByPhone(phoneNumber)).resolves.toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);

    await expect(service.lookupByPhone(phoneNumber)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(31_000);
    fetchMock.mockResolvedValue(Response.json(routing));

    await expect(service.lookupByPhone(phoneNumber)).resolves.toEqual(routing);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });

  test('never logs the full phone number', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const { service } = buildService();

    await service.lookupByPhone(phoneNumber);

    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
      phoneNumber,
    );
  });
});
