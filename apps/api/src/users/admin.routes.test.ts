import type {
  AccessLinkResponse,
  UserListResponse,
  UserResponse,
} from '@repo/dto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AdminServiceError } from '../admin/index.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { adminUserRoutes } from './admin.routes.js';
import { UserService } from './user.service.js';

describe('adminUserRoutes', () => {
  let app: FastifyInstance;
  let listSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let restoreSpy: ReturnType<typeof vi.spyOn>;
  let assignPhoneNumberSpy: ReturnType<typeof vi.spyOn>;
  let sendInviteSpy: ReturnType<typeof vi.spyOn>;
  let sendPasswordResetSpy: ReturnType<typeof vi.spyOn>;

  const listResult: UserListResponse = {
    users: [],
    total: 0,
    page: 2,
    limit: 5,
    totalPages: 0,
  };

  const sampleUser: UserResponse = {
    id: 'user-22',
    email: 'new@example.com',
    name: 'New User',
    role: 'AGENT',
    emailVerified: true,
    image: null,
    departments: [],
    phoneNumbers: [],
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    deletedAt: null,
    inviteStatus: 'pending',
  };

  const sampleInvite: AccessLinkResponse = {
    purpose: 'INVITE',
    url: 'https://app.example.com/set-password?token=a-fictional-token',
    expiresAt: '2026-03-27T00:00:00.000Z',
    emailSent: true,
    emailError: null,
  };

  beforeEach(async () => {
    listSpy = vi
      .spyOn(UserService.prototype, 'list')
      .mockResolvedValue(listResult);
    createSpy = vi
      .spyOn(UserService.prototype, 'create')
      .mockResolvedValue({ user: sampleUser, invite: sampleInvite });
    deleteSpy = vi
      .spyOn(UserService.prototype, 'delete')
      .mockResolvedValue(true);
    restoreSpy = vi
      .spyOn(UserService.prototype, 'restore')
      .mockResolvedValue(null);
    assignPhoneNumberSpy = vi
      .spyOn(UserService.prototype, 'assignPhoneNumber')
      .mockResolvedValue(false);
    sendInviteSpy = vi
      .spyOn(UserService.prototype, 'sendInvite')
      .mockResolvedValue(sampleInvite);
    sendPasswordResetSpy = vi
      .spyOn(UserService.prototype, 'sendPasswordReset')
      .mockResolvedValue({ ...sampleInvite, purpose: 'RESET' });

    app = await createApiRouteApp(withAuthenticatedUser(adminUserRoutes));
  });

  afterEach(async () => {
    listSpy.mockRestore();
    createSpy.mockRestore();
    deleteSpy.mockRestore();
    restoreSpy.mockRestore();
    assignPhoneNumberSpy.mockRestore();
    sendInviteSpy.mockRestore();
    sendPasswordResetSpy.mockRestore();
    await app.close();
  });

  test('should parse list query params and delegate to the user service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/?page=2&limit=5&role=ADMIN&includeDeleted=true',
    });

    expect(response.statusCode).toBe(200);
    expect(UserService.prototype.list).toHaveBeenCalledWith({
      page: 2,
      limit: 5,
      role: 'ADMIN',
      includeDeleted: true,
      deletedOnly: false,
    });
    expect(response.json()).toEqual(listResult);
  });

  test('creating a user answers with the invite link to pass on', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        email: 'New@Example.com',
        name: 'New User',
        role: 'AGENT',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user: sampleUser,
      invite: sampleInvite,
    });
    // Lowercased at the boundary: Better Auth looks addresses up in lower case.
    expect(UserService.prototype.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@example.com' }),
      'user-1',
      expect.any(String),
    );
  });

  test('ignores a password somebody puts in the create body', async () => {
    await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        email: 'new@example.com',
        name: 'New User',
        role: 'AGENT',
        password: 'a-fictional-passphrase',
      },
    });

    expect(UserService.prototype.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ password: expect.anything() }),
      'user-1',
      expect.any(String),
    );
  });

  test('resends an invite and answers with the new link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/user-22/invite',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(sampleInvite);
    expect(UserService.prototype.sendInvite).toHaveBeenCalledWith(
      'user-22',
      'user-1',
      expect.any(String),
    );
  });

  test('issues a reset link for a user who is locked out', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/user-22/password-reset',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ purpose: 'RESET' });
  });

  test.each(['invite', 'password-reset'])(
    'answers 404 when there is no such user to send a %s to',
    async (path) => {
      sendInviteSpy.mockResolvedValueOnce(null);
      sendPasswordResetSpy.mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'POST',
        url: `/user-404/${path}`,
      });

      expect(response.statusCode).toBe(404);
    },
  );

  test('passes on a conflict when the link does not suit that user', async () => {
    sendInviteSpy.mockRejectedValueOnce(
      new AdminServiceError('This user has already set a password', 409),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/user-22/invite',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Conflict',
      message: 'This user has already set a password',
    });
  });

  test('should return a conflict when the service reports a duplicate email', async () => {
    createSpy.mockRejectedValueOnce(
      new AdminServiceError('A user with this email already exists', 409),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        email: 'new@example.com',
        name: 'New User',
        role: 'AGENT',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Conflict',
      message: 'A user with this email already exists',
    });
  });

  test('should reject self-deletion requests before calling the service', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/user-1',
    });

    expect(response.statusCode).toBe(400);
    expect(UserService.prototype.delete).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Cannot delete your own account',
    });
  });

  test('restoring a user answers with the invite the admin has to pass on', async () => {
    restoreSpy.mockResolvedValue({ user: sampleUser, invite: sampleInvite });

    const response = await app.inject({
      method: 'POST',
      url: '/user-1/restore',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: expect.objectContaining({ id: sampleUser.id }),
      invite: sampleInvite,
    });
  });

  test('should return 404 when restoring a user that cannot be restored', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/user-404/restore',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'User not found or not deleted',
    });
  });

  test('should return 400 when assigning an unavailable phone number to a user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/user-22/phone-numbers',
      payload: {
        phoneNumberId: 'phone-1',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message:
        'Could not assign phone number. User may not exist or phone number may be unavailable.',
    });
  });
});
