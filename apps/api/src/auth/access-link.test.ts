import { describe, expect, test } from 'vitest';
import {
  accessLinkExpiry,
  accessLinkLifetimeMs,
  accessLinkLifetimeWords,
  accessLinkMessage,
  accessLinkUrl,
  accessLinkValidity,
  generateAccessToken,
  hasCredentialPassword,
  hashAccessToken,
  inviteStatus,
  type StoredAccessLink,
} from './access-link.js';

const NOW = new Date('2026-09-18T08:00:00.000Z');

function link(overrides: Partial<StoredAccessLink> = {}): StoredAccessLink {
  return {
    purpose: 'INVITE',
    expiresAt: new Date('2026-09-25T08:00:00.000Z'),
    consumedAt: null,
    userDeletedAt: null,
    ...overrides,
  };
}

describe('lifetimes', () => {
  test('an invite lives seven days and a reset one hour', () => {
    expect(accessLinkLifetimeMs('INVITE')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(accessLinkLifetimeMs('RESET')).toBe(60 * 60 * 1000);
    expect(accessLinkLifetimeWords('INVITE')).toBe('7 days');
    expect(accessLinkLifetimeWords('RESET')).toBe('1 hour');
  });

  test('the expiry is the lifetime after the moment it was issued', () => {
    expect(accessLinkExpiry('RESET', NOW).toISOString()).toBe(
      '2026-09-18T09:00:00.000Z',
    );
    expect(accessLinkExpiry('INVITE', NOW).toISOString()).toBe(
      '2026-09-25T08:00:00.000Z',
    );
  });
});

describe('tokens', () => {
  test('a token is 32 random bytes in the URL alphabet', () => {
    const token = generateAccessToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  test('two tokens differ', () => {
    expect(generateAccessToken()).not.toBe(generateAccessToken());
  });

  test('the hash is stable, and nothing of the token survives in it', () => {
    const token = 'a-fictional-token';
    expect(hashAccessToken(token)).toBe(hashAccessToken(token));
    expect(hashAccessToken(token)).not.toContain(token);
    expect(hashAccessToken(token)).not.toBe(hashAccessToken('another-token'));
  });
});

describe('accessLinkValidity', () => {
  test('a live, unused link of a live user is valid, and names its purpose', () => {
    expect(accessLinkValidity(link({ purpose: 'RESET' }), NOW)).toEqual({
      valid: true,
      purpose: 'RESET',
    });
  });

  test('a token nobody issued is unknown', () => {
    expect(accessLinkValidity(null, NOW)).toEqual({
      valid: false,
      reason: 'unknown',
    });
  });

  test('a link is single use', () => {
    expect(
      accessLinkValidity(
        link({ consumedAt: new Date('2026-09-18T07:00:00Z') }),
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'consumed' });
  });

  test('a link that has reached its expiry is dead, exactly at it', () => {
    expect(accessLinkValidity(link({ expiresAt: NOW }), NOW)).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect(
      accessLinkValidity(link({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)
        .valid,
    ).toBe(true);
  });

  test('an off-boarded user cannot be let back in by a link issued before', () => {
    expect(
      accessLinkValidity(
        link({ userDeletedAt: new Date('2026-09-17T12:00:00Z') }),
        NOW,
      ),
    ).toEqual({ valid: false, reason: 'inactive' });
  });

  test('a consumed link of a deleted user reads as consumed, not as an account', () => {
    expect(
      accessLinkValidity(
        link({
          consumedAt: new Date('2026-09-17T09:00:00Z'),
          userDeletedAt: new Date('2026-09-17T12:00:00Z'),
        }),
        NOW,
      ).valid,
    ).toBe(false);
  });
});

describe('accessLinkMessage', () => {
  test('an unknown token and a deleted account read the same', () => {
    expect(accessLinkMessage('unknown')).toBe(accessLinkMessage('inactive'));
  });

  test('every message tells the visitor what to do next', () => {
    for (const reason of [
      'unknown',
      'consumed',
      'expired',
      'inactive',
    ] as const) {
      expect(accessLinkMessage(reason)).toMatch(/reset|Sign in/);
    }
  });
});

describe('accessLinkUrl', () => {
  test('points at the web app and carries the token as one parameter', () => {
    expect(accessLinkUrl('https://app.example.com', 'a-token')).toBe(
      'https://app.example.com/set-password?token=a-token',
    );
  });

  test('encodes a token so no character of it can start a second parameter', () => {
    expect(accessLinkUrl('https://app.example.com', 'a+b/c=')).toBe(
      'https://app.example.com/set-password?token=a%2Bb%2Fc%3D',
    );
  });
});

describe('hasCredentialPassword', () => {
  test('an invited user, whose credential is still empty, has none', () => {
    expect(hasCredentialPassword([{ password: null }])).toBe(false);
  });

  test('an off-boarded user, whose credential rows are all empty, has none', () => {
    expect(hasCredentialPassword([])).toBe(false);
    expect(
      hasCredentialPassword([{ password: null }, { password: null }]),
    ).toBe(false);
  });

  test('one credential holding a hash is enough', () => {
    expect(
      hasCredentialPassword([{ password: null }, { password: 'a-hash' }]),
    ).toBe(true);
  });
});

describe('inviteStatus', () => {
  test('someone who has set a password is active, invite or no invite', () => {
    expect(inviteStatus({ hasPassword: true, invite: null }, NOW)).toBe(
      'active',
    );
    expect(
      inviteStatus(
        {
          hasPassword: true,
          invite: {
            expiresAt: new Date('2026-09-01T00:00:00Z'),
            consumedAt: null,
          },
        },
        NOW,
      ),
    ).toBe('active');
  });

  test('a live invite that nobody has used yet is pending', () => {
    expect(
      inviteStatus(
        {
          hasPassword: false,
          invite: {
            expiresAt: new Date('2026-09-25T08:00:00Z'),
            consumedAt: null,
          },
        },
        NOW,
      ),
    ).toBe('pending');
  });

  test('no password and no live invite is expired, and needs a new link', () => {
    expect(inviteStatus({ hasPassword: false, invite: null }, NOW)).toBe(
      'expired',
    );
    expect(
      inviteStatus(
        {
          hasPassword: false,
          invite: {
            expiresAt: new Date('2026-09-17T08:00:00Z'),
            consumedAt: null,
          },
        },
        NOW,
      ),
    ).toBe('expired');
  });

  test('an off-boarded user, whose credential was removed, reads as expired', () => {
    expect(
      inviteStatus(
        {
          hasPassword: false,
          invite: {
            expiresAt: new Date('2026-09-25T08:00:00Z'),
            consumedAt: new Date('2026-09-10T08:00:00Z'),
          },
        },
        NOW,
      ),
    ).toBe('expired');
  });
});
