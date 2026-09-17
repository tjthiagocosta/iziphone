/*
 * Redis pub/sub channels shared by the call controller and the API.
 *
 * Events flow from the call controller to the API and describe what happened
 * on the telephony side. Commands flow from the API to the call controller and
 * ask it to act on a live call. A channel is never used in both directions.
 *
 * Hold and transfer are not commands: an agent asks the call controller for
 * them directly, because only it can check the request against the live call
 * and answer with what happened.
 */

export const CHANNELS = {
  /** A new inbound call arrived. */
  CALL_INCOMING: 'call:incoming',
  /** An agent answered, or an outbound call connected. */
  CALL_STARTED: 'call:started',
  /** A call ended for any reason. */
  CALL_ENDED: 'call:ended',
  /** An inbound call went unanswered. */
  CALL_MISSED: 'call:missed',
  /** A transfer completed. */
  CALL_TRANSFERRED: 'call:transferred',
  /** The other party was put on hold. */
  CALL_HELD: 'call:held',
  /** The other party was taken off hold. */
  CALL_RESUMED: 'call:resumed',
  /** A dial leg changed status (feeds the call timeline). */
  CALL_PARTICIPANT_STATUS: 'call:participant-status',
  /** A recording is available at a URL. */
  CALL_RECORDING_READY: 'call:recording-ready',
  /** A transcription is available. */
  CALL_TRANSCRIPTION_READY: 'call:transcription-ready',
  /** The provider moved a call to a new conversation id. */
  CALL_CONVERSATION_MIGRATED: 'call:conversation-migrated',

  /** Hang up a live call. */
  CALL_HANGUP: 'call:hangup',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Published by the call controller, consumed by the API. */
export const EVENT_CHANNELS = [
  CHANNELS.CALL_INCOMING,
  CHANNELS.CALL_STARTED,
  CHANNELS.CALL_ENDED,
  CHANNELS.CALL_MISSED,
  CHANNELS.CALL_TRANSFERRED,
  CHANNELS.CALL_HELD,
  CHANNELS.CALL_RESUMED,
  CHANNELS.CALL_PARTICIPANT_STATUS,
  CHANNELS.CALL_RECORDING_READY,
  CHANNELS.CALL_TRANSCRIPTION_READY,
  CHANNELS.CALL_CONVERSATION_MIGRATED,
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** Published by the API, consumed by the call controller. */
export const COMMAND_CHANNELS = [CHANNELS.CALL_HANGUP] as const;

export type CommandChannel = (typeof COMMAND_CHANNELS)[number];
