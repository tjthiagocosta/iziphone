import type { PrismaClient } from '@repo/db';
import { describe, expect, test, vi } from 'vitest';
import { MessageActivityNotifier } from './activity-notifier.js';
import { MessageConversationService } from './conversation.service.js';
import { MessageSendService } from './send.service.js';
import { MessageSenderService } from './sender.service.js';
import type { MessagingTransportInboundEvent } from './transport.js';
import { MessageWebhookService } from './webhook.service.js';

/*
 * What happens to a line's text conversations when the line changes hands:
 * the history stays with whoever held the line when it was written, and the
 * line starts clean for its new owner.
 *
 * The messaging services run for real here, over an in-memory stand-in for
 * the handful of tables they touch. The stand-in keeps the two unique keys a
 * conversation has in the database (contact, line and user; contact, line and
 * department), NULLs included, so a thread that would be filed twice fails
 * here as it would there. Its find-or-create lets other work run between the
 * find and the create, so two that race for the same new thread both miss it
 * and the second create fails on the key, as a read then an insert would. An
 * administrator's change can also be slipped in right after a line is read,
 * where another transaction's commit would land.
 */

const LINE_ID = 'line-1';
const LINE = '+15555550142';
const CUSTOMER = '+15555550187';

const ALEX = 'user-alex';
const BLAIR = 'user-blair';
/** In Sales only. */
const DANA = 'user-dana';
/** In Support only. */
const ERIN = 'user-erin';
/** In both Sales and Support. */
const CASEY = 'user-casey';
const SALES = 'dept-sales';
const SUPPORT = 'dept-support';

type Owner = { userId: string } | { departmentId: string } | null;

