import { createHash, randomBytes } from 'node:crypto';
import type { InviteStatus, SetPasswordPurpose } from '@repo/dto';

/*
 * The rules behind the one way anybody gets a password here: a single-use
 * link. How long each kind lives, whether a given one may still be used, and
 * how far a user is through getting in. All of it is decided here, with no
 * database and no clock of its own, so every rule can be read and tested on
 * its own; `AccessLinkService` does the storing, the mailing and the signing in.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** An invite has to survive a weekend and a holiday; a reset does not. */
const LIFETIMES: Record<SetPasswordPurpose, { ms: number; words: string }> = {
  INVITE: { ms: 7 * DAY_MS, words: '7 days' },
  RESET: { ms: 1 * HOUR_MS, words: '1 hour' },
};

export function accessLinkLifetimeMs(purpose: SetPasswordPurpose): number {
  return LIFETIMES[purpose].ms;
}

/** How long the link lives, in words, for the email that carries it. */
export function accessLinkLifetimeWords(purpose: SetPasswordPurpose): string {
  return LIFETIMES[purpose].words;
}

export function accessLinkExpiry(purpose: SetPasswordPurpose, now: Date): Date {
  return new Date(now.getTime() + accessLinkLifetimeMs(purpose));
}

/**
 * 32 bytes from the system's CSPRNG, in the URL alphabet so the whole token is
 * one query parameter. This is the only secret in the flow; it is never stored.
 */
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What is stored instead of the token. A dump of the table therefore opens no
 * account, and a lookup is still one indexed equality.
 */
export function hashAccessToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('base64url');
}

/** Why a link cannot be used. */
export type AccessLinkRejection =
  | 'unknown'
  | 'consumed'
  | 'expired'
  | 'inactive';

export type AccessLinkValidity =
  | { valid: true; purpose: SetPasswordPurpose }
  | { valid: false; reason: AccessLinkRejection };

/** The stored facts a validity decision needs. */
export interface StoredAccessLink {
  purpose: SetPasswordPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
  /** The account the link belongs to; a deleted one cannot be opened again. */
  userDeletedAt: Date | null;
}

export function accessLinkValidity(
  link: StoredAccessLink | null,
  now: Date,
): AccessLinkValidity {
  if (!link) {
    return { valid: false, reason: 'unknown' };
  }
  if (link.consumedAt) {
    return { valid: false, reason: 'consumed' };
  }
  if (link.expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }
  if (link.userDeletedAt) {
    return { valid: false, reason: 'inactive' };
  }

  return { valid: true, purpose: link.purpose };
}

/*
 * What a dead link says. An unknown token and a deleted account read the same
 * on purpose: a visitor who guesses tokens learns nothing about who exists,
 * and every message ends in the one thing that does help, asking again.
 */
const REJECTION_MESSAGES: Record<AccessLinkRejection, string> = {
  unknown:
    'This link is not valid. Ask an administrator for a new one, or request a password reset.',
  consumed:
    'This link has already been used. Sign in, or request a password reset if you have forgotten the password.',
  expired:
    'This link has expired. Ask an administrator for a new one, or request a password reset.',
  inactive:
    'This link is not valid. Ask an administrator for a new one, or request a password reset.',
};

export function accessLinkMessage(reason: AccessLinkRejection): string {
  return REJECTION_MESSAGES[reason];
}

/** The page that opens a link, on the web app's own origin. */
export function accessLinkUrl(webUrl: string, rawToken: string): string {
  return `${webUrl}/set-password?token=${encodeURIComponent(rawToken)}`;
}

/** The stored facts an invite status is read from. */
/**
 * Whether somebody can sign in with a password today. The credential rows are
 * the only record of it, and three decisions read them: whether an invite or a
 * reset is the right link to send, whether a forgotten-password request has
 * anything to reset, and what the admin console shows. They must agree, so they
 * ask here.
 */
export function hasCredentialPassword(
  credentials: readonly { password: string | null }[],
): boolean {
  return credentials.some((credential) => credential.password !== null);
}

export interface UserAccessFacts {
  /** Whether a usable credential exists; false for an invited or off-boarded user. */
  hasPassword: boolean;
  /** Their outstanding invite, when one was ever issued. */
  invite: { expiresAt: Date; consumedAt: Date | null } | null;
}

/**
 * How far a user is through getting in. Read from the credential and the
 * invite rather than stored, so it cannot disagree with either of them.
 */
export function inviteStatus(facts: UserAccessFacts, now: Date): InviteStatus {
  if (facts.hasPassword) {
    return 'active';
  }

  const live =
    facts.invite !== null &&
    facts.invite.consumedAt === null &&
    facts.invite.expiresAt.getTime() > now.getTime();

  return live ? 'pending' : 'expired';
}
