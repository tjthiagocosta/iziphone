import * as repoEvents from '@repo/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import {
  createApiRouteApp,
  defaultAuthUser,
} from '../test/route-test-helpers.js';
import { callRoutes } from './call.routes.js';

const agent: AuthUser = {
  id: 'user-7',
  email: 'agent@example.com',
  name: 'Agent Seven',
  role: 'AGENT',
  emailVerified: true,
};

const supervisor: AuthUser = { ...agent, id: 'user-8', role: 'SUPERVISOR' };

const include = {
  user: { select: { id: true, email: true } },
  department: { select: { id: true, name: true } },
  events: {
    where: { eventType: 'VOICEMAIL_COMPLETED' },
    select: { id: true },
    take: 1,
  },
};

const agentScope = {
  OR: [{ userId: 'user-7' }, { departmentId: { in: ['dept-1'] } }],
};

/** The columns of a call, as stored and as published. */
const callFields = {
  id: 'call-1',
  conversationUuid: 'conversation-1',
  callerLegUuid: 'leg-caller',
  agentLegUuid: 'leg-agent',
  externalLegUuid: null,
  from: '+15155550104',
  to: '+15155550101',
  status: 'completed',
  duration: 42,
  transcript: null,
  direction: 'inbound',
  provider: 'TWILIO' as const,
  userId: 'user-7',
  departmentId: 'dept-1',
  user: { id: 'user-7', email: 'agent@example.com' },
  department: { id: 'dept-1', name: 'Support' },
};

/** A row as Prisma hands it back: timestamps as dates, timeline included. */
const storedCall = {
  ...callFields,
  // Twilio's URL for the recording stays in the database.
  recordingUrl:
    'https://api.twilio.com/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Recordings/REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  events: [],
  createdAt: new Date('2026-03-20T00:00:00.000Z'),
  updatedAt: new Date('2026-03-20T00:04:12.000Z'),
};

/** The same call as the API publishes it. */
const callDto = {
  ...callFields,
  contact: null,
  line: null,
  hasVoicemail: false,
  createdAt: '2026-03-20T00:00:00.000Z',
  updatedAt: '2026-03-20T00:04:12.000Z',
};