describe('a line that changes hands', () => {
  test('from one user to another starts clean for the new user', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex, it is Morgan');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLine({ userId: BLAIR });
    world.published.length = 0;
    await world.receive('Hello again');

    const [blairThread] = await world.inbox(BLAIR);
    expect(blairThread?.id).not.toBe(alexThread?.id);
    expect(await world.thread(BLAIR, blairThread?.id)).toEqual(['Hello again']);
    expect(blairThread?.owner).toMatchObject({ type: 'user', id: BLAIR });

    // The new message is Blair's alone: Alex is not told, and their old
    // thread neither grows nor counts it as unread.
    expect(world.audiences()).toEqual([[BLAIR]]);
    const alexInbox = await world.inbox(ALEX);
    expect(alexInbox).toHaveLength(1);
    expect(alexInbox[0]).toMatchObject({ id: alexThread?.id, unreadCount: 1 });
    expect(await world.thread(ALEX, alexThread?.id)).toEqual([
      'Hi Alex, it is Morgan',
    ]);

    // Blair cannot open Alex's thread, and Alex cannot write from the line.
    expect(await world.thread(BLAIR, alexThread?.id)).toBeNull();
    expect(await world.reply(ALEX, alexThread?.id, 'Still here')).toMatchObject(
      { outcome: 'refused', reason: 'sender_not_found' },
    );
    expect(await world.reply(BLAIR, alexThread?.id, 'Hi')).toMatchObject({
      outcome: 'refused',
      reason: 'conversation_not_found',
    });
  });

  test('files the new owner’s first outbound message in their own thread', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLine({ userId: BLAIR });
    const started = await world.startMessage(BLAIR, 'Hi, this is Blair now');

    expect(started).toMatchObject({ outcome: 'sent' });
    const conversationId =
      started.outcome === 'sent' ? started.conversationId : null;
    expect(conversationId).not.toBe(alexThread?.id);
    expect(await world.thread(BLAIR, conversationId)).toEqual([
      'Hi, this is Blair now',
    ]);
    expect(await world.thread(ALEX, alexThread?.id)).toEqual(['Hi Alex']);

    // The customer's answer lands beside it, and Blair can go on replying.
    await world.receive('Thanks Blair');
    expect((await world.inbox(BLAIR)).map((thread) => thread.id)).toEqual([
      conversationId,
    ]);
    expect(await world.reply(BLAIR, conversationId, 'Any time')).toMatchObject({
      outcome: 'sent',
      conversationId,
    });
  });

  test('from one department to another leaves each department its own thread', async () => {
    const world = createWorld({ departmentId: SALES });
    await world.receive('Question for sales');
    const [salesThread] = await world.inbox(DANA);

    world.assignLine({ departmentId: SUPPORT });
    world.published.length = 0;
    await world.receive('Question for support');

    const [supportThread] = await world.inbox(ERIN);
    expect(supportThread?.id).not.toBe(salesThread?.id);
    expect(await world.thread(ERIN, supportThread?.id)).toEqual([
      'Question for support',
    ]);
    expect(await world.thread(ERIN, salesThread?.id)).toBeNull();
    expect(await world.thread(DANA, salesThread?.id)).toEqual([
      'Question for sales',
    ]);
    expect(await world.thread(DANA, supportThread?.id)).toBeNull();
    expect(world.audiences()).toEqual([[CASEY, ERIN]]);

    // Somebody in both departments reads both threads, and writes only in
    // the one that belongs to the line's owner now.
    expect(
      (await world.inbox(CASEY)).map((thread) => thread.id).sort(),
    ).toEqual([salesThread?.id, supportThread?.id].sort());
    expect(await world.reply(CASEY, salesThread?.id, 'Hi')).toMatchObject({
      outcome: 'refused',
      reason: 'line_reassigned',
    });
    expect(await world.reply(CASEY, supportThread?.id, 'Hi')).toMatchObject({
      outcome: 'sent',
    });
    expect(await world.thread(DANA, salesThread?.id)).toEqual([
      'Question for sales',
    ]);
  });

  test('from a user to a department keeps the user’s history theirs', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLine({ departmentId: SUPPORT });
    await world.receive('Hi support');

    const [supportThread] = await world.inbox(ERIN);
    expect(supportThread?.owner).toMatchObject({
      type: 'department',
      id: SUPPORT,
    });
    expect(await world.thread(ERIN, supportThread?.id)).toEqual(['Hi support']);
    expect(await world.thread(ERIN, alexThread?.id)).toBeNull();
    expect((await world.inbox(ALEX)).map((thread) => thread.id)).toEqual([
      alexThread?.id,
    ]);
    expect(await world.thread(ALEX, alexThread?.id)).toEqual(['Hi Alex']);
  });

  test('through a reserved spell receives nothing, then starts clean for its next owner', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLine(null, 'RESERVED');
    expect(await world.receive('Anyone there?')).toEqual({
      outcome: 'quarantined',
    });

    world.assignLine({ userId: BLAIR });
    await world.receive('Hello?');

    const [blairThread] = await world.inbox(BLAIR);
    expect(blairThread?.id).not.toBe(alexThread?.id);
    expect(await world.thread(BLAIR, blairThread?.id)).toEqual(['Hello?']);
    expect(await world.thread(ALEX, alexThread?.id)).toEqual(['Hi Alex']);
    expect(world.conversationCount()).toBe(2);
  });

  test('that is active but held by nobody files nothing', async () => {
    const world = createWorld(null);

    expect(await world.receive('Hello?')).toEqual({ outcome: 'quarantined' });
    expect(world.conversationCount()).toBe(0);
  });

  test('back to a previous owner picks up that owner’s own thread again', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('First');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLine({ userId: BLAIR });
    await world.receive('Second');
    world.assignLine({ userId: ALEX });
    await world.receive('Third');

    expect((await world.inbox(ALEX)).map((thread) => thread.id)).toEqual([
      alexThread?.id,
    ]);
    expect(await world.thread(ALEX, alexThread?.id)).toEqual([
      'Third',
      'First',
    ]);
    const [blairThread] = await world.inbox(BLAIR);
    expect(await world.thread(BLAIR, blairThread?.id)).toEqual(['Second']);
  });

  test('while a new message is being sent files it nowhere', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLineMidSend({ userId: BLAIR });
    const started = await world.startMessage(ALEX, 'Following up');

    // Alex was allowed to send when they pressed send, and no longer holds
    // the line when the message would be filed: neither Alex's thread nor a
    // new one of Blair's gets it, and nothing goes to the customer.
    expect(started).toMatchObject({
      outcome: 'refused',
      reason: 'line_reassigned',
    });
    expect(world.sent).toHaveLength(0);
    expect(await world.inbox(BLAIR)).toEqual([]);
    expect(await world.thread(ALEX, alexThread?.id)).toEqual(['Hi Alex']);
    expect(world.conversationCount()).toBe(1);
  });

  test('to nobody while a new message is being sent refuses it rather than failing', async () => {
    const world = createWorld({ departmentId: SALES });

    world.assignLineMidSend(null, 'RESERVED');
    const started = await world.startMessage(DANA, 'Hello');

    expect(started).toEqual({
      outcome: 'refused',
      reason: 'line_reassigned',
      detail: 'This number is no longer assigned to anyone; nothing was sent',
    });
    expect(world.sent).toHaveLength(0);
    expect(world.conversationCount()).toBe(0);
  });

  test('to nobody while a reply is being sent refuses it without pointing at a new conversation', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');
    const [alexThread] = await world.inbox(ALEX);

    // Nobody holds the line, so there is no owner a new conversation could
    // be started under either.
    world.assignLineMidSend(null, 'RESERVED');
    expect(await world.reply(ALEX, alexThread?.id, 'Still here')).toEqual({
      outcome: 'refused',
      reason: 'line_reassigned',
      detail: 'This number is no longer assigned to anyone; nothing was sent',
    });
    expect(world.sent).toHaveLength(0);
  });

  test('while a text is being filed keeps it with the owner it arrived under', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLineMidReceive({ userId: BLAIR });
    const received = await world.receive('One more thing');

    // The handover commits after the webhook has read the line as Alex's. The
    // text is filed with Alex, as that read said, rather than turned back to
    // the provider, which would not deliver it again.
    expect(received).toEqual({ outcome: 'processed' });
    expect(await world.thread(ALEX, alexThread?.id)).toEqual([
      'One more thing',
      'Hi Alex',
    ]);
    expect(await world.inbox(BLAIR)).toEqual([]);

    // The next text reads the line after the handover, and is Blair's.
    await world.receive('Hello?');
    const [blairThread] = await world.inbox(BLAIR);
    expect(await world.thread(BLAIR, blairThread?.id)).toEqual(['Hello?']);
    expect(world.conversationCount()).toBe(2);
  });

  test('after a send has read the line files the message with its writer', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');
    const [alexThread] = await world.inbox(ALEX);

    world.assignLineAfterSendReadsIt({ userId: BLAIR });
    const started = await world.startMessage(ALEX, 'Following up');

    // The line was Alex's as the send read it, so the message is Alex's: sent,
    // and filed in Alex's thread, never in one of Blair's.
    expect(started).toMatchObject({
      outcome: 'sent',
      conversationId: alexThread?.id,
    });
    expect(world.sent).toEqual(['Following up']);
    expect(await world.thread(ALEX, alexThread?.id)).toEqual([
      'Following up',
      'Hi Alex',
    ]);
    expect(await world.inbox(BLAIR)).toEqual([]);
  });

  test('keeps two texts that arrive together for the new owner in one thread', async () => {
    const world = createWorld({ userId: ALEX });
    await world.receive('Hi Alex');

    // The first texts after the handover both find no thread for Blair; one
    // creates it, the other loses on the key and is filed again beside it.
    world.assignLine({ userId: BLAIR });
    const results = await Promise.all([
      world.receive('Is anyone there?'),
      world.receive('Hello?'),
    ]);

    expect(results).toEqual([
      { outcome: 'processed' },
      { outcome: 'processed' },
    ]);
    const blairInbox = await world.inbox(BLAIR);
    expect(blairInbox).toHaveLength(1);
    expect((await world.thread(BLAIR, blairInbox[0]?.id))?.sort()).toEqual([
      'Hello?',
      'Is anyone there?',
    ]);
    expect(world.conversationCount()).toBe(2);
  });
});

