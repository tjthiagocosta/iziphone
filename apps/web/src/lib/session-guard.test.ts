import { describe, expect, test } from 'vitest';
import {
  loginPathFor,
  requiresSession,
  safeRedirectTarget,
} from './session-guard';

describe('requiresSession', () => {
  test.each(['/', '/app', '/app/inbox', '/admin/users', '/settings/sessions'])(
    'guards %s',
    (pathname) => {
      expect(requiresSession(pathname)).toBe(true);
    },
  );

  test.each([
    '/login',
    '/register',
    '/forgot-password',
    '/api/auth/callback',
    '/_next/static/chunk.js',
    '/favicon.ico',
    '/logo.svg',
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

  test.each([null, '', 'https://evil.example.com', '//evil.example.com'])(
    'falls back to the home page for %s',
    (redirect) => {
      expect(safeRedirectTarget(redirect)).toBe('/');
    },
  );
});