describe('callRoutes', () => {
  let app: FastifyInstance;

  const hangup = vi.fn(async () => 1);
  const findMany = vi.fn(async (): Promise<unknown[]> => []);
  const count = vi.fn(async () => 0);
  const findFirst = vi.fn(async (): Promise<unknown> => null);
  const findContacts = vi.fn(async (): Promise<unknown[]> => []);
  const findLines = vi.fn(async (): Promise<unknown[]> => []);
  const findMemberships = vi.fn(async () => [{ departmentId: 'dept-1' }]);

  async function buildApp(user: AuthUser = defaultAuthUser) {
    vi.spyOn(repoEvents, 'createCommandPublisher').mockReturnValue({
      hangup,
    });

    return createApiRouteApp(callRoutes, {
      user,
      db: {
        call: { findMany, count, findFirst },
        contact: { findMany: findContacts },
        phoneNumber: { findMany: findLines },
        userDepartment: { findMany: findMemberships },
      },
      redis: {},
    });
  }

  beforeEach(async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);
    findFirst.mockResolvedValue(storedCall);
    findContacts.mockResolvedValue([]);
    findLines.mockResolvedValue([]);
    findMemberships.mockResolvedValue([{ departmentId: 'dept-1' }]);
    app = await buildApp(agent);
  });

  afterEach(async () => {
    await app.close();
  });

  test('publishes a hangup command for a call the agent can see', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/calls/conversation-1/hangup',
    });

    expect(response.statusCode).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationUuid: 'conversation-1', ...agentScope },
      include,
    });
    expect(hangup).toHaveBeenCalledWith({
      conversationUuid: 'conversation-1',
      initiatedBy: 'user-7',
    });
    expect(response.json()).toEqual({
      success: true,
      message: 'Hangup command sent',
    });
  });

  // Seeing a call in the history is not being on it. The softphone asks the
  // call controller, which checks the request against the live call.
  test.each([
    { action: 'hold', payload: { hold: true } },
    { action: 'transfer', payload: { targetUserId: 'user-2' } },
  ])('has no $action command any more', async ({ action, payload }) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/calls/conversation-1/${action}`,
      payload,
    });

    expect(response.statusCode).toBe(404);
    expect(findFirst).not.toHaveBeenCalled();
    expect(hangup).not.toHaveBeenCalled();
  });

  test('answers 404 to a command on a call outside the agent scope', async () => {
    findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/calls/conversation-9/hangup',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Call not found' });
    expect(hangup).not.toHaveBeenCalled();
  });

  test('lists only the calls in the agent scope with default pagination', async () => {
    findMany.mockResolvedValue([storedCall]);
    count.mockResolvedValue(1);

    const response = await app.inject({ method: 'GET', url: '/api/calls' });

    expect(response.statusCode).toBe(200);
    expect(findMemberships).toHaveBeenCalledWith({
      where: { userId: 'user-7' },
      select: { departmentId: true },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: agentScope,
      take: 50,
      skip: 0,
      orderBy: { createdAt: 'desc' },
      include,
    });
    expect(count).toHaveBeenCalledWith({ where: agentScope });
    expect(response.json()).toEqual({
      calls: [callDto],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  test('rejects a page size above the maximum', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/calls?limit=500',
    });

    expect(response.statusCode).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  test('lets a supervisor list and read every call', async () => {
    await app.close();
    app = await buildApp(supervisor);
    findMany.mockResolvedValue([storedCall]);
    count.mockResolvedValue(1);

    const list = await app.inject({
      method: 'GET',
      url: '/api/calls?limit=10&offset=20',
    });

    expect(list.statusCode).toBe(200);
    expect(findMemberships).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith({
      where: {},
      take: 10,
      skip: 20,
      orderBy: { createdAt: 'desc' },
      include,
    });

    const single = await app.inject({
      method: 'GET',
      url: '/api/calls/conversation-1',
    });

    expect(single.statusCode).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationUuid: 'conversation-1' },
      include,
    });
    expect(single.json()).toEqual(callDto);
  });

  test('answers 404 when a call record is outside the agent scope', async () => {
    findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/calls/missing-conversation',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Call not found' });
  });

  test('narrows the list to the calls of one conversation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/calls?linePhone=(515)%20555-0101&contactPhone=5155550104',
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          agentScope,
          { OR: [{ from: '+15155550101' }, { to: '+15155550101' }] },
          { OR: [{ from: '+15155550104' }, { to: '+15155550104' }] },
        ],
      },
      take: 50,
      skip: 0,
      orderBy: { createdAt: 'desc' },
      include,
    });
  });

  test('filters on a repeated status and a direction', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/calls?status=missed&status=no-answer&direction=inbound',
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            agentScope,
            { status: { in: ['missed', 'no-answer'] } },
            { direction: 'inbound' },
          ],
        },
      }),
    );
    expect(count).toHaveBeenCalledWith({
      where: {
        AND: [
          agentScope,
          { status: { in: ['missed', 'no-answer'] } },
          { direction: 'inbound' },
        ],
      },
    });
  });

  test.each([
    { name: 'a phone number that is not dialable', query: 'contactPhone=nope' },
    { name: 'a status the API never writes', query: 'status=on-hold' },
    { name: 'a direction outside the enum', query: 'direction=sideways' },
  ])('rejects $name', async ({ query }) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/calls?${query}`,
    });

    expect(response.statusCode).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  test('names the other party from the directory, on the far leg', async () => {
    findMany.mockResolvedValue([
      storedCall,
      { ...storedCall, id: 'call-2', direction: 'outbound' },
    ]);
    count.mockResolvedValue(2);
    findContacts.mockResolvedValue([
      {
        id: 'contact-1',
        name: 'Riverside Supply Co',
        phoneNumber: '+15155550104',
      },
    ]);

    const response = await app.inject({ method: 'GET', url: '/api/calls' });

    expect(response.statusCode).toBe(200);
    // The inbound call was dialled from the contact, the outbound one to our
    // own line, so only the first resolves to a contact.
    expect(findContacts).toHaveBeenCalledWith({
      where: { phoneNumber: { in: ['+15155550104', '+15155550101'] } },
      select: { id: true, name: true, phoneNumber: true },
    });
    expect(
      response.json().calls.map((call: { contact: unknown }) => call.contact),
    ).toEqual([
      {
        id: 'contact-1',
        name: 'Riverside Supply Co',
        phoneNumber: '+15155550104',
      },
      null,
    ]);
  });

  test('names the line from our own leg, whichever leg that is', async () => {
    findMany.mockResolvedValue([
      storedCall,
      { ...storedCall, id: 'call-2', direction: 'outbound' },
    ]);
    count.mockResolvedValue(2);
    findLines.mockResolvedValue([
      { id: 'number-1', phoneNumber: '+15155550101', label: 'Support' },
    ]);

    const response = await app.inject({ method: 'GET', url: '/api/calls' });

    expect(response.statusCode).toBe(200);
    // Which leg is ours flips with the direction, so the same pair of numbers
    // read as different lines: the second row's near leg is not one of ours.
    expect(findLines).toHaveBeenCalledWith({
      where: { phoneNumber: { in: ['+15155550101', '+15155550104'] } },
      select: { id: true, phoneNumber: true, label: true },
    });
    expect(
      response.json().calls.map((call: { line: unknown }) => call.line),
    ).toEqual([
      { id: 'number-1', phoneNumber: '+15155550101', label: 'Support' },
      null,
    ]);
  });

  test('still lists a row whose stored direction is not one the API writes', async () => {
    findMany.mockResolvedValue([{ ...storedCall, direction: 'internal' }]);
    count.mockResolvedValue(1);

    const response = await app.inject({ method: 'GET', url: '/api/calls' });

    expect(response.statusCode).toBe(200);
    expect(response.json().calls).toEqual([
      { ...callDto, direction: 'outbound' },
    ]);
  });
});