/*
 * A send whose response was lost is sent again from the same draft, with the
 * same idempotency key. A handover in between moves new messages to another
 * thread, and the retry still has to find what its first attempt stored.
 */
describe('a send retried after the line changed hands', () => {
  test('answers a new message with the one its first attempt stored, and sends nothing twice', async () => {
    // Casey held the line personally and is also in Sales, which holds it now.
    const world = createWorld({ userId: CASEY });
    const first = await world.startMessage(CASEY, 'Hello', 'draft-lost');
    const firstThread = first.outcome === 'sent' ? first.conversationId : null;

    world.assignLine({ departmentId: SALES });
    const retry = await world.startMessage(CASEY, 'Hello', 'draft-lost');

    expect(retry).toMatchObject({
      outcome: 'deduplicated',
      conversationId: firstThread,
    });
    expect(world.sent).toEqual(['Hello']);
    expect(world.conversationCount()).toBe(1);

    // A new draft is a new message, and it goes to Sales' own thread.
    const next = await world.startMessage(CASEY, 'Hello from Sales');
    expect(next).toMatchObject({ outcome: 'sent' });
    expect(next.outcome === 'sent' && next.conversationId).not.toBe(
      firstThread,
    );
    expect(world.sent).toEqual(['Hello', 'Hello from Sales']);
  });

  test('never answers with a message from a thread the writer cannot see', async () => {
    // Two drafts can carry the same key. Alex's thread is not Blair's to be
    // told about, and Blair's message is theirs to send.
    const world = createWorld({ userId: ALEX });
    await world.startMessage(ALEX, 'From Alex', 'draft-shared');

    world.assignLine({ userId: BLAIR });
    const blair = await world.startMessage(BLAIR, 'From Blair', 'draft-shared');

    expect(blair).toMatchObject({ outcome: 'sent' });
    expect(world.sent).toEqual(['From Alex', 'From Blair']);
    expect(
      await world.thread(
        BLAIR,
        blair.outcome === 'sent' ? blair.conversationId : null,
      ),
    ).toEqual(['From Blair']);
  });

  test('answers a reply that was already sent instead of refusing it', async () => {
    const world = createWorld({ departmentId: SALES });
    await world.receive('Question');
    const [salesThread] = await world.inbox(CASEY);
    await world.reply(CASEY, salesThread?.id, 'Answer', 'draft-lost');

    world.assignLine({ departmentId: SUPPORT });

    expect(
      await world.reply(CASEY, salesThread?.id, 'Answer', 'draft-lost'),
    ).toMatchObject({
      outcome: 'deduplicated',
      conversationId: salesThread?.id,
    });
    expect(world.sent).toEqual(['Answer']);

    // Acknowledging the stored reply opens nothing: a new one in the old
    // thread is still refused.
    expect(
      await world.reply(CASEY, salesThread?.id, 'One more thing'),
    ).toMatchObject({ outcome: 'refused', reason: 'line_reassigned' });
    expect(world.sent).toEqual(['Answer']);
  });
});

