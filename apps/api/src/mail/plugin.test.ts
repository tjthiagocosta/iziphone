import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import type { ApiConfig } from '../config.js';
import { testApiConfig } from '../test/route-test-helpers.js';
import { NullMailer } from './mailer.js';
import { mailPlugin } from './plugin.js';
import { SmtpMailer } from './smtp-mailer.js';

async function appWith(mail: ApiConfig['mail']) {
  const app = Fastify({ logger: false });

  app.decorate('config', { ...testApiConfig, mail });
  await app.register(mailPlugin);
  await app.ready();

  return app;
}

describe('mailPlugin', () => {
  test('uses the null mailer when no SMTP server is configured', async () => {
    const app = await appWith(null);

    // Not an error: the deployment works, and links are shown instead of sent.
    expect(app.mailer).toBeInstanceOf(NullMailer);
    expect(
      await app.mailer.send({
        to: 'agent@example.com',
        subject: 'Set up your account',
        text: 'link',
        html: '<p>link</p>',
      }),
    ).toMatchObject({ sent: false });

    await app.close();
  });

  test('builds an SMTP mailer from the configuration and closes it with the app', async () => {
    const app = await appWith({
      smtpUrl: 'smtp://user:not-a-real-password@smtp.example.com:587',
      from: 'Phone system <no-reply@example.com>',
    });

    expect(app.mailer).toBeInstanceOf(SmtpMailer);

    // Nothing is connected until a message is sent, so closing is all we do.
    await app.close();
  });
});
