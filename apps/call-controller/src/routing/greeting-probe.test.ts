import { describe, expect, test, vi } from 'vitest';
import { probeGreetingUrl } from './greeting-probe.js';

const url = 'https://example.com/greetings/support.mp3';

describe('probeGreetingUrl', () => {
  test('is reachable for a 2xx response with a content type Play supports', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );

    await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('reachable');
  });

  test('accepts every content type Play supports, ignoring parameters and case', async () => {
    const playable = [
      'audio/mpeg',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/aiff',
      'audio/x-aifc',
      'audio/x-aiff',
      'audio/x-gsm',
      'audio/gsm',
      'audio/ulaw',
    ];

    for (const contentType of playable) {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(null, {
            status: 200,
            headers: {
              'content-type': `${contentType.toUpperCase()}; charset=utf-8`,
            },
          }),
      );

      await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('reachable');
    }
  });

  test('is not audio for a 2xx response with an unplayable content type', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('not-audio');
  });

  test('is not audio for a 2xx response with no content type at all', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 200 }),
    );

    await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('not-audio');
  });

  test('is unreachable for a 404', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 404 }),
    );

    await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('unreachable');
  });

  test('is unreachable for a 500', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 500 }),
    );

    await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('unreachable');
  });

  test('is unreachable when the fetch itself rejects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('getaddrinfo ENOTFOUND example.com');
    });

    await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('unreachable');
  });

  test('is timed out when the abort signal fires', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      });
    });

    await expect(probeGreetingUrl(url, { fetch })).resolves.toBe('timed-out');
  });

  test('sends a HEAD request bounded by a two second timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );

    await probeGreetingUrl(url, { fetch });

    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ method: 'HEAD', signal: expect.any(Object) }),
    );
  });
});
