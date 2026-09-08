import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  MessagingMediaError,
  MessagingMediaService,
  type StoredMediaFile,
} from '../services/messaging/messaging-media.service.js';

/**
 * Public, unauthenticated media links. Prepared media is fetched by the
 * provider while it sends an MMS; message media is what clients render.
 * Ids are random UUIDs, which is the only access control these have.
 */
const messageMediaRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, db, log } = fastify;
  const mediaService = new MessagingMediaService({
    db,
    storageDir: config.messagingMediaStorageDir,
    publicUrl: config.publicUrl,
    credentials: config.twilio,
    log,
  });

  fastify.get<{
    Params: { preparedMediaId: string };
  }>('/media/messaging/prepared/:preparedMediaId', async (request, reply) =>
    sendMedia(reply, () =>
      mediaService.openPreparedMedia(request.params.preparedMediaId),
    ),
  );

  fastify.get<{
    Params: { messageMediaId: string };
  }>('/media/messaging/messages/:messageMediaId', async (request, reply) =>
    sendMedia(reply, () =>
      mediaService.openMessageMedia(request.params.messageMediaId),
    ),
  );
};

async function sendMedia(
  reply: FastifyReply,
  open: () => Promise<StoredMediaFile>,
) {
  try {
    const file = await open();
    reply.header('content-type', file.mimeType);
    return reply.send(file.content);
  } catch (error) {
    if (error instanceof MessagingMediaError) {
      return error.code === 'expired'
        ? reply.status(410).send({ error: 'Gone' })
        : reply.status(404).send({ error: 'Not Found' });
    }

    throw error;
  }
}

export default messageMediaRoutes;
