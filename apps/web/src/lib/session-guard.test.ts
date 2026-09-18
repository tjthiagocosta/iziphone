import { describe, expect, test } from 'vitest';
import {
  loginNoticeFor,
  loginPathFor,
  requiresSession,
  safeRedirectTarget,
} from './session-guard';

describe('requiresSession', () => {
  test.each([
    '/',
    '/app',
    '/app/inbox',
    '/admin/users',
    '/settings/sessions',
    // A conversation id is not a file name, however much it looks like one.
    '/app/conversations/a.b',
    '/app/conversations/cm4x1.abc',
    // Sign-up is closed: nothing here is public just because it once was.
    '/register',
  ])('guards %s', (pathname) => {
    expect(requiresSession(pathname)).toBe(true);
  });

  test.each([
    '/login',
    '/forgot-password',
    // The invite and the reset both land here, and neither has a session yet.
    '/set-password',
    '/set-password?token=a-fictional-token',
    '/api/auth/callback',
    '/_next/static/chunk.js',
    '/favicon.ico',
    '/logo.svg',
    '/fonts/inter.woff2',
  ])('lets %s through', (pathname) => {
    expect(requiresSession(pathname)).toBe(false);
  });
});

describe('loginPathFor', () => {
  test('keeps the path as a query parameter', () => {
    expect(loginPathFor({ redirect: '/app/conversations/1' })).toBe(
      '/login?redirect=%2Fapp%2Fconversations%2F1',
    );
  });

  test('encodes a path that would otherwise change the target', () => {
    expect(loginPathFor({ redirect: '//evil.example.com' })).toBe(
      '/login?redirect=%2F%2Fevil.example.com',
    );
  });

  test('carries the reason the visitor lost the session', () => {
    expect(
      loginPathFor({ redirect: '/app/inbox', reason: 'session-expired' }),
    ).toBe('/login?redirect=%2Fapp%2Finbox&reason=session-expired');
  });

  test('is the bare login page when there is nothing to carry', () => {
    expect(loginPathFor()).toBe('/login');
  });
});

describe('loginNoticeFor', () => {
  test.each(['session-expired', 'sign-out-failed'])('explains %s', (reason) => {
    expect(loginNoticeFor(`?reason=${reason}`)).toEqual(expect.any(String));
  });

  test('tells the visitor the session may still be open after a failed sign out', () => {
    expect(loginNoticeFor('?reason=sign-out-failed')).toContain(
      'may still be open',
    );
  });

  test.each(['', '?redirect=%2Fapp', '?reason=made-up', '?reason=toString'])(
    'has nothing to say for %s',
    (search) => {
      expect(loginNoticeFor(search)).toBeNull();
    },
  );
});

describe('safeRedirectTarget', () => {
  test('accepts a local path', () => {
    expect(safeRedirectTarget('/app/inbox')).toBe('/app/inbox');
  });

  test('keeps the query and the fragment', () => {
    expect(safeRedirectTarget('/app/inbox?filter=unread#top')).toBe(
      '/app/inbox?filter=unread#top',
    );
  });

  test.each([
    null,
    '',
    'https://evil.example.com',
    '//evil.example.com',
    // The URL parser reads these backslashes as slashes, so each one names
    // another host even though it opens with a single `/`.
    '/\\evil.example.com',
    '/\\/evil.example.com',
    '/\\\\evil.example.com',
    '\\\\evil.example.com',
  ])('falls back to the home page for %j', (redirect) => {
    expect(safeRedirectTarget(redirect)).toBe('/');
  });

  test('strips an authority that points back at this origin', () => {
    expect(safeRedirectTarget('//localhost/app/inbox')).toBe('/app/inbox');
  });
});
