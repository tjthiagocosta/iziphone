import { z } from 'zod';
import type { Channel } from './channels.js';
import {
  CHANNEL_SCHEMAS,
  type ChannelInput,
  type ChannelPayload,
} from './messages.js';

/** The slice of an ioredis client a publisher needs. */
export interface PublishConnection {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * The slice of an ioredis client a subscriber needs. Redis puts a connection
 * into subscriber mode on the first `subscribe`, so callers pass a dedicated
 * connection (`redis.duplicate()`), never the one used for commands.
 */
export interface SubscribeConnection {
  subscribe(...channels: string[]): Promise<unknown>;
  on(
    event: 'message',
    listener: (channel: string, message: string) => void,
  ): unknown;
}

/** Matches the pino signature Fastify exposes as `fastify.log`. */
export interface ChannelLogger {
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

/**
 * Validate and publish one message. Throws a `ZodError` when the payload does
 * not match the channel's schema: that is a programming error in the
 * publisher, and surfacing it beats sending a message nobody can consume.
 * Resolves to the number of subscribers that received it.
 */
export async function publish<C extends Channel>(
  connection: PublishConnection,
  channel: C,
  payload: ChannelInput<C>,
): Promise<number> {
  const message = CHANNEL_SCHEMAS[channel].parse(payload);
  return connection.publish(channel, JSON.stringify(message));
}

export type ChannelHandler<C extends Channel> = (
  payload: ChannelPayload<C>,
) => unknown;

export interface ChannelSubscriber {
  /** Register a handler. Registering the same channel twice replaces the handler. */
  on<C extends Channel>(
    channel: C,
    handler: ChannelHandler<C>,
  ): ChannelSubscriber;
  /** Subscribe to every registered channel. Resolves once Redis confirms. */
  start(): Promise<void>;
}

/**
 * Dispatch incoming messages to per-channel handlers over a single Redis
 * `message` listener. Messages that are not valid JSON, do not match the
 * channel's schema, or whose handler throws are logged and dropped; one bad
 * message must never take the consumer down. The raw message is deliberately
 * not logged because payloads carry phone numbers and transcripts.
 */
export function createChannelSubscriber(
  connection: SubscribeConnection,
  logger: ChannelLogger,
): ChannelSubscriber {
  const handlers = new Map<Channel, ChannelHandler<Channel>>();

  const dispatch = async (channel: string, message: string): Promise<void> => {
    const handler = handlers.get(channel as Channel);
    if (!handler) {
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      logger.warn(
        { channel },
        'Dropped pub/sub message that is not valid JSON',
      );
      return;
    }

    const schema: z.ZodType = CHANNEL_SCHEMAS[channel as Channel];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { channel, issues: z.treeifyError(parsed.error) },
        'Dropped pub/sub message that does not match the channel schema',
      );
      return;
    }

    try {
      await handler(parsed.data as ChannelPayload<Channel>);
    } catch (error) {
      logger.error({ channel, err: error }, 'Pub/sub handler failed');
    }
  };

  connection.on('message', (channel, message) => {
    void dispatch(channel, message);
  });

  const subscriber: ChannelSubscriber = {
    on(channel, handler) {
      handlers.set(channel, handler as ChannelHandler<Channel>);
      return subscriber;
    },
    async start() {
      if (handlers.size === 0) {
        return;
      }
      await connection.subscribe(...handlers.keys());
    },
  };

  return subscriber;
}

/** Typed publishers for the events the call controller emits. */
export function createEventPublisher(connection: PublishConnection) {
  return {
    callIncoming: (payload: ChannelInput<'call:incoming'>) =>
      publish(connection, 'call:incoming', payload),
    callStarted: (payload: ChannelInput<'call:started'>) =>
      publish(connection, 'call:started', payload),
    callEnded: (payload: ChannelInput<'call:ended'>) =>
      publish(connection, 'call:ended', payload),
    callMissed: (payload: ChannelInput<'call:missed'>) =>
      publish(connection, 'call:missed', payload),
    callTransferred: (payload: ChannelInput<'call:transferred'>) =>
      publish(connection, 'call:transferred', payload),
    callParticipantStatus: (payload: ChannelInput<'call:participant-status'>) =>
      publish(connection, 'call:participant-status', payload),
    callRecordingReady: (payload: ChannelInput<'call:recording-ready'>) =>
      publish(connection, 'call:recording-ready', payload),
    callTranscriptionReady: (
      payload: ChannelInput<'call:transcription-ready'>,
    ) => publish(connection, 'call:transcription-ready', payload),
    callConversationMigrated: (
      payload: ChannelInput<'call:conversation-migrated'>,
    ) => publish(connection, 'call:conversation-migrated', payload),
  };
}

export type EventPublisher = ReturnType<typeof createEventPublisher>;

/** Typed publishers for the commands the API sends to the call controller. */
export function createCommandPublisher(connection: PublishConnection) {
  return {
    transfer: (payload: ChannelInput<'call:transfer'>) =>
      publish(connection, 'call:transfer', payload),
    hold: (payload: ChannelInput<'call:hold'>) =>
      publish(connection, 'call:hold', payload),
    hangup: (payload: ChannelInput<'call:hangup'>) =>
      publish(connection, 'call:hangup', payload),
  };
}

export type CommandPublisher = ReturnType<typeof createCommandPublisher>;
