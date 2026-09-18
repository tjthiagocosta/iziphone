import {
  type CallActorType,
  CallEventType,
  type Prisma,
  type PrismaClient,
} from '@repo/db';
import {
  type CallConversationMigratedEvent,
  type CallEndedEvent,
  type CallHoldEvent,
  type CallIncomingEvent,
  type CallMissedEvent,
  type CallParticipantStatusEvent,
  type CallRecordingReadyEvent,
  type CallStartedEvent,
  type CallTranscriptionReadyEvent,
  type CallTransferredEvent,
  CHANNELS,
  type Channel,
  createChannelSubscriber,
} from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { CallRecordingService } from './recording.service.js';
import { recordingContextOf, recordingEventType } from './recording-copy.js';
import { twilioRecordingSid } from './twilio-recording.js';

const CALL_EVENT_TYPES = new Set<string>(Object.values(CallEventType));

const END_STATUS_EVENT: Record<CallEndedEvent['status'], CallEventType> = {
  completed: 'CALL_COMPLETED',
  busy: 'CALL_BUSY',
  canceled: 'CALL_CANCELED',
  failed: 'CALL_FAILED',
  'no-answer': 'CALL_NO_ANSWER',
};

interface TimelineEntry {
  callId: string;
  eventType: CallEventType;
  actorType: CallActorType;
  actorId?: string | undefined;
  description: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persists the call history the call controller publishes over Redis: one
 * `Call` row per conversation plus a `CallEvent` timeline, and the recordings
 * Twilio announces, which `recordings` copies into the media store. Phone
 * numbers and transcripts are stored, never logged; a failing event is logged
 * and dropped so one bad message cannot stop the consumer.
 */
export class CallEventSubscriberService {
  private subscriber: Redis | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly db: PrismaClient,
    private readonly logger: FastifyBaseLogger,
    private readonly recordings: Pick<
      CallRecordingService,
      'register' | 'copy'
    >,
  ) {}

