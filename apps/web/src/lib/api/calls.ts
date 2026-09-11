import {
  type CallListQuery,
  type CallListResponse,
  CallListResponseSchema,
} from '@repo/dto';
import { requestApi, withQuery } from './client';

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