// ---------------------------------------------------------------------------
// The world: the services wired over an in-memory database.
// ---------------------------------------------------------------------------

function createWorld(initialOwner: Owner) {
  const db = createDatabase();
  db.addUser(ALEX);
  db.addUser(BLAIR);
  db.addUser(DANA, [SALES]);
  db.addUser(ERIN, [SUPPORT]);
  db.addUser(CASEY, [SALES, SUPPORT]);
  db.addDepartment(SALES);
  db.addDepartment(SUPPORT);
  db.addLine(LINE_ID, LINE);
  db.setLineOwner(LINE_ID, initialOwner, 'ACTIVE');

  const client = db.client as unknown as PrismaClient;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const published: string[] = [];
  const conversationService = new MessageConversationService(client);
  let providerSequence = 0;

  const webhook = new MessageWebhookService({
    db: client,
    transport: {
      normalizeInboundEvent: (payload) =>
        payload as MessagingTransportInboundEvent,
      normalizeStatusEvent: () => {
        throw new Error('not used');
      },
    },
    conversationService,
    mediaService: { ingestInboundMedia: vi.fn() },
    activity: new MessageActivityNotifier({
      db: client,
      redis: {
        publish: async (_channel, message) => {
          published.push(message);
          return 1;
        },
      },
      log,
    }),
    log,
  });

  const sent: string[] = [];
  const send = new MessageSendService({
    db: client,
    transport: {
      sendSms: async (input) => {
        sent.push(input.text);
        return {
          outcome: 'accepted',
          provider: 'TWILIO',
          channel: 'SMS',
          providerMessageId: `SM${++providerSequence}`,
          clientReference: input.clientReference,
          requestId: null,
          request: {},
          response: {},
          responseHeaders: {},
        };
      },
      sendMms: () => {
        throw new Error('not used');
      },
    },
    senderService: new MessageSenderService(client),
    conversationService,
    mediaService: {
      getPreparedMediaForSend: vi.fn(),
      promotePreparedMediaToMessage: vi.fn(),
    },
    log,
  });

  let inboundSequence = 0;
  let draftSequence = 0;

  return {
    published,
    sent,
    audiences: () =>
      published.map((message) =>
        [...(JSON.parse(message) as { userIds: string[] }).userIds].sort(),
      ),
    conversationCount: () => db.conversationCount(),
    messageCount: () => db.messageCount(),
    assignLine: (owner: Owner, status: 'ACTIVE' | 'RESERVED' = 'ACTIVE') =>
      db.setLineOwner(LINE_ID, owner, status),
    /**
     * Reassigns the line once the next send has checked its sender, just
     * before its transaction starts: the widest gap an administrator's change
     * can fall into.
     */
    assignLineMidSend: (
      owner: Owner,
      status: 'ACTIVE' | 'RESERVED' = 'ACTIVE',
    ) =>
      db.beforeNextTransaction(() => db.setLineOwner(LINE_ID, owner, status)),
    /**
     * Reassigns the line right after the next inbound text has looked it up,
     * before the text is filed.
     */
    assignLineMidReceive: (owner: Owner) =>
      db.afterNextLineRead(() => db.setLineOwner(LINE_ID, owner, 'ACTIVE')),
    /**
     * Reassigns the line right after the next send's transaction has read it,
     * before the message is filed.
     */
    assignLineAfterSendReadsIt: (owner: Owner) =>
      db.beforeNextTransaction(() =>
        db.afterNextLineRead(() => db.setLineOwner(LINE_ID, owner, 'ACTIVE')),
      ),
    receive: (body: string) =>
      webhook.processInboundEvent({
        provider: 'TWILIO',
        channel: 'SMS',
        providerMessageId: `SMinbound${++inboundSequence}`,
        providerTimestamp: new Date().toISOString(),
        from: CUSTOMER,
        to: LINE,
        body,
        keyword: null,
        media: [],
        rawPayload: {},
      } satisfies MessagingTransportInboundEvent),
    inbox: async (userId: string) =>
      (await conversationService.listForUser(userId, { page: 1, limit: 20 }))
        .conversations,
    thread: async (
      userId: string,
      conversationId: string | undefined | null,
    ) => {
      const page = await conversationService.listMessages(
        userId,
        conversationId ?? 'missing',
        { limit: 50 },
      );
      return page ? page.messages.map((message) => message.body) : null;
    },
    /** A reply from a new draft, or from `draft` again to retry it. */
    reply: (
      userId: string,
      conversationId: string | undefined | null,
      body: string,
      draft = `draft-${++draftSequence}`,
    ) =>
      send.sendSms(userId, {
        fromPhoneNumberId: LINE_ID,
        conversationId: conversationId ?? 'missing',
        body,
        idempotencyKey: draft,
      }),
    /** A new message from a new draft, or from `draft` again to retry it. */
    startMessage: (
      userId: string,
      body: string,
      draft = `draft-${++draftSequence}`,
    ) =>
      send.sendSms(userId, {
        fromPhoneNumberId: LINE_ID,
        to: CUSTOMER,
        body,
        idempotencyKey: draft,
      }),
  };
}

