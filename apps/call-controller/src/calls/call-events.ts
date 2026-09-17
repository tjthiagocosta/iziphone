import {
  type ChannelInput,
  createEventPublisher,
  type EventChannel,
  type PublishConnection,
} from '@repo/events';

/*
 * The events this service publishes for the API, stamped with the time they
 * are published. The schemas and validation live in @repo/events.
 */

type Unstamped<C extends EventChannel> = Omit<ChannelInput<C>, 'timestamp'>;

export interface CallEventPublisher {
  callIncoming(event: Unstamped<'call:incoming'>): Promise<void>;
  callStarted(event: Unstamped<'call:started'>): Promise<void>;
  callEnded(event: Unstamped<'call:ended'>): Promise<void>;
  callMissed(event: Unstamped<'call:missed'>): Promise<void>;
  callTransferred(event: Unstamped<'call:transferred'>): Promise<void>;
  callHeld(event: Unstamped<'call:held'>): Promise<void>;
  callResumed(event: Unstamped<'call:resumed'>): Promise<void>;
  callParticipantStatus(
    event: Unstamped<'call:participant-status'>,
  ): Promise<void>;
  callRecordingReady(event: Unstamped<'call:recording-ready'>): Promise<void>;
  callTranscriptionReady(
    event: Unstamped<'call:transcription-ready'>,
  ): Promise<void>;
}

export function createCallEventPublisher(
  connection: PublishConnection,
): CallEventPublisher {
  const publisher = createEventPublisher(connection);
  const stamped = <T extends object>(event: T) => ({
    ...event,
    timestamp: new Date().toISOString(),
  });

  return {
    async callIncoming(event) {
      await publisher.callIncoming(stamped(event));
    },
    async callStarted(event) {
      await publisher.callStarted(stamped(event));
    },
    async callEnded(event) {
      await publisher.callEnded(stamped(event));
    },
    async callMissed(event) {
      await publisher.callMissed(stamped(event));
    },
    async callTransferred(event) {
      await publisher.callTransferred(stamped(event));
    },
    async callHeld(event) {
      await publisher.callHeld(stamped(event));
    },
    async callResumed(event) {
      await publisher.callResumed(stamped(event));
    },
    async callParticipantStatus(event) {
      await publisher.callParticipantStatus(stamped(event));
    },
    async callRecordingReady(event) {
      await publisher.callRecordingReady(stamped(event));
    },
    async callTranscriptionReady(event) {
      await publisher.callTranscriptionReady(stamped(event));
    },
  };
}
