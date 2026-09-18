import { describe, expect, test } from 'vitest';
import {
  contentSecurityPolicy,
  type SecurityHeaderOptions,
  securityHeaders,
} from './security-headers';

const production: SecurityHeaderOptions = {
  apiUrl: 'https://api.example.com',
  callControllerUrl: 'https://calls.example.com',
  isDevelopment: false,
};

/** The sources a named directive allows. */
function directive(policy: string, name: string): string[] {
  const found = policy
    .split('; ')
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) {
    throw new Error(`${name} is not in the policy`);
  }
  return found.split(' ').slice(1);
}

describe('contentSecurityPolicy', () => {
  test('allows the API and the call controller the browser is pointed at', () => {
    const sources = directive(contentSecurityPolicy(production), 'connect-src');

    expect(sources).toContain('https://api.example.com');
    expect(sources).toContain('https://calls.example.com');
  });

  test('allows the socket the call controller answers on', () => {
    expect(
      directive(contentSecurityPolicy(production), 'connect-src'),
    ).toContain('wss://calls.example.com');

    expect(
      directive(
        contentSecurityPolicy({
          ...production,
          callControllerUrl: 'http://localhost:3002',
        }),
        'connect-src',
      ),
    ).toContain('ws://localhost:3002');
  });

  test('allows the Twilio edges the voice SDK picks at runtime', () => {
    const policy = contentSecurityPolicy(production);

    expect(directive(policy, 'connect-src')).toEqual(
      expect.arrayContaining(['https://*.twilio.com', 'wss://*.twilio.com']),
    );
    // Ringtones from the SDK's CDN, and the remote track as a blob.
    expect(directive(policy, 'media-src')).toEqual(
      expect.arrayContaining(['blob:', 'https://sdk.twilio.com']),
    );
  });

  test('lets a voicemail be downloaded from the API and played as a blob', () => {
    const policy = contentSecurityPolicy(production);

    expect(directive(policy, 'connect-src')).toContain(
      'https://api.example.com',
    );
    expect(directive(policy, 'media-src')).toContain('blob:');
  });

  test('lets a department greeting play straight from the API', () => {
    const policy = contentSecurityPolicy(production);

    expect(directive(policy, 'media-src')).toContain('https://api.example.com');
    // Only the API serves audio; the call controller has no place there.
    expect(directive(policy, 'media-src')).not.toContain(
      'https://calls.example.com',
    );
  });

  test('lets no one frame the app and no one be framed by it', () => {
    const policy = contentSecurityPolicy(production);

    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(policy, 'frame-src')).toEqual(["'none'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
  });

  test('keeps a crafted page from redirecting a form or a relative URL off-site', () => {
    const policy = contentSecurityPolicy(production);

    expect(directive(policy, 'form-action')).toEqual(["'self'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'self'"]);
  });

  test('does not widen the policy for a URL it cannot read', () => {
    const policy = contentSecurityPolicy({
      ...production,
      apiUrl: 'not-a-url',
    });

    expect(directive(policy, 'connect-src')).not.toContain('not-a-url');
    expect(directive(policy, 'connect-src')).toContain(
      'https://calls.example.com',
    );
  });

  test('upgrades insecure requests in production only', () => {
    expect(contentSecurityPolicy(production)).toContain(
      'upgrade-insecure-requests',
    );
    expect(
      contentSecurityPolicy({ ...production, isDevelopment: true }),
    ).not.toContain('upgrade-insecure-requests');
  });

  test('does not upgrade the requests it just allowed over plain http', () => {
    expect(
      contentSecurityPolicy({
        ...production,
        callControllerUrl: 'http://calls.internal:3002',
      }),
    ).not.toContain('upgrade-insecure-requests');
  });

  test('only the dev server may evaluate code and reload over a socket', () => {
    const development = contentSecurityPolicy({
      ...production,
      isDevelopment: true,
    });

    expect(directive(development, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(development, 'connect-src')).toContain('ws://localhost:*');
    expect(
      directive(contentSecurityPolicy(production), 'script-src'),
    ).not.toContain("'unsafe-eval'");
  });
});

describe('securityHeaders', () => {
  test('sends the headers a browser without CSP still understands', () => {
    const byKey = new Map(
      securityHeaders(production).map(({ key, value }) => [key, value]),
    );

    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('Referrer-Policy')).toBe('same-origin');
  });

  test('keeps the microphone the softphone needs and nothing else', () => {
    const permissions = securityHeaders(production).find(
      ({ key }) => key === 'Permissions-Policy',
    );

    expect(permissions?.value).toContain('microphone=(self)');
    expect(permissions?.value).toContain('camera=()');
  });
});
