/**
 * Outbound email. The system never depends on a message arriving: every link
 * it sends is also handed back to the admin who asked for it, so a mailer that
 * cannot deliver reports why instead of failing the operation behind it.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailResult =
  | { sent: true; messageId: string | null }
  /** Short enough to show an admin and safe to log: never the address or the body. */
  | { sent: false; reason: string };

export interface Mailer {
  /** Never throws: a failure is a result, because the caller has already committed. */
  send(message: MailMessage): Promise<MailResult>;
}

export interface MailConfig {
  /** Nodemailer's URL form, `smtp://user:pass@host:port` or `smtps://…`. */
  smtpUrl: string;
  /** The `From` header, e.g. `Phone system <no-reply@example.com>`. */
  from: string;
}

export const MAIL_NOT_CONFIGURED = 'Email is not configured';

/**
 * What a deployment without SMTP uses. It reports the same shape as a failed
 * send, so every caller has one path: show the admin the link.
 */
export class NullMailer implements Mailer {
  async send(): Promise<MailResult> {
    return { sent: false, reason: MAIL_NOT_CONFIGURED };
  }
}

/** Keeps every message in memory, for tests. */
export class InMemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailResult> {
    this.sent.push(message);
    return { sent: true, messageId: `in-memory-${this.sent.length}` };
  }
}
