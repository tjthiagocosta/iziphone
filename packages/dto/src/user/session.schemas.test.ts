import { describe, expect, test } from 'vitest';
import {
  AuthMeResponseSchema,
  SessionListResponseSchema,
} from './session.schemas.js';

describe('AuthMeResponseSchema', () => {
  test('accepts the user the API answers with', () => {
    const parsed = AuthMeResponseSchema.parse({
      user: {
        id: 'user-1',
        email: 'agent@example.com',
        name: null,
        role: 'AGENT',
        emailVerified: false,
      },
    });

    expect(parsed.user.role).toBe('AGENT');
  });

  test('rejects a role outside the enum', () => {
    expect(
      AuthMeResponseSchema.safeParse({
        user: {
          id: 'user-1',
          email: 'agent@example.com',
          name: 'Agent',
          role: 'OWNER',
          emailVerified: true,
        },
      }).success,
    ).toBe(false);
  });
});

describe('SessionListResponseSchema', () => {
  test('accepts sessions with unknown client details', () => {
    const parsed = SessionListResponseSchema.parse({
      sessions: [
        {
          id: 'session-1',
          createdAt: '2026-09-08T10:00:00.000Z',
          expiresAt: '2026-09-15T10:00:00.000Z',
          ipAddress: null,
          userAgent: null,
          isCurrent: true,
        },
      ],
    });

    expect(parsed.sessions[0]?.isCurrent).toBe(true);
  });

  test('rejects a timestamp without a zone', () => {
    expect(
      SessionListResponseSchema.safeParse({
        sessions: [
          {
            id: 'session-1',
            createdAt: '2026-09-08 10:00',
            expiresAt: '2026-09-15T10:00:00.000Z',
            ipAddress: '203.0.113.10',
            userAgent: 'Browser',
            isCurrent: false,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
