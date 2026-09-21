import { describe, expect, test } from 'vitest';
import { ContactSchema } from './contact.schemas.js';

describe('ContactSchema', () => {
  /*
   * A contact is created by whoever messaged us, and a service messages from a
   * short code or from its own name. Demanding E.164 here would fail the whole
   * contacts response for everyone who shares the line.
   */
  test.each(['+15550100123', '55501', 'EXAMPLECO'])(
    'accepts the contact %j',
    (phoneNumber) => {
      const result = ContactSchema.safeParse({
        id: 'contact-1',
        name: null,
        phoneNumber,
        conversations: [
          {
            id: 'conv-1',
            sourcePhoneNumber: {
              id: 'phone-1',
              phoneNumber: '+15555550100',
              label: 'Support',
            },
            lastMessageAt: '2026-09-20T12:00:00.000Z',
            unreadCount: 1,
          },
        ],
      });

      expect(result.success).toBe(true);
    },
  );
});
