/*
 * The one place the browser talks HTTP from. Both backends answer JSON and
 * report failures as `{ error, message }`; the API is authenticated by the
 * Better Auth session cookie, the call controller by the realtime JWT the
 * API issued. Every response body is validated with its `@repo/dto` schema
 * before it reaches a hook or a view.
 */

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export const CALL_CONTROLLER_URL =
  process.env.NEXT_PUBLIC_CALL_CONTROLLER_URL || 'http://localhost:3002';

/** A Zod schema, without making this app depend on Zod directly. */
export interface ResponseSchema<T> {
  parse(data: unknown): T;
}

export type QueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable code when the backend sent one (Better Auth does). */
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as JSON. */
  body?: unknown;
  /** Validates the response body. Omit for endpoints that answer with none. */
  schema?: ResponseSchema<T>;
}

/** Builds `path?key=value`, leaving out empty, false and undefined values. */
export function withQuery(path: string, params: QueryParams): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      value === false
    ) {
      continue;
    }
    query.set(key, String(value));
  }

  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

/** Calls the business API as the signed-in user. */
export function requestApi<T = void>(
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  return request(`${API_URL}${path}`, options, { credentials: 'include' });
}

/** Calls the call controller with the realtime JWT. */
export function requestCallController<T = void>(
  path: string,
  realtimeToken: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  return request(`${CALL_CONTROLLER_URL}${path}`, options, {
    headers: { Authorization: `Bearer ${realtimeToken}` },
  });
}

async function request<T>(
  url: string,
  { method = 'GET', body, schema }: RequestOptions<T>,
  init: Pick<RequestInit, 'credentials' | 'headers'>,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    method,
    headers,
    credentials: init.credentials,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw await errorFrom(response);
  }

  if (!schema) {
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, 'The server answered without JSON');
  }

  try {
    return schema.parse(payload);
  } catch (error) {
    throw new ApiError(
      response.status,
      `The server answered with an unexpected shape: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  const fallback = `Request failed with status ${response.status}`;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(response.status, fallback);
  }

  if (typeof body !== 'object' || body === null) {
    return new ApiError(response.status, fallback);
  }

  const { message, error, code } = body as Record<string, unknown>;
  const text =
    typeof message === 'string'
      ? message
      : typeof error === 'string'
        ? error
        : fallback;

  return new ApiError(
    response.status,
    text,
    typeof code === 'string' ? code : undefined,
  );
}
