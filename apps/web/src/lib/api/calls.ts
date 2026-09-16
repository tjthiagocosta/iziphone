import {
  type CallListQuery,
  type CallListResponse,
  CallListResponseSchema,
} from '@repo/dto';
import { requestApi, requestApiBlob, withQuery } from './client';

/* Call history, under `/api/calls`. */

/**
 * Newest first. `linePhone` and `contactPhone` together select the calls of
 * one conversation; each is matched against both legs of the call.
 */
export function listCalls(
  query: Partial<CallListQuery> = {},
): Promise<CallListResponse> {
  return requestApi(withQuery('/api/calls', query), {
    schema: CallListResponseSchema,
  });
}

/**
 * The audio of the voicemail a call left. The API fetches the recording from
 * the provider itself; the recording's own URL never reaches the browser.
 */
export function fetchVoicemail(
  conversationUuid: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return requestApiBlob(
    `/api/calls/${encodeURIComponent(conversationUuid)}/voicemail`,
    signal,
  );
}
