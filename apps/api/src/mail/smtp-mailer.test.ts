import type { Transporter } from 'nodemailer';
import { describe, expect, test, vi } from 'vitest';
import { MAIL_NOT_CONFIGURED, NullMailer } from './mailer.js';
import { SmtpMailer } from './smtp-mailer.js';

const message = {
  to: 'agent@example.com',
  subject: 'Set up your account',
  text: 'https://app.example.com/set-password?token=a-fictional-token',
  html: '<p>link</p>',
};

function transport(behaviour: {
  sendMail: () => Promise<unknown> | never;
}): Transporter {
  return {
    sendMail: vi.fn(behaviour.sendMail),
    close: vi.fn(),
  } as unknown as Transporter;
}

function recordingLogger() {
  const lines: unknown[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args);
  };

  return {
    lines,
    log: { info: record, warn: record, error: record },
  };
}

describe('SmtpMailer', () => {
  test('sends from the configured address and reports the message id', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<abc@example.com>' }));
    const mailer = new SmtpMailer(
      { sendMail, close: vi.fn() } as unknown as Transporter,
      'Phone system <no-reply@example.com>',
      recordingLogger().log,
    );

    const result = await mailer.send(message);

    expect(result).toEqual({ sent: true, messageId: '<abc@example.com>' });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Phone system <no-reply@example.com>',
      ...message,
    });
  });

  test('reports a refused send as a result rather than throwing', async () => {
    const failure = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
    });
    const mailer = new SmtpMailer(
      transport({
        sendMail: () => {
          throw failure;
        },
      }),
      'no-reply@example.com',
      recordingLogger().log,
    );

    // The caller has already committed a database change; a bad mail server
    // must not turn that into an error.
    expect(await mailer.send(message)).toEqual({
      sent: false,
      reason: 'EAUTH',
    });
  });

  test('falls back to the error class when there is no code', async () => {
    const mailer = new SmtpMailer(
      transport({
        sendMail: () => {
          throw new TypeError('bad options');
        },
      }),
      'no-reply@example.com',
      recordingLogger().log,
    );

    expect(await mailer.send(message)).toEqual({
      sent: false,
      reason: 'TypeError',
    });
  });

  test('logs neither the recipient nor the link', async () => {
    const logger = recordingLogger();
    const failing = new SmtpMailer(
      transport({
        sendMail: () => {
          throw Object.assign(new Error(`could not reach ${message.to}`), {
            code: 'ECONNECTION',
          });
        },
      }),
      'no-reply@example.com',
      logger.log,
    );

    await failing.send(message);
    await new SmtpMailer(
      transport({ sendMail: async () => ({ messageId: '<abc@example.com>' }) }),
      'no-reply@example.com',
      logger.log,
    ).send(message);

    const logged = JSON.stringify(logger.lines);

    expect(logged).not.toContain('agent@example.com');
    expect(logged).not.toContain('a-fictional-token');
    expect(logged).toContain('ECONNECTION');
  });

  test('closes its connection pool', async () => {
    const pool = transport({ sendMail: async () => ({}) });

    await new SmtpMailer(
      pool,
      'no-reply@example.com',
      recordingLogger().log,
    ).close();

    expect(pool.close).toHaveBeenCalled();
  });
});

describe('NullMailer', () => {
  test('reports that email is not configured, and nothing worse', async () => {
    expect(await new NullMailer().send(message)).toEqual({
      sent: false,
      reason: MAIL_NOT_CONFIGURED,
    });
  });
});
