import { describe, expect, test, vi } from 'vitest';
import {
  ApiError,
  onSessionExpired,
  requestApi,
  requestApiBlob,
  requestCallController,
  withQuery,
} from './client';

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const UserSchema = {
  parse(data: unknown) {
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { id?: unknown }).id === 'string'
    ) {
      return data as { id: string };
    }
    throw new Error('id is required');
  },
};

describe('withQuery', () => {
  test('keeps only values that carry information', () => {
    expect(
      withQuery('/api/admin/users', {
        page: 2,
        limit: undefined,
        search: '',
        role: 'ADMIN',
        includeDeleted: false,
        deletedOnly: true,
        cursor: null,
      }),
    ).toBe('/api/admin/users?page=2&role=ADMIN&deletedOnly=true');
  });

  test('returns the bare path when nothing is set', () => {
    expect(withQuery('/api/user/departments', { search: undefined })).toBe(
      '/api/user/departments',
    );
  });
});

describe('requestApi', () => {
  test('sends the session cookie and validates the body', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { id: 'user-1' }));

    const user = await requestApi('/api/auth/me', { schema: UserSchema });

    expect(user).toEqual({ id: 'user-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/auth/me',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  test('serializes a body as JSON', async () => {
    const fetchMock = stubFetch(jsonResponse(201, { id: 'user-2' }));

    await requestApi('/api/admin/users', {
      method: 'POST',
      body: { email: 'new@example.com' },
      schema: UserSchema,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.body).toBe('{"email":"new@example.com"}');
    expect(new Headers(init.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  test('sends a file as it is, under the type the browser gave it', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { id: 'greeting-1' }));
    const file = new Blob([new Uint8Array([0x49, 0x44, 0x33])], {
      type: 'audio/mpeg',
    });

    await requestApi('/api/admin/departments/dept-1/greeting', {
      method: 'PUT',
      body: file,
      schema: UserSchema,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.body).toBe(file);
    expect(new Headers(init.headers).get('content-type')).toBe('audio/mpeg');
  });

  test('sends a file the browser gave no type to as an octet stream', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { id: 'greeting-1' }));
    const file = new Blob([new Uint8Array([0x46, 0x4f, 0x52, 0x4d])]);

    await requestApi('/api/admin/departments/dept-1/greeting', {
      method: 'PUT',
      body: file,
      schema: UserSchema,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get('content-type')).toBe(
      'application/octet-stream',
    );
  });

  test('resolves with nothing when no schema is given', async () => {
    stubFetch(jsonResponse(204));

    await expect(
      requestApi('/api/admin/users/user-1', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
  });

  test('turns the API error shape into an ApiError', async () => {
    stubFetch(
      jsonResponse(404, { error: 'Not Found', message: 'User not found' }),
    );

    const failure = await requestApi('/api/admin/users/missing', {
      schema: UserSchema,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, message: 'User not found' });
  });

  test('keeps the code Better Auth sends', async () => {
    stubFetch(
      jsonResponse(401, {
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'Invalid email or password',
      }),
    );

    const failure = await requestApi('/api/auth/sign-in/email', {
      method: 'POST',
      body: {},
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 401,
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
  });

  test('falls back to the status when the error body is not JSON', async () => {
    stubFetch(new Response('Bad Gateway', { status: 502 }));

    const failure = await requestApi('/api/user/departments', {
      schema: UserSchema,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: 502,
      message: 'Request failed with status 502',
    });
  });

  test('rejects a body the schema does not accept', async () => {
    stubFetch(jsonResponse(200, { id: 42 }));

    const failure = await requestApi('/api/auth/me', {
      schema: UserSchema,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toContain('unexpected shape');
  });
});

describe('requestApiBlob', () => {
  test('downloads a body as the signed-in user and keeps its type', async () => {
    const fetchMock = stubFetch(
      new Response(new Uint8Array([0x49, 0x44, 0x33]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    );
    const { signal } = new AbortController();

    const audio = await requestApiBlob('/api/calls/call-1/voicemail', signal);

    expect(audio.type).toBe('audio/mpeg');
    expect(audio.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/calls/call-1/voicemail',
      { credentials: 'include', signal },
    );
  });

  test('turns a refusal into an ApiError with its status', async () => {
    stubFetch(
      jsonResponse(410, {
        error: 'Gone',
        message: 'This voicemail is no longer available',
      }),
    );

    const failure = await requestApiBlob('/api/calls/call-1/voicemail').catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 410,
      message: 'This voicemail is no longer available',
    });
  });

  test('announces a session the API no longer accepts', async () => {
    stubFetch(jsonResponse(401, { message: 'Unauthorized' }));
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);

    await requestApiBlob('/api/calls/call-1/voicemail').catch(() => undefined);

    expect(expired).toHaveBeenCalledOnce();
    unsubscribe();
  });

  test('passes on a download that was dropped or never answered', async () => {
    const dropped = new DOMException('The download was dropped', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw dropped;
      }),
    );

    await expect(requestApiBlob('/api/calls/call-1/voicemail')).rejects.toBe(
      dropped,
    );
  });
});

describe('onSessionExpired', () => {
  test('announces a session the API no longer accepts', async () => {
    stubFetch(jsonResponse(401, { message: 'Unauthorized' }));
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);

    await requestApi('/api/user/conversations').catch(() => undefined);

    expect(expired).toHaveBeenCalledOnce();
    unsubscribe();
  });

  test('says nothing about a request that failed for another reason', async () => {
    stubFetch(jsonResponse(403, { message: 'Forbidden' }));
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);

    await requestApi('/api/admin/users').catch(() => undefined);

    expect(expired).not.toHaveBeenCalled();
    unsubscribe();
  });

  test('stops after unsubscribing', async () => {
    stubFetch(jsonResponse(401, { message: 'Unauthorized' }));
    const expired = vi.fn();

    onSessionExpired(expired)();
    await requestApi('/api/user/conversations').catch(() => undefined);

    expect(expired).not.toHaveBeenCalled();
  });
});

describe('requestCallController', () => {
  test('authenticates with the realtime token instead of the cookie', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { id: 'token' }));

    await requestCallController('/api/voice/jwt', 'realtime-jwt', {
      schema: UserSchema,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://localhost:3002/api/voice/jwt');
    expect(init.credentials).toBeUndefined();
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer realtime-jwt',
    );
  });
});
