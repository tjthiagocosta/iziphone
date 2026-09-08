import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageConversationService } from '../../services/messaging/message-conversation.service.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../../test/route-test-helpers.js';
import messageConversationRoutes from './message-conversations.js';

const routesUnderTest: FastifyPluginAsync = async (fastify) => {
  await fastify.register(withAuthenticatedUser(messageConversationRoutes));
};

describe('messageConversationRoutes', () => {
  let app: FastifyInstance;
  let listForUserSpy: ReturnType<typeof spyOn>;
  let getForUserSpy: ReturnType<typeof spyOn>;
  let markReadSpy: ReturnType<typeof spyOn>;
  let listMessagesSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    listForUserSpy = vi
      .spyOn(MessageConversationService.prototype, 'listForUser')
      .mockResolvedValue({
        conversations: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      });
    getForUserSpy = vi
      .spyOn(MessageConversationService.prototype, 'getForUser')
      .mockResolvedValue(null);
    markReadSpy = vi
      .spyOn(MessageConversationService.prototype, 'markRead')
      .mockResolvedValue(true);
    listMessagesSpy = vi
      .spyOn(MessageConversationService.prototype, 'listMessages')
      .mockResolvedValue({
        messages: [],
        hasMore: false,
      });

    app = await createApiRouteApp(routesUnderTest, { db: {} });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should list conversations for the authenticated user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(200);
    expect(listForUserSpy).toHaveBeenCalledWith('user-1', {
      page: 1,
      limit: 20,
    });
    expect(response.json()).toEqual({
      conversations: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
  });

  test('should reject invalid list queries', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/?limit=500',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Bad Request' });
    expect(listForUserSpy).not.toHaveBeenCalled();
  });

  test('should return 404 when a conversation does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/conversation-404',
    });

    expect(response.statusCode).toBe(404);
    expect(getForUserSpy).toHaveBeenCalledWith('user-1', 'conversation-404');
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Message conversation not found',
    });
  });

  test('should list messages for an accessible conversation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/conversation-1/messages?limit=10&beforeMessageId=message-2',
    });

    expect(response.statusCode).toBe(200);
    expect(listMessagesSpy).toHaveBeenCalledWith('user-1', 'conversation-1', {
      beforeMessageId: 'message-2',
      limit: 10,
    });
    expect(response.json()).toEqual({
      messages: [],
      hasMore: false,
    });
  });

  test('should return 404 for messages of an inaccessible conversation', async () => {
    listMessagesSpy.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'GET',
      url: '/conversation-403/messages',
    });

    expect(response.statusCode).toBe(404);
  });

  test('should mark a conversation as read', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/conversation-1/read',
    });

    expect(response.statusCode).toBe(204);
    expect(markReadSpy).toHaveBeenCalledWith('user-1', 'conversation-1');
  });
});
