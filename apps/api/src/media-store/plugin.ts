import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { MediaStore } from './media-store.js';
import { createS3Client, S3MediaStore } from './s3-media-store.js';

declare module 'fastify' {
  interface FastifyInstance {
    mediaStore: MediaStore;
  }
}

const register: FastifyPluginAsync = async (fastify) => {
  const { storage } = fastify.config;
  const client = createS3Client(storage);

  fastify.decorate(
    'mediaStore',
    new S3MediaStore(client, {
      bucket: storage.bucket,
      keyPrefix: storage.keyPrefix,
    }),
  );

  fastify.addHook('onClose', async () => {
    client.destroy();
  });
};

export const mediaStorePlugin = fp(register, {
  name: 'media-store',
});
