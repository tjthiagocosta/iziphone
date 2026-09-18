import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { type Mailer, NullMailer } from './mailer.js';
import { createSmtpMailer } from './smtp-mailer.js';

declare module 'fastify' {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

const register: FastifyPluginAsync = async (fastify) => {
  const { mail } = fastify.config;

  if (!mail) {
    fastify.decorate('mailer', new NullMailer());
    fastify.log.info(
      'SMTP is not configured; invite and reset links are shown in the admin console only',
    );
    return;
  }

  const mailer = createSmtpMailer(mail, fastify.log);
  fastify.decorate('mailer', mailer);

  fastify.addHook('onClose', async () => {
    await mailer.close();
  });
};

export const mailPlugin = fp(register, {
  name: 'mail',
});
