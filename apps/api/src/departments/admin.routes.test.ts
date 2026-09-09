import type { DepartmentResponse } from '@repo/dto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AdminServiceError } from '../admin/index.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { adminDepartmentRoutes } from './admin.routes.js';
import { DepartmentService } from './department.service.js';

describe('adminDepartmentRoutes', () => {
  let app: FastifyInstance;
  let getByIdSpy: ReturnType<typeof vi.spyOn>;
  let createSpy: ReturnType<typeof vi.spyOn>;
  let updateSettingsSpy: ReturnType<typeof vi.spyOn>;
  let addHolidaySpy: ReturnType<typeof vi.spyOn>;
  let assignPhoneNumberSpy: ReturnType<typeof vi.spyOn>;
  let updateAgentOrderSpy: ReturnType<typeof vi.spyOn>;

  const department: DepartmentResponse = {
    id: 'dept-1',
    name: 'Support',
    description: null,
    settings: null,
    businessHours: [],
    holidays: [],
    agents: [],
    phoneNumbers: [],
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    deletedAt: null,
  };

  beforeEach(async () => {
    getByIdSpy = vi
      .spyOn(DepartmentService.prototype, 'getById')
      .mockResolvedValue(null);
    createSpy = vi
      .spyOn(DepartmentService.prototype, 'create')
      .mockResolvedValue(department);
    updateSettingsSpy = vi
      .spyOn(DepartmentService.prototype, 'updateSettings')
      .mockResolvedValue(false);
    addHolidaySpy = vi
      .spyOn(DepartmentService.prototype, 'addHoliday')
      .mockResolvedValue('holiday-1');
    assignPhoneNumberSpy = vi
      .spyOn(DepartmentService.prototype, 'assignPhoneNumber')
      .mockResolvedValue(false);
    updateAgentOrderSpy = vi
      .spyOn(DepartmentService.prototype, 'updateAgentOrder')
      .mockRejectedValue(
        new AdminServiceError(
          'User user-99 is not an agent of this department',
        ),
      );

    app = await createApiRouteApp(withAuthenticatedUser(adminDepartmentRoutes));
  });

  afterEach(async () => {
    getByIdSpy.mockRestore();
    createSpy.mockRestore();
    updateSettingsSpy.mockRestore();
    addHolidaySpy.mockRestore();
    assignPhoneNumberSpy.mockRestore();
    updateAgentOrderSpy.mockRestore();
    await app.close();
  });

  test('should return 404 when a department does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dept-404',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Department not found',
    });
  });

  test('should return a conflict when the service reports a duplicate name', async () => {
    createSpy.mockRejectedValueOnce(
      new AdminServiceError('A department with this name already exists', 409),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        name: 'Support',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Conflict',
      message: 'A department with this name already exists',
    });
  });

  test('should return 404 when updating settings for a missing department', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/dept-404/settings',
      payload: {
        timezone: 'America/Sao_Paulo',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Department not found',
    });
  });

  test('should create a holiday and return the new holiday id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/dept-1/holidays',
      payload: {
        name: 'Founders Day',
        date: '2026-12-25T00:00:00.000Z',
        isRecurring: true,
        routingType: 'VOICEMAIL',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: 'holiday-1',
    });
  });

  test('should return 400 when a phone number cannot be assigned to the department', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/dept-1/phone-numbers',
      payload: {
        phoneNumberId: 'phone-1',
        isPrimary: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message:
        'Could not assign phone number. Department may not exist or phone number may be unavailable.',
    });
  });

  test('should return 400 when the agent order names a user outside the department', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/dept-1/agents/order',
      payload: {
        agentOrder: [{ userId: 'user-99', order: 0 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'User user-99 is not an agent of this department',
    });
  });
});
