import {
  type CallListQuery,
  type CallListResponse,
  CallListResponseSchema,
  type RecordingDeletedResponse,
  RecordingDeletedResponseSchema,
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

function recordingPath(conversationUuid: string, recordingId: string): string {
  return `/api/calls/${encodeURIComponent(conversationUuid)}/recordings/${encodeURIComponent(recordingId)}`;
}

/**
 * The audio of one of a call's recordings, a voicemail or the call itself. The
 * API serves it from its own store, or fetches it from the provider while the
 * copy is owed; the recording's provider URL never reaches the browser.
 */
export function fetchRecording(
  conversationUuid: string,
  recordingId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return requestApiBlob(recordingPath(conversationUuid, recordingId), signal);
}

/**
 * Deletes a recording's audio now, before its retention policy would. Admins
 * only; the call keeps saying there was a recording and that it was deleted.
 * The reply carries the deletion as it is stored, which is the retention
 * policy's when the sweep got there first.
 */
export function deleteRecording(
  conversationUuid: string,
  recordingId: string,
): Promise<RecordingDeletedResponse> {
  return requestApi(recordingPath(conversationUuid, recordingId), {
    method: 'DELETE',
    schema: RecordingDeletedResponseSchema,
  });
}
