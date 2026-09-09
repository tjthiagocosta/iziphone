import { CHANNELS, createChannelSubscriber } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { TelephonyService } from './telephony.service.js';

/*
 * The API asks this service to act on live calls over Redis: transfer, hold
 * and hang up. Each command is validated by @repo/events before it gets here.
 */

export type CallCommandTarget = Pick<
  TelephonyService,
  'transferConversation' | 'holdConversation' | 'requestConversationHangup'
>;

export interface CallCommandSubscriber {
  close(): Promise<void>;
}

export async function startCallCommandSubscriber(deps: {
  redis: Pick<Redis, 'duplicate'>;
  telephony: CallCommandTarget;
  log: FastifyBaseLogger;
}): Promise<CallCommandSubscriber> {
  // Subscribing puts a connection into subscriber mode, so it gets its own.
  const connection = deps.redis.duplicate();

  await createChannelSubscriber(connection, deps.log)
    .on(CHANNELS.CALL_TRANSFER, (command) =>
      deps.telephony.transferConversation(
        command.conversationUuid,
        command.targetUserId,
        command.initiatedBy,
      ),
    )
    .on(CHANNELS.CALL_HOLD, (command) =>
      deps.telephony.holdConversation(command.conversationUuid, command.hold),
    )
    .on(CHANNELS.CALL_HANGUP, (command) =>
      deps.telephony.requestConversationHangup(
        command.conversationUuid,
        command.initiatedBy,
      ),
    )
    .start();

  return {
    async close() {
      await connection.quit();
    },
  };
}
