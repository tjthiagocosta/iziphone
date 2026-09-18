import {
  type AccessLinkResponse,
  type InviteStatus,
  PASSWORD_MIN_LENGTH,
  type SetPasswordPurpose,
} from '@repo/dto';

/*
 * The rules behind the pages and the admin actions that hand out access links:
 * what a link page is called, whether the two password boxes agree, how far a
 * user is through getting in, and what to tell an admin who has just issued a
 * link. No React and no fetching here, so each rule can be read and tested on
 * its own.
 */

/** The token the set-password page was opened with, or null when there is none. */
export function accessTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('token');
  return token && token.length > 0 ? token : null;
}

interface SetPasswordCopy {
  heading: string;
  intro: string;
  submitLabel: string;
}

const COPY: Record<SetPasswordPurpose, SetPasswordCopy> = {
  INVITE: {
    heading: 'Set up your account',
    intro: 'Choose a password to finish setting up your account.',
    submitLabel: 'Set password and sign in',
  },
  RESET: {
    heading: 'Choose a new password',
    intro:
      'Choose a new password. Setting it signs out every other device you are signed in on.',
    submitLabel: 'Save password and sign in',
  },
};

export function setPasswordCopy(purpose: SetPasswordPurpose): SetPasswordCopy {
  return COPY[purpose];
}

/** What the page says while it has not yet asked the API about the link. */
export const SET_PASSWORD_CHECKING = 'Checking this link...';

/** What it says when the URL carries no token at all, so the API is not asked. */
export const SET_PASSWORD_NO_TOKEN =
  'This link is incomplete. Open the link from your email again, or ask an administrator for a new one.';

/**
 * Why the password cannot be submitted, and null when it can. The API validates
 * it too; this is only so the person is told before the round trip.
 */
export function passwordProblem(
  password: string,
  confirmation: string,
): string | null {
  if (password.length === 0) {
    return 'Choose a password.';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (confirmation !== password) {
    return 'The two passwords do not match.';
  }

  return null;
}

/** The one answer the forgot-password page gives, whoever asked. */
export const FORGOT_PASSWORD_CONFIRMATION =
  'If that address belongs to an account, a reset link is on its way. It expires shortly, so use it soon; ask an administrator if it does not arrive.';

const STATUS_LABELS: Record<InviteStatus, string> = {
  pending: 'Invited',
  expired: 'Invite expired',
  active: 'Active',
};

export function inviteStatusLabel(status: InviteStatus): string {
  return STATUS_LABELS[status];
}

/** Which badge an invite status wears; `outline` for the ordinary case. */
export function inviteStatusTone(
  status: InviteStatus,
): 'outline' | 'secondary' | 'destructive' {
  switch (status) {
    case 'active':
      return 'outline';
    case 'pending':
      return 'secondary';
    case 'expired':
      return 'destructive';
  }
}

/** Whether this user's next link is an invite rather than a reset. */
export function needsInvite(status: InviteStatus): boolean {
  return status !== 'active';
}

/** What an admin who has just been handed a link needs to know about it. */
export function accessLinkNotice(link: AccessLinkResponse): string {
  const what = link.purpose === 'INVITE' ? 'invite' : 'reset link';

  return link.emailSent
    ? `The ${what} was emailed. You can also copy it below and pass it on yourself.`
    : `The ${what} was not emailed${
        link.emailError ? ` (${link.emailError})` : ''
      }, so copy it below and pass it on yourself.`;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long the link in front of the admin is still good for. Read from the
 * expiry the API sent rather than from a lifetime repeated here, so the two
 * cannot disagree.
 */
export function accessLinkExpiryWords(
  link: AccessLinkResponse,
  now: Date = new Date(),
): string {
  const remaining = new Date(link.expiresAt).getTime() - now.getTime();

  if (Number.isNaN(remaining) || remaining <= 0) {
    return 'This link has expired.';
  }

  if (remaining >= DAY_MS) {
    return `It works once, within ${plural(Math.floor(remaining / DAY_MS), 'day')}.`;
  }

  if (remaining >= HOUR_MS) {
    return `It works once, within ${plural(Math.floor(remaining / HOUR_MS), 'hour')}.`;
  }

  return `It works once, within ${plural(Math.max(1, Math.floor(remaining / MINUTE_MS)), 'minute')}.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
