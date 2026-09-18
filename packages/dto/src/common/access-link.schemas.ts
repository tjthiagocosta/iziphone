import { z } from 'zod';
import { SetPasswordPurposeSchema } from './domain.js';
import {
  EmailSchema,
  IsoDateTimeSchema,
  PasswordSchema,
} from './primitives.js';

/*
 * The one way anybody gets a password in this system: a single-use link.
 * An admin issues it (an invite, or a reset for someone who is locked out),
 * or a signed-out person asks for one themselves. Email is a way to deliver
 * the link, not the link itself, so the admin console always shows it.
 */

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Asks for a reset link. Answered the same way whether or not the address exists. */
export const ForgotPasswordSchema = z.object({
  email: EmailSchema,
});

export const SetPasswordSchema = z.object({
  token: z.string().min(1, 'This link is missing its token'),
  password: PasswordSchema,
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * A link an admin has just been handed. `url` is shown so it can be copied:
 * the system has to work before SMTP is configured, and while mail is slow.
 */
export const AccessLinkResponseSchema = z.object({
  purpose: SetPasswordPurposeSchema,
  url: z.url(),
  expiresAt: IsoDateTimeSchema,
  emailSent: z.boolean(),
  /** Why the email did not go out, so the admin knows to pass the link on. */
  emailError: z.string().nullable(),
});

/** Whether a set-password page can still be used, and what it is for. */
export const SetPasswordLinkSchema = z.object({
  valid: z.boolean(),
  /** Null when the link is dead, so the page cannot greet a stranger by purpose. */
  purpose: SetPasswordPurposeSchema.nullable(),
  /** What to tell the visitor when it is dead, and null while it works. */
  message: z.string().nullable(),
});

/** Sent with the session cookie, once a password has been set. */
export const SetPasswordResultSchema = z.object({
  success: z.literal(true),
});

/** Always the same, whether or not the address belongs to anybody. */
export const ForgotPasswordResultSchema = z.object({
  success: z.literal(true),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForgotPassword = z.infer<typeof ForgotPasswordSchema>;
export type SetPassword = z.infer<typeof SetPasswordSchema>;
export type AccessLinkResponse = z.infer<typeof AccessLinkResponseSchema>;
export type SetPasswordLink = z.infer<typeof SetPasswordLinkSchema>;
export type SetPasswordResult = z.infer<typeof SetPasswordResultSchema>;
export type ForgotPasswordResult = z.infer<typeof ForgotPasswordResultSchema>;
