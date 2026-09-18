import nodemailer, { type Transporter } from 'nodemailer';
import type { ServiceLogger } from '../infra/index.js';
import type { MailConfig, Mailer, MailMessage, MailResult } from './mailer.js';

/**
 * SMTP delivery through one pooled connection. Which server, which credentials
 * and which port all live in the one `SMTP_URL`, so nothing here knows about
 * any particular provider.
 */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
    private readonly log: ServiceLogger,
  ) {}

  async send(message: MailMessage): Promise<MailResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      const messageId =
        typeof info.messageId === 'string' ? info.messageId : null;
      this.log.info({ messageId }, 'Email sent');

      return { sent: true, messageId };
    } catch (error) {
      /*
       * The recipient and the body stay out of the log: a set-password email
       * names the person and carries their link. The code (`EAUTH`,
       * `ECONNECTION`, …) is what an operator needs and is not about anyone.
       */
      const reason = failureReason(error);
      this.log.warn({ reason }, 'Email could not be sent');

      return { sent: false, reason };
    }
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}

export function createSmtpMailer(
  config: MailConfig,
  log: ServiceLogger,
): SmtpMailer {
  return new SmtpMailer(
    nodemailer.createTransport(config.smtpUrl),
    config.from,
    log,
  );
}

function failureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
  }

  return error instanceof Error ? error.name : 'Unknown error';
}
