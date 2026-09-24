import type { MessageConversation, MessageSender } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import { sendEligibility } from './send-eligibility';
import { sendFailureFrom } from './send-failure';

const line: MessageConversation['sourcePhoneNumber'] = {
  id: 'number-1',
  phoneNumber: '+15155550101',
  label: 'Sales',
};

const sender: MessageSender = {
  id: 'number-1',
  phoneNumber: '+15155550101',
  label: 'Sales',
  ownerType: 'department',
  ownerId: 'dept-1',
  ownerName: 'Sales',
  isPrimary: true,
  smsEnabled: true,
  mmsEnabled: true,
};

const contact: MessageConversation['contact'] = {
  id: 'contact-1',
  name: null,
  phoneNumber: '+15155550123',
};

const owner: MessageConversation['owner'] = {
  type: 'department',
  id: 'dept-1',
  name: 'Sales',
};

const conversation = {
  contact,
  isSuppressed: false,
  owner,
  sourcePhoneNumber: line,
};

describe('sendEligibility', () => {
  test('allows a reply from a line the user sends on', () => {
    expect(sendEligibility(conversation, [sender])).toEqual({ canSend: true });
  });

  test('refuses a thread the user can only read', () => {
    // A department's conversation is visible to more people than may reply on
    // its number; the API answers 400 sender_mismatch, but only after typing.
    expect(sendEligibility(conversation, [])).toMatchObject({ canSend: false });
    expect(
      sendEligibility(conversation, [{ ...sender, id: 'number-9' }]),
    ).toMatchObject({ canSend: false });
  });

  test('refuses a contact who opted out, rather than letting the send 409', () => {
    expect(
      sendEligibility({ ...conversation, isSuppressed: true }, [sender]),
    ).toMatchObject({ canSend: false });
  });

  test('refuses a reply to a service that texts from a name', () => {
    // The provider has no address to route an answer to, so the composer has
    // to say so rather than offer a send that is certain to fail.
    const outcome = sendEligibility(
      { ...conversation, contact: { ...contact, phoneNumber: 'EXAMPLECO' } },
      [sender],
    );

    expect(outcome.canSend).toBe(false);
    expect(outcome.canSend === false && outcome.reason).toMatch(/replies/);
  });

  test('allows a reply to a short code', () => {
    expect(
      sendEligibility(
        { ...conversation, contact: { ...contact, phoneNumber: '55501' } },
        [sender],
      ),
    ).toEqual({ canSend: true });
  });

  test('refuses a thread from before the line changed hands', () => {
    // The line moved from Sales to Support and the reader is in both: they
    // still read Sales' thread and still send on the line, but a message now
    // belongs to Support's thread, which the API would otherwise refuse only
    // after typing.
    const outcome = sendEligibility(conversation, [
      { ...sender, ownerId: 'dept-2', ownerName: 'Support' },
    ]);

    expect(outcome.canSend).toBe(false);
    expect(outcome.canSend === false && outcome.reason).toMatch(
      /changed hands/,
    );
    expect(
      sendEligibility(conversation, [
        { ...sender, ownerType: 'user', ownerId: 'dept-1' },
      ]),
    ).toMatchObject({ canSend: false });
    expect(
      sendEligibility({ ...conversation, owner: null }, [sender]),
    ).toMatchObject({ canSend: false });
  });

  test('refuses a line that cannot text at all', () => {
    expect(
      sendEligibility(conversation, [{ ...sender, smsEnabled: false }]),
    ).toMatchObject({ canSend: false });
  });

  test('says why, so the composer can explain itself', () => {
    const outcome = sendEligibility(conversation, []);

    expect(outcome.canSend).toBe(false);
    expect(outcome.canSend === false && outcome.reason.length).toBeGreaterThan(
      0,
    );
  });
});

describe('sendFailureFrom', () => {
  test.each([409, 422, 502])('treats %d as already in the thread', (status) => {
    expect(sendFailureFrom(status, 'nope').persisted).toBe(true);
  });

  test.each([400, 404, 500])('treats %d as nothing stored', (status) => {
    expect(sendFailureFrom(status, 'nope').persisted).toBe(false);
  });

  test('passes the API message through for the reader', () => {
    expect(sendFailureFrom(422, 'Undeliverable').message).toBe('Undeliverable');
  });

  test('keeps the key of a draft already sent in a conversation out of sight', () => {
    const reason =
      'This message was already sent from this number, in a conversation you can no longer see; it was not sent again';

    expect(sendFailureFrom(400, reason)).toEqual({
      persisted: false,
      message: reason,
    });
  });
});
