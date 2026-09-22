import type { PrismaClient } from '@repo/db';
import type { MessageActivityKind } from '@repo/dto';
import { CHANNELS, type PublishConnection, publish } from '@repo/events';
import { loadConversationAudience } from './conversation-scope.js';
import type { MessagingLogger } from './logger.js';

/*
 * Tells the people who can see a conversation that it changed, so their
 * browsers ask for it instead of waiting for the next poll.
 *
 * The notification carries the conversation id, what happened to it, and who
 * may see it. No body, no phone number, no message id: the call controller
 * relays it to those users' sockets without being able to read anything about
 * the message, and the browser fetches the conversation from the API, which is
 * where the rule about who may read it is enforced.
 */

export interface MessageActivityNotifierOptions {
  db: Pick<PrismaClient, 'messageConversation'>;
  redis: PublishConnection;
  log: Pick<MessagingLogger, 'warn'>;
}

export class MessageActivityNotifier {
  private readonly db: MessageActivityNotifierOptions['db'];
  private readonly redis: PublishConnection;
  private readonly log: MessageActivityNotifierOptions['log'];

  constructor(options: MessageActivityNotifierOptions) {
    this.db = options.db;
    this.redis = options.redis;
    this.log = options.log;
  }

  /**
   * Never throws. The message is already stored and the browser polls as well,
   * so a notification that cannot be sent costs a wait, not a delivery, and
   * must not turn a webhook we have honoured into a failure the provider
   * retries.
   */
  async notify(conversationId: string, kind: MessageActivityKind) {
    try {
      const userIds = await loadConversationAudience(this.db, conversationId);

      // Nobody can open this conversation, so there is nobody to tell. The
      // schema refuses an empty audience as well: it would reach Socket.IO's
      // `to` as "every connected socket".
      if (userIds.length === 0) {
        return;
      }

      await publish(this.redis, CHANNELS.MESSAGE_ACTIVITY, {
        kind,
        conversationId,
        userIds,
      });
    } catch (error) {
      this.log.warn(
        {
          conversationId,
          kind,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not tell the browsers that a conversation changed',
      );
    }
  }
}
