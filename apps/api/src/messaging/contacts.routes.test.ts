import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { MessagingContactService } from './contact.service.js';
import { contactRoutes } from './contacts.routes.js';

const routesUnderTest: FastifyPluginAsync = async (fastify) => {
  await fastify.register(withAuthenticatedUser(contactRoutes));
};

describe('contactRoutes', () => {
  let app: FastifyInstance;
  let listForUser: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    listForUser = vi
      .spyOn(MessagingContactService.prototype, 'listForUser')
      .mockResolvedValue({
        contacts: [],
        total: 0,
        page: 1,
        limit: 50,
        totalPages: 0,
      });

    app = await createApiRouteApp(routesUnderTest, { db: {} });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should list the contacts of the authenticated user', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contacts: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    });
    expect(listForUser).toHaveBeenCalledWith('user-1', {
      page: 1,
      limit: 50,
    });
  });

  test('should pass the paging and search terms through', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/?page=2&limit=10&search=%20Dana%20',
    });

    expect(response.statusCode).toBe(200);
    expect(listForUser).toHaveBeenCalledWith('user-1', {
      page: 2,
      limit: 10,
      search: 'Dana',
    });
  });

  test('should refuse a page size above the cap', async () => {
    const response = await app.inject({ method: 'GET', url: '/?limit=500' });

    expect(response.statusCode).toBe(400);
    expect(listForUser).not.toHaveBeenCalled();
  });
});
