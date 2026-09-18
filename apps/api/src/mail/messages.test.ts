import { describe, expect, test } from 'vitest';
import { accessLinkEmail } from './messages.js';

const link = 'https://app.example.com/set-password?token=a-fictional-token';

describe('accessLinkEmail', () => {
  test('an invite says an account was created and carries the link', () => {
    const message = accessLinkEmail('INVITE', {
      to: 'ada@example.com',
      name: 'Ada Example',
      url: link,
      lifetime: '7 days',
    });

    expect(message.to).toBe('ada@example.com');
    expect(message.subject).toBe('Set up your phone system account');
    expect(message.text).toContain('Hello Ada Example,');
    expect(message.text).toContain(link);
    expect(message.text).toContain('expires in 7 days');
    expect(message.html).toContain(`<a href="${link}">`);
  });

  test('a reset says nothing has changed if it was not them', () => {
    const message = accessLinkEmail('RESET', {
      to: 'ada@example.com',
      name: 'ada@example.com',
      url: link,
      lifetime: '1 hour',
    });

    expect(message.subject).toBe('Reset your phone system password');
    expect(message.text).toContain('If it was not you, nothing has changed');
    expect(message.text).toContain('expires in 1 hour');
  });

  test('escapes a name that would otherwise close the markup', () => {
    const message = accessLinkEmail('INVITE', {
      to: 'ada@example.com',
      name: '<script>alert(1)</script>',
      url: link,
      lifetime: '7 days',
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    // The plain-text part is never parsed as markup, so it keeps the name.
    expect(message.text).toContain('<script>alert(1)</script>');
  });

  test('names no product, since the deployment picks its own', () => {
    const message = accessLinkEmail('INVITE', {
      to: 'ada@example.com',
      name: 'Ada',
      url: link,
      lifetime: '7 days',
    });

    expect(`${message.subject} ${message.text}`.toLowerCase()).not.toContain(
      'iziphone',
    );
  });
});