  async start(): Promise<void> {
    this.subscriber = this.redis.duplicate();

    await createChannelSubscriber(this.subscriber, this.logger)
      .on(CHANNELS.CALL_INCOMING, (event) =>
        this.handle(CHANNELS.CALL_INCOMING, event.conversationUuid, () =>
          this.onCallIncoming(event),
        ),
      )
      .on(CHANNELS.CALL_STARTED, (event) =>
        this.handle(CHANNELS.CALL_STARTED, event.conversationUuid, () =>
          this.onCallStarted(event),
        ),
      )
      .on(CHANNELS.CALL_ENDED, (event) =>
        this.handle(CHANNELS.CALL_ENDED, event.conversationUuid, () =>
          this.onCallEnded(event),
        ),
      )
      .on(CHANNELS.CALL_MISSED, (event) =>
        this.handle(CHANNELS.CALL_MISSED, event.conversationUuid, () =>
          this.onCallMissed(event),
        ),
      )
      .on(CHANNELS.CALL_TRANSFERRED, (event) =>
        this.handle(CHANNELS.CALL_TRANSFERRED, event.conversationUuid, () =>
          this.onCallTransferred(event),
        ),
      )
      .on(CHANNELS.CALL_HELD, (event) =>
        this.handle(CHANNELS.CALL_HELD, event.conversationUuid, () =>
          this.onHoldChanged(event, true),
        ),
      )
      .on(CHANNELS.CALL_RESUMED, (event) =>
        this.handle(CHANNELS.CALL_RESUMED, event.conversationUuid, () =>
          this.onHoldChanged(event, false),
        ),
      )
      .on(CHANNELS.CALL_PARTICIPANT_STATUS, (event) =>
        this.handle(
          CHANNELS.CALL_PARTICIPANT_STATUS,
          event.conversationUuid,
          () => this.onParticipantStatus(event),
        ),
      )
      .on(CHANNELS.CALL_RECORDING_READY, (event) =>
        this.handle(CHANNELS.CALL_RECORDING_READY, event.conversationUuid, () =>
          this.onRecordingReady(event),
        ),
      )
      .on(CHANNELS.CALL_TRANSCRIPTION_READY, (event) =>
        this.handle(
          CHANNELS.CALL_TRANSCRIPTION_READY,
          event.conversationUuid,
          () => this.onTranscriptionReady(event),
        ),
      )
      .on(CHANNELS.CALL_CONVERSATION_MIGRATED, (event) =>
        this.handle(
          CHANNELS.CALL_CONVERSATION_MIGRATED,
          event.conversationUuid,
          () => this.onConversationMigrated(event),
        ),
      )
      .start();

    this.logger.info('Call event subscriber started');
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
      this.logger.info('Call event subscriber stopped');
    }
  }

  private async handle(
    channel: Channel,
    conversationUuid: string,
    work: () => Promise<void>,
  ): Promise<void> {
    this.logger.info({ channel, conversationUuid }, 'Received call event');

    try {
      await work();
    } catch (error) {
      this.logger.error(
        { error, channel, conversationUuid },
        'Failed to persist call event',
      );
    }
  }

  private async onCallIncoming(event: CallIncomingEvent): Promise<void> {
    const outbound = event.direction === 'outbound';

    const call = await this.db.call.upsert({
      where: { conversationUuid: event.conversationUuid },
      create: {
        conversationUuid: event.conversationUuid,
        callerLegUuid: event.callerLegUuid,
        agentLegUuid: event.agentLegUuid,
        from: event.from,
        to: event.to,
        direction: event.direction,
        status: 'ringing',
        departmentId: event.departmentId ?? null,
        userId: event.userId ?? null,
      },
      update: {
        callerLegUuid: event.callerLegUuid,
        agentLegUuid: event.agentLegUuid,
        from: event.from,
        to: event.to,
        direction: event.direction,
        departmentId: event.departmentId ?? null,
        userId: event.userId ?? null,
      },
    });

    await this.addTimelineEntry({
      callId: call.id,
      eventType: outbound ? 'DIAL_INITIATED' : 'CALL_RINGING',
      actorType: outbound ? 'AGENT' : 'CALLER',
      actorId: outbound ? event.userId : event.from,
      description: outbound
        ? `Outbound call initiated to ${event.to}`
        : `Incoming call from ${event.from}`,
      metadata: {
        direction: event.direction,
        departmentId: event.departmentId,
        userId: event.userId,
        callerLegUuid: event.callerLegUuid,
        agentLegUuid: event.agentLegUuid,
      },
    });
  }

  private async onCallStarted(event: CallStartedEvent): Promise<void> {
    const call = await this.db.call.upsert({
      where: { conversationUuid: event.conversationUuid },
      create: {
        conversationUuid: event.conversationUuid,
        from: event.from,
        to: event.to,
        direction: event.direction,
        status: 'in-progress',
        userId: event.userId,
        departmentId: event.departmentId,
        agentLegUuid: event.agentLegUuid,
        externalLegUuid: event.externalLegUuid,
      },
      update: {
        status: 'in-progress',
        userId: event.userId,
        departmentId: event.departmentId,
        agentLegUuid: event.agentLegUuid,
        externalLegUuid: event.externalLegUuid,
      },
    });

    await this.addTimelineEntry({
      callId: call.id,
      eventType: 'CALL_ANSWERED',
      actorType: 'AGENT',
      actorId: event.userId,
      description: 'Call answered by agent',
      metadata: {
        direction: event.direction,
        agentLegUuid: event.agentLegUuid,
        externalLegUuid: event.externalLegUuid,
      },
    });
  }

  private async onCallEnded(event: CallEndedEvent): Promise<void> {
    const existing = await this.findCall(event.conversationUuid);
    if (!existing) return;

    const call = await this.db.call.update({
      where: { id: existing.id },
      data: {
        status: event.status,
        duration: event.duration,
        callerLegUuid: event.callerLegUuid ?? existing.callerLegUuid,
        agentLegUuid: event.agentLegUuid ?? existing.agentLegUuid,
        externalLegUuid: event.externalLegUuid ?? existing.externalLegUuid,
      },
    });

    await this.addTimelineEntry({
      callId: call.id,
      eventType: END_STATUS_EVENT[event.status],
      actorType: 'PROVIDER',
      description: `Call ${event.status} after ${event.duration}s`,
      metadata: {
        duration: event.duration,
        status: event.status,
        callerLegUuid: event.callerLegUuid,
        agentLegUuid: event.agentLegUuid,
        externalLegUuid: event.externalLegUuid,
      },
    });
  }

  private async onCallMissed(event: CallMissedEvent): Promise<void> {
    const call = await this.db.call.upsert({
      where: { conversationUuid: event.conversationUuid },
      create: {
        conversationUuid: event.conversationUuid,
        from: event.from,
        to: event.to ?? '',
        direction: 'inbound',
        status: 'missed',
        departmentId: event.departmentId ?? null,
        userId: event.userId ?? null,
      },
      update: { status: 'missed' },
    });

    await this.addTimelineEntry({
      callId: call.id,
      eventType: 'CALL_NO_ANSWER',
      actorType: 'SYSTEM',
      description: 'Call missed: no agent answered',
      metadata: {
        departmentId: event.departmentId,
        userId: event.userId,
      },
    });
  }

  private async onCallTransferred(event: CallTransferredEvent): Promise<void> {
    const existing = await this.findCall(event.conversationUuid);
    if (!existing) return;

    const call = await this.db.call.update({
      where: { id: existing.id },
      data: {
        userId: event.toUserId,
        agentLegUuid: event.agentLegUuid ?? existing.agentLegUuid,
      },
    });

    await this.addTimelineEntry({
      callId: call.id,
      eventType: 'CALL_TRANSFERRED',
      actorType: 'AGENT',
      actorId: event.fromUserId,
      description: 'Call transferred to another agent',
      metadata: {
        fromUserId: event.fromUserId,
        toUserId: event.toUserId,
        agentLegUuid: event.agentLegUuid,
      },
    });
  }

  /**
   * The agent's hold button, or a transfer holding the other party while the
   * teammate rings. A resume with nobody named is the controller ending that
   * hold by itself once the transfer settled.
   */
  private async onHoldChanged(
    event: CallHoldEvent,
    held: boolean,
  ): Promise<void> {
    const existing = await this.findCall(event.conversationUuid);
    if (!existing) return;

    await this.addTimelineEntry({
      callId: existing.id,
      eventType: held ? 'CALL_HELD' : 'CALL_RESUMED',
      actorType: event.userId ? 'AGENT' : 'SYSTEM',
      actorId: event.userId,
      description: held ? 'Call placed on hold' : 'Call taken off hold',
      metadata: { legUuid: event.legUuid },
    });
  }

  private async onParticipantStatus(
    event: CallParticipantStatusEvent,
  ): Promise<void> {
    if (!CALL_EVENT_TYPES.has(event.eventType)) {
      this.logger.warn(
        {
          conversationUuid: event.conversationUuid,
          eventType: event.eventType,
        },
        'Dropped participant status with an unknown event type',
      );
      return;
    }

    const existing = await this.findCall(event.conversationUuid);
    if (!existing) return;

    const actorType: CallActorType =
      event.participantType === 'agent'
        ? 'AGENT'
        : event.participantType === 'caller'
          ? 'CALLER'
          : 'PROVIDER';

    await this.addTimelineEntry({
      callId: existing.id,
      eventType: event.eventType as CallEventType,
      actorType,
      actorId: event.participantId,
      description: event.description,
      metadata: {
        participantType: event.participantType,
        status: event.status,
        duration: event.duration,
        legUuid: event.legUuid,
      },
    });
  }

  /**
   * Twilio finished a recording. It is recorded and put on the timeline
   * first, so that it is playable from Twilio whatever becomes of the copy,
   * and copied into the media store after.
   */
  private async onRecordingReady(
    event: CallRecordingReadyEvent,
  ): Promise<void> {
    const existing = await this.findCall(event.conversationUuid);
    if (!existing) return;

    const context = recordingContextOf(event.context);
    const recording = await this.recordings.register({
      callId: existing.id,
      conversationUuid: event.conversationUuid,
      context,
      providerUrl: event.recordingUrl,
      duration: event.duration,
    });
    if (!recording) return;

    await this.addTimelineEntry({
      callId: existing.id,
      eventType: recordingEventType(context),
      actorType: 'PROVIDER',
      description:
        context === 'VOICEMAIL'
          ? 'Voicemail recording ready'
          : 'Call recording ready',
      metadata: {
        recordingSid: recording.recordingSid,
        duration: event.duration,
        context: event.context,
      },
    });

    await this.recordings.copy(recording, event.conversationUuid);
  }

  private async onTranscriptionReady(
    event: CallTranscriptionReadyEvent,
  ): Promise<void> {
    const existing = await this.findCall(event.conversationUuid);
    if (!existing) return;

    await this.db.call.update({
      where: { id: existing.id },
      data: { transcript: event.transcript },
    });

    if (recordingContextOf(event.context) !== 'VOICEMAIL') return;

    await this.addTimelineEntry({
      callId: existing.id,
      eventType: 'VOICEMAIL_COMPLETED',
      actorType: 'PROVIDER',
      description: 'Voicemail transcription ready',
      metadata: {
        // The SID names the recording the transcript is of; its URL at Twilio
        // stops working once the recording is copied and deleted there.
        recordingSid: event.recordingUrl
          ? twilioRecordingSid(event.recordingUrl)
          : null,
        context: event.context,
      },
    });
  }

  private async onConversationMigrated(
    event: CallConversationMigratedEvent,
  ): Promise<void> {
    const alreadyMigrated = await this.db.call.findUnique({
      where: { conversationUuid: event.conversationUuid },
      select: { id: true },
    });

    if (alreadyMigrated) {
      this.logger.info(
        {
          previousConversationUuid: event.previousConversationUuid,
          conversationUuid: event.conversationUuid,
        },
        'Conversation migration already applied',
      );
      return;
    }

    const updated = await this.db.call.updateMany({
      where: { conversationUuid: event.previousConversationUuid },
      data: { conversationUuid: event.conversationUuid },
    });

    if (updated.count === 0) {
      this.logger.warn(
        {
          previousConversationUuid: event.previousConversationUuid,
          conversationUuid: event.conversationUuid,
        },
        'No call found to migrate',
      );
    }
  }

  private async findCall(conversationUuid: string) {
    const call = await this.db.call.findUnique({
      where: { conversationUuid },
      select: {
        id: true,
        callerLegUuid: true,
        agentLegUuid: true,
        externalLegUuid: true,
      },
    });

    if (!call) {
      this.logger.warn({ conversationUuid }, 'No call record for event');
    }

    return call;
  }

  private async addTimelineEntry(entry: TimelineEntry): Promise<void> {
    await this.db.callEvent.create({
      data: {
        callId: entry.callId,
        eventType: entry.eventType,
        actorType: entry.actorType,
        actorId: entry.actorId,
        description: entry.description,
        metadata: entry.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
