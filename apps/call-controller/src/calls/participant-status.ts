import type { CallEndStatus } from '@repo/dto';
import type { CallParticipantType } from '@repo/events';

/*
 * Twilio reports leg progress with its own vocabulary. The API records a
 * timeline entry per change, so each status maps to a timeline event type
 * and a sentence a person can read.
 */

export type ParticipantStatus =
  | 'initiated'
  | 'ringing'
  | 'answered'
  | CallEndStatus;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<CallEndStatus>([
  'completed',
  'busy',
  'canceled',
  'failed',
  'no-answer',
]);

/** Collapse Twilio's call progress values; unknown ones are not tracked. */
export function normalizeCallStatus(
  status: string,
): ParticipantStatus | undefined {
  switch (status) {
    case 'queued':
    case 'initiated':
      return 'initiated';
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'answered':
    case 'connected':
      return 'answered';
    case 'busy':
    case 'canceled':
    case 'no-answer':
    case 'failed':
    case 'completed':
      return status;
    default:
      return undefined;
  }
}

export function isTerminalStatus(
  status: ParticipantStatus,
): status is CallEndStatus {
  return TERMINAL_STATUSES.has(status);
}

/** Mirrors the API's `CallEventType` values for leg progress. */
export type CallTimelineEventType =
  | 'CALL_INITIATED'
  | 'CALL_RINGING'
  | 'CALL_ANSWERED'
  | 'CALL_COMPLETED'
  | 'CALL_FAILED'
  | 'CALL_CANCELED'
  | 'CALL_NO_ANSWER'
  | 'CALL_BUSY'
  | 'DIAL_INITIATED'
  | 'DIAL_ANSWERED'
  | 'DIAL_NO_ANSWER'
  | 'DIAL_BUSY'
  | 'DIAL_FAILED';

/** `CALL_*` describes the caller's own leg; `DIAL_*` a leg we dialed out. */
export function participantEventType(
  participantType: CallParticipantType,
  status: ParticipantStatus,
): CallTimelineEventType {
  const dialed = participantType !== 'caller';

  switch (status) {
    case 'initiated':
      return dialed ? 'DIAL_INITIATED' : 'CALL_INITIATED';
    case 'ringing':
      return 'CALL_RINGING';
    case 'answered':
      return dialed ? 'DIAL_ANSWERED' : 'CALL_ANSWERED';
    case 'busy':
      return dialed ? 'DIAL_BUSY' : 'CALL_BUSY';
    case 'failed':
      return dialed ? 'DIAL_FAILED' : 'CALL_FAILED';
    case 'no-answer':
      return dialed ? 'DIAL_NO_ANSWER' : 'CALL_NO_ANSWER';
    case 'canceled':
      return 'CALL_CANCELED';
    case 'completed':
      return 'CALL_COMPLETED';
  }
}

export function participantDescription(
  participantType: CallParticipantType,
  participantId: string,
  status: ParticipantStatus,
): string {
  const noun =
    participantType === 'agent'
      ? `Agent ${participantId}`
      : participantType === 'external'
        ? `Number ${participantId}`
        : `Caller ${participantId}`;

  switch (status) {
    case 'initiated':
      return `${noun} call initiated`;
    case 'ringing':
      return `${noun} is ringing`;
    case 'answered':
      return `${noun} answered`;
    case 'busy':
      return `${noun} is busy`;
    case 'failed':
      return `${noun} failed`;
    case 'no-answer':
      return `${noun} did not answer`;
    case 'canceled':
      return `${noun} canceled`;
    case 'completed':
      return `${noun} completed`;
  }
}
