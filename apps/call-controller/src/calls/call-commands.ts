import { CHANNELS, createChannelSubscriber } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { CallFlow } from './call-flow.js';

/*
 * The API asks this service to hang up a live call over Redis. The command is
 * validated by @repo/events before it gets here, and ends the call through
 * the flow like any other change to it, so that whoever the call stops
 * occupying is let go. Hold and transfer do not come this way: the softphone
 * asks for them on the voice routes, where the request is checked against
 * the call and answered with what happened.
 */

export type CallCommandTarget = Pick<CallFlow, 'endCall'>;

export interface CallCommandSubscriber {
  close(): Promise<void>;
}

export async function startCallCommandSubscriber(deps: {
  redis: Pick<Redis, 'duplicate'>;
  flow: CallCommandTarget;
  log: FastifyBaseLogger;
}): Promise<CallCommandSubscriber> {
  // Subscribing puts a connection into subscriber mode, so it gets its own.
  const connection = deps.redis.duplicate();

  await createChannelSubscriber(connection, deps.log)
    .on(CHANNELS.CALL_HANGUP, (command) =>
      deps.flow.endCall(command.conversationUuid, command.initiatedBy),
    )
    .start();

  return {
    async close() {
      await connection.quit();
    },
  };
}
