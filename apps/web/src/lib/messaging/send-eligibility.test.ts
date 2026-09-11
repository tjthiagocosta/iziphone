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

const conversation = { isSuppressed: false, sourcePhoneNumber: line };

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
});