// ---------------------------------------------------------------------------
// The in-memory database: only the queries the messaging services make.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

interface Tables {
  user: Row[];
  department: Row[];
  userDepartment: Row[];
  phoneNumber: Row[];
  contact: Row[];
  messageConversation: Row[];
  message: Row[];
  messageProviderEvent: Row[];
}

type TableName = keyof Tables;

function createDatabase() {
  const tables: Tables = {
    user: [],
    department: [],
    userDepartment: [],
    phoneNumber: [],
    contact: [],
    messageConversation: [],
    message: [],
    messageProviderEvent: [],
  };
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;
  // Strictly increasing, so "newest first" is never a tie.
  let clock = Date.parse('2026-09-01T12:00:00.000Z');
  const now = () => {
    clock += 1000;
    return new Date(clock);
  };

  const byId = (table: TableName, id: unknown) =>
    tables[table].find((row) => row.id === id) ?? null;

  /** Relations a `where` can walk, per table. */
  const relations: Partial<
    Record<
      TableName,
      Record<string, (row: Row) => [TableName, Row | Row[] | null]>
    >
  > = {
    phoneNumber: {
      department: (row) => ['department', byId('department', row.departmentId)],
      user: (row) => ['user', byId('user', row.userId)],
    },
    department: {
      users: (row) => [
        'userDepartment',
        tables.userDepartment.filter((m) => m.departmentId === row.id),
      ],
    },
    userDepartment: {
      department: (row) => ['department', byId('department', row.departmentId)],
      user: (row) => ['user', byId('user', row.userId)],
    },
    messageConversation: {
      contact: (row) => ['contact', byId('contact', row.contactId)],
      messages: (row) => [
        'message',
        tables.message.filter((m) => m.conversationId === row.id),
      ],
    },
  };

  function matches(
    table: TableName,
    row: Row,
    where: Where | undefined,
  ): boolean {
    if (!where) {
      return true;
    }

    return Object.entries(where).every(([key, condition]) => {
      if (condition === undefined) {
        return true;
      }
      if (key === 'OR') {
        return (condition as Where[]).some((w) => matches(table, row, w));
      }
      if (key === 'AND') {
        return (condition as Where[]).every((w) => matches(table, row, w));
      }

      const relation = relations[table]?.[key];
      if (relation) {
        const [relatedTable, related] = relation(row);
        const nested = condition as Where;
        if (Array.isArray(related)) {
          if (nested.some) {
            return related.some((r) =>
              matches(relatedTable, r, nested.some as Where),
            );
          }
          throw new Error(`Unsupported list filter on ${table}.${key}`);
        }
        return related !== null && matches(relatedTable, related, nested);
      }

      return matchesValue(row[key], condition);
    });
  }

  function matchesValue(value: unknown, condition: unknown): boolean {
    if (
      condition === null ||
      typeof condition !== 'object' ||
      condition instanceof Date
    ) {
      return value === condition;
    }

    return Object.entries(condition as Record<string, unknown>).every(
      ([operator, operand]) => {
        switch (operator) {
          case 'not':
            return operand === null ? value !== null : value !== operand;
          case 'in':
            return (operand as unknown[]).includes(value);
          case 'gt':
            return (value as number) > (operand as number);
          default:
            throw new Error(`Unsupported operator ${operator}`);
        }
      },
    );
  }

  function uniqueViolation(index: string) {
    return Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: {
        driverAdapterError: {
          cause: { constraint: { index } },
        },
      },
    });
  }

  /** The two unique keys a conversation has; NULLs never collide. */
  function assertConversationKeys(candidate: Row) {
    for (const owner of ['userId', 'departmentId'] as const) {
      if (candidate[owner] === null) {
        continue;
      }
      const clash = tables.messageConversation.some(
        (row) =>
          row.contactId === candidate.contactId &&
          row.sourcePhoneNumberId === candidate.sourcePhoneNumberId &&
          row[owner] === candidate[owner],
      );
      if (clash) {
        throw uniqueViolation(`message_conversations_${owner}_key`);
      }
    }
  }

  /** A conversation with every relation any caller selects. */
  function conversationView(row: Row) {
    const user = byId('user', row.userId);
    const department = byId('department', row.departmentId);
    const line = byId('phoneNumber', row.sourcePhoneNumberId);
    const latest = tables.message
      .filter((message) => message.conversationId === row.id)
      .sort(newestFirst)
      .slice(0, 1)
      .map((message) => ({ ...message, attachments: [] }));

    return {
      ...row,
      contact: byId('contact', row.contactId),
      sourcePhoneNumber: line && {
        id: line.id,
        phoneNumber: line.phoneNumber,
        label: line.label,
        userId: line.userId,
        departmentId: line.departmentId,
      },
      user,
      department: department && {
        ...department,
        users: tables.userDepartment
          .filter(
            (m) =>
              m.departmentId === department.id &&
              byId('user', m.userId)?.deletedAt === null,
          )
          .map((m) => ({ userId: m.userId })),
      },
      messages: latest,
    };
  }

  function newestFirst(a: Row, b: Row) {
    return (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
  }

  function applyUpdate(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) {
        continue;
      }
      if (
        value !== null &&
        typeof value === 'object' &&
        'increment' in (value as Row)
      ) {
        row[key] = (row[key] as number) + ((value as Row).increment as number);
      } else {
        row[key] = value;
      }
    }
    row.updatedAt = now();
  }

  let beforeNextTransaction: (() => void) | null = null;
  let afterNextLineRead: (() => void) | null = null;

  /** A copy of a line as read, then whatever was set to happen after it. */
  function readLine(row: Row | null | undefined) {
    const copy = row ? { ...row } : null;
    const interleaved = afterNextLineRead;
    afterNextLineRead = null;
    interleaved?.();
    return copy;
  }

  const client = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const interleaved = beforeNextTransaction;
      beforeNextTransaction = null;
      interleaved?.();
      return work(client);
    },
    userDepartment: {
      findMany: async ({ where }: { where: Where }) =>
        tables.userDepartment.filter((row) =>
          matches('userDepartment', row, where),
        ),
    },
    // Copies, as a query returns: a sender loaded before the line changes
    // hands must not change with it.
    phoneNumber: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        readLine(byId('phoneNumber', where.id)),
      findFirst: async ({ where }: { where: Where }) =>
        readLine(
          tables.phoneNumber.find((line) =>
            matches('phoneNumber', line, where),
          ),
        ),
    },
    contact: {
      findUnique: async ({ where }: { where: { phoneNumber: string } }) =>
        tables.contact.find((row) => row.phoneNumber === where.phoneNumber) ??
        null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId('contact'), name: null, ...data };
        tables.contact.push(row);
        return row;
      },
    },
    messageConversation: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = byId('messageConversation', where.id);
        return row && conversationView(row);
      },
      findFirst: async ({ where }: { where: Where }) => {
        const row = tables.messageConversation.find((candidate) =>
          matches('messageConversation', candidate, where),
        );
        return row ? { ...row } : null;
      },
      findMany: async ({ where }: { where: Where }) =>
        tables.messageConversation
          .filter((row) => matches('messageConversation', row, where))
          .sort(
            (a, b) =>
              ((b.lastMessageAt as Date | null)?.getTime() ?? 0) -
              ((a.lastMessageAt as Date | null)?.getTime() ?? 0),
          )
          .map(conversationView),
      count: async ({ where }: { where: Where }) =>
        tables.messageConversation.filter((row) =>
          matches('messageConversation', row, where),
        ).length,
      upsert: async ({
        where,
        create,
      }: {
        where: Record<string, Row>;
        create: Row;
      }) => {
        const [key] = Object.values(where);
        if (Object.keys(where).length !== 1 || !key) {
          throw new Error('Expected one unique key');
        }
        const existing = tables.messageConversation.find((row) =>
          Object.entries(key).every(([field, value]) => row[field] === value),
        );
        if (existing) {
          return conversationView(existing);
        }
        // Whatever else is running gets its turn between the miss and the
        // insert, as another transaction would.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const row: Row = {
          id: nextId('conversation'),
          unreadCount: 0,
          lastReadAt: null,
          lastMessageAt: null,
          createdAt: now(),
          updatedAt: now(),
          ...create,
        };
        assertConversationKeys(row);
        tables.messageConversation.push(row);
        return conversationView(row);
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = byId('messageConversation', where.id);
        if (!row) {
          throw new Error('Conversation not found');
        }
        applyUpdate(row, data);
        return row;
      },
    },
    message: {
      create: async ({ data }: { data: Row }) => {
        const row: Row = {
          id: nextId('message'),
          providerMessageId: null,
          clientReference: null,
          failureCode: null,
          failureReason: null,
          sentAt: null,
          deliveredAt: null,
          failedAt: null,
          createdAt: now(),
          ...data,
        };
        tables.message.push(row);
        return { ...row, attachments: [] };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = byId('message', where.id);
        if (!row) {
          throw new Error('Message not found');
        }
        applyUpdate(row, data);
        return { ...row, attachments: [] };
      },
      findUnique: async ({
        where,
      }: {
        where: { conversationId_clientReference: Row };
      }) => {
        const key = where.conversationId_clientReference;
        const row = tables.message.find(
          (message) =>
            message.conversationId === key.conversationId &&
            message.clientReference === key.clientReference,
        );
        return row ? { ...row, attachments: [] } : null;
      },
      findMany: async ({
        where,
        take,
      }: {
        where: { conversationId: string };
        take: number;
      }) =>
        tables.message
          .filter((row) => row.conversationId === where.conversationId)
          .sort(newestFirst)
          .slice(0, take)
          .map((row) => ({ ...row, attachments: [] })),
    },
    messageSuppression: {
      findMany: async () => [],
      findFirst: async () => null,
    },
    messageProviderEvent: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId('event'), ...data };
        tables.messageProviderEvent.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = byId('messageProviderEvent', where.id);
        if (row) {
          applyUpdate(row, data);
        }
        return row;
      },
    },
  };

  return {
    client,
    conversationCount: () => tables.messageConversation.length,
    messageCount: () => tables.message.length,
    /** Runs `action` just before the next transaction begins. */
    beforeNextTransaction(action: () => void) {
      beforeNextTransaction = action;
    },
    /** Runs `action` right after the next read of a line has returned. */
    afterNextLineRead(action: () => void) {
      afterNextLineRead = action;
    },
    addUser(id: string, departmentIds: string[] = []) {
      tables.user.push({
        id,
        name: id.replace('user-', ''),
        email: `${id.replace('user-', '')}@example.com`,
        deletedAt: null,
      });
      for (const departmentId of departmentIds) {
        tables.userDepartment.push({ userId: id, departmentId });
      }
    },
    addDepartment(id: string) {
      tables.department.push({
        id,
        name: id.replace('dept-', ''),
        deletedAt: null,
      });
    },
    addLine(id: string, phoneNumber: string) {
      tables.phoneNumber.push({
        id,
        phoneNumber,
        label: 'Main line',
        isPrimary: false,
        smsEnabled: true,
        mmsEnabled: false,
        deletedAt: null,
        status: 'ACTIVE',
        userId: null,
        departmentId: null,
      });
    },
    setLineOwner(id: string, owner: Owner, status: 'ACTIVE' | 'RESERVED') {
      const line = byId('phoneNumber', id);
      if (!line) {
        throw new Error('Line not found');
      }
      line.userId = owner && 'userId' in owner ? owner.userId : null;
      line.departmentId =
        owner && 'departmentId' in owner ? owner.departmentId : null;
      line.status = status;
    },
  };
}
