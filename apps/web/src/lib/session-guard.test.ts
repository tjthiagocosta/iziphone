import { describe, expect, test } from 'vitest';
import {
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
  ])('guards %s', (pathname) => {
    expect(requiresSession(pathname)).toBe(true);
  });

  test.each([
    '/login',
    '/register',
    '/forgot-password',
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
    expect(loginPathFor('/app/conversations/1')).toBe(
      '/login?redirect=%2Fapp%2Fconversations%2F1',
    );
  });

  test('encodes a path that would otherwise change the target', () => {
    expect(loginPathFor('//evil.example.com')).toBe(
      '/login?redirect=%2F%2Fevil.example.com',
    );
  });
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
