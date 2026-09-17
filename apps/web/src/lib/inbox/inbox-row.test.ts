import type { CallRecord, MessageConversationListItem } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import { callInboxItem, conversationInboxItem } from './inbox-item';
import { inboxRow } from './inbox-row';

const call: CallRecord = {
  id: 'call-1',
  conversationUuid: 'conversation-1',
  callerLegUuid: null,
  agentLegUuid: null,
  externalLegUuid: null,
  from: '+15155550104',
  to: '+15155550101',
  status: 'completed',
  duration: 125,
  transcript: null,
  direction: 'inbound',
  provider: 'TWILIO',
  userId: null,
  departmentId: null,
  user: null,
  department: null,
  contact: null,
  line: null,
  hasVoicemail: false,
  createdAt: '2026-03-20T10:00:00.000Z',
  updatedAt: '2026-03-20T10:00:00.000Z',
};

const conversation: MessageConversationListItem = {
  id: 'conversation-a',
  contact: {
    id: 'contact-1',
    name: 'Jordan Blake',
    phoneNumber: '+15155550105',
  },
  sourcePhoneNumber: {
    id: 'number-1',
    phoneNumber: '+15155550101',
    label: 'Sales',
  },
  owner: null,
  unreadCount: 2,
  lastReadAt: null,
  lastMessageAt: '2026-03-20T09:00:00.000Z',
  lastMessagePreview: 'Hey, can you call me back?',
  lastMessageDirection: 'INBOUND',
  lastMessageStatus: 'DELIVERED',
  isSuppressed: false,
  createdAt: '2026-03-19T09:00:00.000Z',
  updatedAt: '2026-03-20T09:00:00.000Z',
};

function rowForCall(overrides: Partial<CallRecord> = {}) {
  const item = callInboxItem({ ...call, ...overrides });
  if (!item) throw new Error('The call has no place on the inbox');
  return inboxRow(item);
}

function rowForConversation(
  overrides: Partial<MessageConversationListItem> = {},
) {
  const item = conversationInboxItem({ ...conversation, ...overrides });
  if (!item) throw new Error('The conversation has no place on the inbox');
  return inboxRow(item);
}

describe('inboxRow for a call', () => {
  test('names the other party, whichever leg the direction puts them on', () => {
    expect(rowForCall().title).toBe('(515) 555-0104');
    expect(rowForCall({ direction: 'outbound' }).title).toBe('(515) 555-0101');
  });

  test('prefers the directory name and keys the avatar on the contact', () => {
    const row = rowForCall({
      contact: {
        id: 'contact-9',
        name: 'Riverside Supply Co',
        phoneNumber: '+15155550104',
      },
    });

    expect(row.title).toBe('Riverside Supply Co');
    expect(row.name).toBe('Riverside Supply Co');
    expect(row.identity).toBe('contact-9');
  });

  test('names the line the way a message row on it is named', () => {
    // The label first, so the same line does not read as two: a message row
    // shows the label and a call row used to show only the digits.
    expect(
      rowForCall({
        line: { id: 'number-1', phoneNumber: '+15155550101', label: 'Sales' },
      }).line,
    ).toBe('Sales');
  });

  test('names an unlabelled line by its department, then by its number', () => {
    expect(rowForCall().line).toBe('(515) 555-0101');
    expect(
      rowForCall({ department: { id: 'dept-1', name: 'Sales' } }).line,
    ).toBe('Sales');
  });

  test('offers a call back rather than a thread it cannot identify', () => {
    expect(rowForCall()).toMatchObject({
      href: null,
      callBack: { number: '+15155550104', line: '+15155550101' },
    });
  });

  test('calls back from the line the call was on, whichever way it went', () => {
    // Outbound, our line is `from` and the other party is `to`.
    expect(
      rowForCall({
        direction: 'outbound',
        from: '+15155550101',
        to: '+15155550104',
      }).callBack,
    ).toEqual({ number: '+15155550104', line: '+15155550101' });
  });

  test('calls a voicemail one, rather than a missed call with a file', () => {
    const row = rowForCall({
      status: 'no-answer',
      hasVoicemail: true,
      duration: 30,
    });

    expect(row).toMatchObject({
      icon: 'voicemail',
      preview: 'Voicemail · 0:30',
    });
    expect(rowForCall({ status: 'no-answer' }).icon).toBe('missed');
    expect(rowForCall().icon).toBe('call');
  });

  test('previews the direction and length, or that nobody picked up', () => {
    expect(rowForCall().preview).toBe('Inbound · 2:05');
    expect(rowForCall({ direction: 'outbound', duration: null }).preview).toBe(
      'Outbound',
    );
    expect(rowForCall({ status: 'no-answer' }).preview).toBe('Missed call');
  });
});

describe('inboxRow for a conversation', () => {
  test('opens the thread and shows which line it is on', () => {
    expect(rowForConversation()).toMatchObject({
      title: 'Jordan Blake',
      identity: 'contact-1',
      line: 'Sales',
      href: '/app/conversations/conversation-a',
      callBack: null,
      unreadCount: 2,
    });
  });

  test('falls back to the number for an unlabelled line and unnamed contact', () => {
    const row = rowForConversation({
      contact: { id: 'contact-1', name: null, phoneNumber: '+15155550105' },
      sourcePhoneNumber: {
        id: 'number-1',
        phoneNumber: '+15155550101',
        label: null,
      },
    });

    expect(row.title).toBe('(515) 555-0105');
    expect(row.line).toBe('(515) 555-0101');
    // With no name the avatar shows the end of the number, as Dialpad does.
    expect(row).toMatchObject({ name: null, fallback: '05' });
  });

  test('marks our own last message so a reply is not read as theirs', () => {
    expect(
      rowForConversation({ lastMessageDirection: 'OUTBOUND' }).preview,
    ).toBe('You: Hey, can you call me back?');
  });
});
