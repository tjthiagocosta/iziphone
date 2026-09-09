import { NextRequest } from 'next/server';
import { describe, expect, test } from 'vitest';
import { loginPathFor, proxy, requiresSession } from './proxy';

function request(pathname: string, cookie?: string): NextRequest {
  return new NextRequest(`https://app.example.com${pathname}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

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

describe('proxy', () => {
  test.each([
    ['development', 'iziphone.session_token=a-session-token'],
    ['production', '__Secure-iziphone.session_token=a-session-token'],
  ])('lets a %s session through', (_environment, cookie) => {
    const response = proxy(request('/app/inbox', cookie));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  test('sends a visitor without a session to the login page', () => {
    const response = proxy(request('/app/inbox'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?redirect=%2Fapp%2Finbox',
    );
  });

  test('ignores a cookie that is not the session', () => {
    const response = proxy(request('/app', 'iziphone.other=value'));

    expect(response.status).toBe(307);
  });

  test('does not guard the login page itself', () => {
    expect(proxy(request('/login')).status).toBe(200);
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
