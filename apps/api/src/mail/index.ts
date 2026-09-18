export {
  InMemoryMailer,
  MAIL_NOT_CONFIGURED,
  type MailConfig,
  type Mailer,
  type MailMessage,
  type MailResult,
  NullMailer,
} from './mailer.js';
export { type AccessLinkEmail, accessLinkEmail } from './messages.js';
export { mailPlugin } from './plugin.js';
export { createSmtpMailer, SmtpMailer } from './smtp-mailer.js';
