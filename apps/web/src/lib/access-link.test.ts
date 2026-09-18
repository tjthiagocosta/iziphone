import type { AccessLinkResponse } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  accessLinkExpiryWords,
  accessLinkNotice,
  accessTokenFromSearch,
  inviteStatusLabel,
  inviteStatusTone,
  needsInvite,
  passwordProblem,
  setPasswordCopy,
} from './access-link';

const link: AccessLinkResponse = {
  purpose: 'INVITE',
  url: 'https://app.example.com/set-password?token=a-fictional-token',
  expiresAt: '2026-09-25T12:00:00.000Z',
  emailSent: true,
  emailError: null,
};

describe('accessTokenFromSearch', () => {
  test('reads the token out of the query string', () => {
    expect(accessTokenFromSearch('?token=a-fictional-token')).toBe(
      'a-fictional-token',
    );
  });

  test('decodes a token with URL characters in it', () => {
    expect(accessTokenFromSearch('?token=abc%2Fdef-_')).toBe('abc/def-_');
  });

  test.each(['', '?', '?token=', '?other=a-fictional-token'])(
    'has nothing to work with in %j',
    (search) => {
      expect(accessTokenFromSearch(search)).toBeNull();
    },
  );
});

describe('setPasswordCopy', () => {
  test('greets an invited person differently from one who forgot their password', () => {
    expect(setPasswordCopy('INVITE').heading).not.toBe(
      setPasswordCopy('RESET').heading,
    );
  });

  test('warns a reset that other devices are signed out', () => {
    expect(setPasswordCopy('RESET').intro).toMatch(/signs out/);
  });
});

describe('passwordProblem', () => {
  test('accepts a long enough password that was typed twice', () => {
    expect(
      passwordProblem('a-fictional-passphrase', 'a-fictional-passphrase'),
    ).toBeNull();
  });

  test('asks for a password when there is none', () => {
    expect(passwordProblem('', '')).toMatch(/Choose a password/);
  });

  test('asks for more characters before complaining about the second box', () => {
    expect(passwordProblem('short', 'short')).toMatch(/at least 8/);
  });

  test('catches a mistyped confirmation', () => {
    expect(
      passwordProblem('a-fictional-passphrase', 'a-fictional-passphrasf'),
    ).toMatch(/do not match/);
  });
});

describe('invite status', () => {
  test.each([
    ['pending', 'Invited'],
    ['expired', 'Invite expired'],
    ['active', 'Active'],
  ] as const)('%s reads as %s', (status, label) => {
    expect(inviteStatusLabel(status)).toBe(label);
  });

  test('only an expired invite is alarming', () => {
    expect(inviteStatusTone('expired')).toBe('destructive');
    expect(inviteStatusTone('active')).toBe('outline');
    expect(inviteStatusTone('pending')).toBe('secondary');
  });

  test('a user who never set a password needs an invite, not a reset', () => {
    expect(needsInvite('pending')).toBe(true);
    expect(needsInvite('expired')).toBe(true);
    expect(needsInvite('active')).toBe(false);
  });
});

describe('accessLinkNotice', () => {
  test('says the invite went out and can still be copied', () => {
    expect(accessLinkNotice(link)).toMatch(/emailed/);
    expect(accessLinkNotice(link)).toMatch(/copy/);
  });

  test('says why it did not go out, so the admin passes it on', () => {
    expect(
      accessLinkNotice({
        ...link,
        emailSent: false,
        emailError: 'Email is not configured',
      }),
    ).toBe(
      'The invite was not emailed (Email is not configured), so copy it below and pass it on yourself.',
    );
  });

  test('names a reset link as a reset link', () => {
    expect(accessLinkNotice({ ...link, purpose: 'RESET' })).toMatch(
      /reset link/,
    );
  });
});

describe('accessLinkExpiryWords', () => {
  test.each([
    ['2026-09-18T12:00:00.000Z', 'It works once, within 7 days.'],
    ['2026-09-24T12:00:00.000Z', 'It works once, within 1 day.'],
    ['2026-09-25T10:30:00.000Z', 'It works once, within 1 hour.'],
    ['2026-09-25T11:58:30.000Z', 'It works once, within 1 minute.'],
    ['2026-09-25T11:59:59.900Z', 'It works once, within 1 minute.'],
  ])('at %s it reads %s', (now, expected) => {
    expect(accessLinkExpiryWords(link, new Date(now))).toBe(expected);
  });

  test('says so once the link is past its expiry', () => {
    expect(
      accessLinkExpiryWords(link, new Date('2026-09-25T12:00:00.000Z')),
    ).toBe('This link has expired.');
  });
});
