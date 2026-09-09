import { Prisma, type PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import type { AuditLogService } from '../admin/index.js';
import { AdminServiceError } from '../admin/index.js';
import type { RoutingCacheService } from '../routing/index.js';
import { DepartmentService } from './department.service.js';

const MAIN_LINE = '+15555550101';
const SECOND_LINE = '+15555550102';

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
  const service = new DepartmentService(
    db,
    log,
    { create: auditCreate } as unknown as AuditLogService,
    routingCache as unknown as RoutingCacheService,
  );

  return { service, db, auditCreate, routingCache };
}

describe('DepartmentService', () => {
  test('should release the numbers of a deleted department and refresh them', async () => {
    const updateMany = vi.fn(async () => ({ count: 2 }));
    const { service, routingCache } = buildService({
      department: {
        findUnique: vi.fn(async () => ({
          id: 'dept-1',
          deletedAt: null,
          phoneNumbers: [
            { phoneNumber: MAIN_LINE },
            { phoneNumber: SECOND_LINE },
          ],
        })),
        update: vi.fn(async () => ({})),
      },
      phoneNumber: { updateMany },
    });

    expect(await service.delete('dept-1', 'admin-1')).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          departmentId: null,
          status: 'RESERVED',
        }),
      }),
    );
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      MAIN_LINE,
      SECOND_LINE,
    ]);
    expect(routingCache.refreshDepartment).toHaveBeenCalledWith('dept-1');
  });

  test('should demote the current primary when assigning a new primary number', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { service, db, auditCreate, routingCache } = buildService({
      department: { findUnique: vi.fn(async () => ({ id: 'dept-1' })) },
      phoneNumber: {
        findUnique: vi.fn(async () => ({
          id: 'phone-2',
          phoneNumber: SECOND_LINE,
          userId: null,
          departmentId: null,
        })),
        updateMany,
        update: vi.fn(async () => ({})),
      },
    });

    expect(
      await service.assignPhoneNumber('dept-1', 'phone-2', true, 'admin-1'),
    ).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { departmentId: 'dept-1', isPrimary: true },
      data: { isPrimary: false },
    });
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      SECOND_LINE,
    ]);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'department.phone_number_assigned' }),
      db,
    );
  });

  test('should refresh a number removed from the department', async () => {
    const { service, routingCache } = buildService({
      phoneNumber: {
        findUnique: vi.fn(async () => ({
          id: 'phone-1',
          phoneNumber: MAIN_LINE,
        })),
        update: vi.fn(async () => ({})),
      },
    });

    expect(
      await service.removePhoneNumber('dept-1', 'phone-1', 'admin-1'),
    ).toBe(true);
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([MAIN_LINE]);
  });

  test('should refresh the department when an agent is added or removed', async () => {
    const { service, routingCache } = buildService({
      department: { findUnique: vi.fn(async () => ({ id: 'dept-1' })) },
      user: {
        findUnique: vi.fn(async () => ({ id: 'user-1', name: 'Agent One' })),
      },
      userDepartment: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'ud-1' }),
        create: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      },
    });

    expect(
      await service.addAgent(
        'dept-1',
        { userId: 'user-1', order: 0 },
        'admin-1',
      ),
    ).toBe(true);
    expect(await service.removeAgent('dept-1', 'user-1', 'admin-1')).toBe(true);
    expect(routingCache.refreshDepartment.mock.calls).toEqual([
      ['dept-1'],
      ['dept-1'],
    ]);
  });

  test('should reject an agent order that names a user outside the department', async () => {
    const update = vi.fn(async () => ({}));
    const { service, routingCache } = buildService({
      department: { findUnique: vi.fn(async () => ({ id: 'dept-1' })) },
      userDepartment: {
        findMany: vi.fn(async () => [{ userId: 'user-1' }]),
        update,
      },
    });

    await expect(
      service.updateAgentOrder(
        'dept-1',
        {
          agentOrder: [
            { userId: 'user-1', order: 0 },
            { userId: 'user-99', order: 1 },
          ],
        },
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(update).not.toHaveBeenCalled();
    expect(routingCache.refreshDepartment).not.toHaveBeenCalled();
  });

  test('should refresh the department after settings change', async () => {
    const { service, routingCache } = buildService({
      department: { findUnique: vi.fn(async () => ({ id: 'dept-1' })) },
      departmentSettings: { update: vi.fn(async () => ({})) },
    });

    expect(
      await service.updateSettings(
        'dept-1',
        { timezone: 'America/Sao_Paulo' },
        'admin-1',
      ),
    ).toBe(true);
    expect(routingCache.refreshDepartment).toHaveBeenCalledWith('dept-1');
  });

  test('should report a duplicate name as a conflict', async () => {
    const { service } = buildService({
      department: {
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed',
            { code: 'P2002', clientVersion: 'test' },
          );
        }),
      },
    });

    const attempt = service.create({ name: 'Support' }, 'admin-1');

    await expect(attempt).rejects.toBeInstanceOf(AdminServiceError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 409 });
  });
});
