import type { SetPasswordPurpose } from '@repo/dto';
import type { MailMessage } from './mailer.js';

/*
 * The two emails this system sends. Both are pure text built from a name, a
 * link and how long that link lives: no product name (the owner has not
 * settled one), no tracking, no images, and nothing a recipient has to click
 * except the link itself.
 */

export interface AccessLinkEmail {
  to: string;
  /** How to address the recipient; their email when they have no name yet. */
  name: string;
  url: string;
  /** How long the link lives, in words: "7 days", "1 hour". */
  lifetime: string;
}

const COPY: Record<
  SetPasswordPurpose,
  { subject: string; opening: string; closing: string }
> = {
  INVITE: {
    subject: 'Set up your phone system account',
    opening:
      'An account has been created for you on your team’s phone system. Choose a password to finish setting it up:',
    closing:
      'If you were not expecting this, you can ignore this message and no account will be activated.',
  },
  RESET: {
    subject: 'Reset your phone system password',
    opening:
      'Somebody asked to reset the password for your phone system account. Choose a new one here:',
    closing:
      'If it was not you, nothing has changed and you can ignore this message.',
  },
};

export function accessLinkEmail(
  purpose: SetPasswordPurpose,
  details: AccessLinkEmail,
): MailMessage {
  const copy = COPY[purpose];
  const validity = `This link can be used once and expires in ${details.lifetime}.`;

  return {
    to: details.to,
    subject: copy.subject,
    text: [
      `Hello ${details.name},`,
      '',
      copy.opening,
      '',
      details.url,
      '',
      validity,
      '',
      copy.closing,
    ].join('\n'),
    html: [
      `<p>Hello ${escapeHtml(details.name)},</p>`,
      `<p>${escapeHtml(copy.opening)}</p>`,
      `<p><a href="${escapeHtml(details.url)}">${escapeHtml(details.url)}</a></p>`,
      `<p>${escapeHtml(validity)}</p>`,
      `<p>${escapeHtml(copy.closing)}</p>`,
    ].join('\n'),
  };
}

/*
 * The name comes from an admin's form and the URL from our own configuration,
 * but both end up inside an attribute and a text node, so neither is trusted
 * here: a name containing `"` or `<` must not be able to reshape the message.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
