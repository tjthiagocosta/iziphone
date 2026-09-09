import { Prisma, type PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import type { AuditLogService } from '../admin/index.js';
import { AdminServiceError } from '../admin/index.js';
import type { RoutingCacheService } from '../routing/index.js';
import { UserService } from './user.service.js';

const DIRECT_LINE = '+15555550101';

const log = { info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function fakeDb(tables: Record<string, unknown>): PrismaClient {
  const db: Record<string, unknown> = { ...tables };
  db.$transaction = async (run: (tx: unknown) => unknown) => run(db);
  return db as unknown as PrismaClient;
}

function buildService(tables: Record<string, unknown>) {
  const db = fakeDb(tables);
  const auditCreate = vi.fn(async () => undefined);
  const routingCache = {
    refreshPhoneNumbers: vi.fn(async () => undefined),
    refreshDepartment: vi.fn(async () => undefined),
  };
  const service = new UserService(
    db,
    log,
    { create: auditCreate } as unknown as AuditLogService,
    routingCache as unknown as RoutingCacheService,
  );

  return { service, db, auditCreate, routingCache };
}

function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('UserService', () => {
  test('should refresh the direct line when a phone number is assigned', async () => {
    const { service, db, auditCreate, routingCache } = buildService({
      user: { findUnique: vi.fn(async () => ({ id: 'user-1' })) },
      phoneNumber: {
        findUnique: vi.fn(async () => ({
          id: 'phone-1',
          phoneNumber: DIRECT_LINE,
          userId: null,
          departmentId: null,
        })),
        update: vi.fn(async () => ({})),
      },
    });

    const assigned = await service.assignPhoneNumber(
      'user-1',
      'phone-1',
      'admin-1',
    );

    expect(assigned).toBe(true);
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      DIRECT_LINE,
    ]);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.phone_number_assigned' }),
      db,
    );
  });

  test('should refuse a number that already belongs to someone', async () => {
    const { service, routingCache } = buildService({
      user: { findUnique: vi.fn(async () => ({ id: 'user-1' })) },
      phoneNumber: {
        findUnique: vi.fn(async () => ({
          id: 'phone-1',
          phoneNumber: DIRECT_LINE,
          userId: null,
          departmentId: 'dept-1',
        })),
      },
    });

    expect(
      await service.assignPhoneNumber('user-1', 'phone-1', 'admin-1'),
    ).toBe(false);
    expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
  });

  test('should refresh the direct line when a phone number is removed', async () => {
    const { service, routingCache } = buildService({
      phoneNumber: {
        findUnique: vi.fn(async () => ({
          id: 'phone-1',
          phoneNumber: DIRECT_LINE,
        })),
        update: vi.fn(async () => ({})),
      },
    });

    await service.removePhoneNumber('user-1', 'phone-1', 'admin-1');

    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      DIRECT_LINE,
    ]);
  });

  test('should refresh direct lines and ring groups when a user is deleted', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { service, routingCache } = buildService({
      user: {
        findUnique: vi.fn(async () => ({
          id: 'user-1',
          deletedAt: null,
          departments: [{ departmentId: 'dept-1' }, { departmentId: 'dept-2' }],
          phoneNumbers: [{ phoneNumber: DIRECT_LINE }],
        })),
        update: vi.fn(async () => ({})),
      },
      phoneNumber: { updateMany },
    });

    expect(await service.delete('user-1', 'admin-1')).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: null, status: 'RESERVED' }),
      }),
    );
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      DIRECT_LINE,
    ]);
    expect(routingCache.refreshDepartment.mock.calls).toEqual([
      ['dept-1'],
      ['dept-2'],
    ]);
  });

  test('should refresh the department when a user joins or leaves it', async () => {
    const { service, routingCache } = buildService({
      user: { findUnique: vi.fn(async () => ({ id: 'user-1' })) },
      department: {
        findUnique: vi.fn(async () => ({ id: 'dept-1', name: 'Support' })),
      },
      userDepartment: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ department: { name: 'Support' } }),
        create: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      },
    });

    expect(
      await service.assignDepartment('user-1', 'dept-1', 0, 'admin-1'),
    ).toBe(true);
    expect(await service.removeDepartment('user-1', 'dept-1', 'admin-1')).toBe(
      true,
    );
    expect(routingCache.refreshDepartment.mock.calls).toEqual([
      ['dept-1'],
      ['dept-1'],
    ]);
  });

  test('should activate assigned numbers on create and refresh them', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { service, routingCache } = buildService({
      user: {
        create: vi.fn(async () => ({ id: 'user-1' })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: 'user-1',
          email: 'new@example.com',
          name: 'New User',
          role: 'AGENT',
          emailVerified: false,
          image: null,
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
          updatedAt: new Date('2026-03-20T00:00:00.000Z'),
          deletedAt: null,
          departments: [
            {
              id: 'ud-1',
              departmentId: 'dept-1',
              order: 0,
              department: { id: 'dept-1', name: 'Support' },
            },
          ],
          phoneNumbers: [{ id: 'phone-1', phoneNumber: DIRECT_LINE }],
        })),
      },
      phoneNumber: { updateMany },
    });

    const user = await service.create(
      {
        email: 'new@example.com',
        name: 'New User',
        password: 'correct-horse-battery',
        role: 'AGENT',
        departmentIds: ['dept-1'],
        phoneNumberIds: ['phone-1'],
      },
      'admin-1',
    );

    expect(user.id).toBe('user-1');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1', status: 'ACTIVE' }),
      }),
    );
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      DIRECT_LINE,
    ]);
    expect(routingCache.refreshDepartment).toHaveBeenCalledWith('dept-1');
  });

  test('should report a duplicate email as a conflict', async () => {
    const { service } = buildService({
      user: {
        create: vi.fn(async () => {
          throw uniqueViolation();
        }),
      },
    });

    const attempt = service.create(
      {
        email: 'taken@example.com',
        name: 'Taken',
        password: 'correct-horse-battery',
        role: 'AGENT',
      },
      'admin-1',
    );

    await expect(attempt).rejects.toBeInstanceOf(AdminServiceError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 409 });
  });

  test('should report a duplicate email on update as a conflict', async () => {
    const { service } = buildService({
      user: {
        findUnique: vi.fn(async () => ({
          id: 'user-1',
          email: 'old@example.com',
          name: 'Old',
          role: 'AGENT',
        })),
        update: vi.fn(async () => {
          throw uniqueViolation();
        }),
      },
    });

    await expect(
      service.update('user-1', { email: 'taken@example.com' }, 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
