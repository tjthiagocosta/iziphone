import type { PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import type { AuditLogService } from '../admin/index.js';
import { AdminServiceError } from '../admin/index.js';
import type { RoutingCacheService } from '../routing/index.js';
import {
  type NumberProvider,
  PhoneNumberService,
} from './phone-number.service.js';

const NEW_LINE = '+15555550101';

const log = { info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function fakeDb(tables: Record<string, unknown>): PrismaClient {
  const db: Record<string, unknown> = { ...tables };
  db.$transaction = async (run: (tx: unknown) => unknown) => run(db);
  return db as unknown as PrismaClient;
}

function phoneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'phone-1',
    phoneNumber: NEW_LINE,
    friendlyName: '(555) 555-0101',
    type: 'LOCAL',
    label: null,
    provider: 'TWILIO',
    locality: null,
    region: null,
    country: 'US',
    voiceEnabled: true,
    smsEnabled: true,
    mmsEnabled: false,
    faxEnabled: false,
    status: 'RESERVED',
    isPrimary: false,
    userId: null,
    departmentId: null,
    createdAt: new Date('2026-03-23T00:00:00.000Z'),
    updatedAt: new Date('2026-03-23T00:00:00.000Z'),
    user: null,
    department: null,
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<NumberProvider> = {}) {
  return {
    searchAvailableNumbers: vi.fn(async () => ({ numbers: [] })),
    buyNumber: vi.fn(async () => undefined),
    configureNumber: vi.fn(async () => undefined),
    getOwnedNumberMetadata: vi.fn(async () => null),
    cancelNumber: vi.fn(async () => undefined),
    ...overrides,
  };
}

function buildService(
  tables: Record<string, unknown>,
  provider = fakeProvider(),
) {
  const db = fakeDb(tables);
  const auditCreate = vi.fn(async () => undefined);
  const routingCache = {
    refreshPhoneNumbers: vi.fn(async () => undefined),
    refreshDepartment: vi.fn(async () => undefined),
  };
  const service = new PhoneNumberService(
    db,
    log,
    { create: auditCreate } as unknown as AuditLogService,
    routingCache as unknown as RoutingCacheService,
    provider as unknown as NumberProvider,
  );

  return { service, db, auditCreate, routingCache, provider };
}

describe('PhoneNumberService.purchase', () => {
  test('should record the number before configuring it and promote a department first number to primary', async () => {
    const steps: string[] = [];
    const provider = fakeProvider({
      buyNumber: vi.fn(async () => {
        steps.push('buy');
      }),
      configureNumber: vi.fn(async () => {
        steps.push('configure');
      }),
      getOwnedNumberMetadata: vi.fn(async () => ({
        phoneNumber: NEW_LINE,
        friendlyName: '(555) 555-0101',
        type: 'LOCAL' as const,
        providerType: 'local' as const,
        locality: 'Example City',
        region: 'PA',
        country: 'US',
        voiceEnabled: true,
        smsEnabled: true,
        mmsEnabled: true,
        faxEnabled: false,
      })),
    });
    const create = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => {
        steps.push('create');
        return phoneRow({ ...data, id: 'phone-1' });
      },
    );
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      phoneRow({ ...data, id: 'phone-1', isPrimary: true, status: 'ACTIVE' }),
    );
    const { service, routingCache } = buildService(
      {
        department: { findUnique: vi.fn(async () => ({ id: 'dept-1' })) },
        phoneNumber: {
          count: vi.fn(async () => 0),
          updateMany: vi.fn(async () => ({ count: 0 })),
          create,
          update,
        },
      },
      provider,
    );

    const result = await service.purchase(
      {
        phoneNumber: NEW_LINE,
        country: 'US',
        type: 'LOCAL',
        departmentId: 'dept-1',
        isPrimary: false,
      },
      'admin-1',
    );

    expect(steps).toEqual(['buy', 'create', 'configure']);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phoneNumber: NEW_LINE,
          departmentId: 'dept-1',
          isPrimary: true,
          status: 'ACTIVE',
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          locality: 'Example City',
          mmsEnabled: true,
        }),
      }),
    );
    expect(result.isPrimary).toBe(true);
    expect(result.mmsEnabled).toBe(true);
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });

  test('should demote the current primary when the purchase asks for primary', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { service } = buildService({
      department: { findUnique: vi.fn(async () => ({ id: 'dept-1' })) },
      phoneNumber: {
        count: vi.fn(async () => 1),
        updateMany,
        create: vi.fn(async () => phoneRow({ isPrimary: true })),
        update: vi.fn(async () => phoneRow({ isPrimary: true })),
      },
    });

    await service.purchase(
      {
        phoneNumber: NEW_LINE,
        country: 'US',
        type: 'LOCAL',
        departmentId: 'dept-1',
        isPrimary: true,
      },
      'admin-1',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { departmentId: 'dept-1', deletedAt: null, isPrimary: true },
      data: { isPrimary: false },
    });
  });

  test('should reject an assignment to both a user and a department before buying', async () => {
    const { service, provider } = buildService({});

    await expect(
      service.purchase(
        {
          phoneNumber: NEW_LINE,
          country: 'US',
          type: 'LOCAL',
          userId: 'user-1',
          departmentId: 'dept-1',
          isPrimary: false,
        },
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(provider.buyNumber).not.toHaveBeenCalled();
  });

  test('should reject an unknown assignment target before buying', async () => {
    const { service, provider } = buildService({
      user: { findUnique: vi.fn(async () => null) },
    });

    await expect(
      service.purchase(
        {
          phoneNumber: NEW_LINE,
          country: 'US',
          type: 'LOCAL',
          userId: 'user-404',
          isPrimary: false,
        },
        'admin-1',
      ),
    ).rejects.toEqual(new AdminServiceError('User not found'));
    expect(provider.buyNumber).not.toHaveBeenCalled();
  });

  test('should not create a local record when the provider purchase fails', async () => {
    const create = vi.fn(async () => phoneRow());
    const { service } = buildService(
      { phoneNumber: { create } },
      fakeProvider({
        buyNumber: vi.fn(async () => {
          throw new Error('provider failed');
        }),
      }),
    );

    await expect(
      service.purchase(
        {
          phoneNumber: NEW_LINE,
          country: 'US',
          type: 'LOCAL',
          isPrimary: false,
        },
        'admin-1',
      ),
    ).rejects.toThrow('provider failed');
    expect(create).not.toHaveBeenCalled();
  });

  test('should flag a bought number that could not be recorded', async () => {
    const { service, provider } = buildService({
      phoneNumber: {
        create: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    });

    await expect(
      service.purchase(
        {
          phoneNumber: NEW_LINE,
          country: 'US',
          type: 'LOCAL',
          isPrimary: false,
        },
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(provider.configureNumber).not.toHaveBeenCalled();
  });
});

describe('PhoneNumberService.update', () => {
  test('should demote the other primary when promoting a number already in a department', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const { service, routingCache } = buildService({
      phoneNumber: {
        findUnique: vi.fn(async () =>
          phoneRow({ departmentId: 'dept-1', status: 'ACTIVE' }),
        ),
        updateMany,
        update: vi.fn(async () =>
          phoneRow({
            departmentId: 'dept-1',
            status: 'ACTIVE',
            isPrimary: true,
          }),
        ),
      },
    });

    const result = await service.update(
      'phone-1',
      { isPrimary: true },
      'admin-1',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        departmentId: 'dept-1',
        isPrimary: true,
        id: { not: 'phone-1' },
      },
      data: { isPrimary: false },
    });
    expect(result?.isPrimary).toBe(true);
    expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
  });

  test('should refresh routing when a number moves to a user', async () => {
    const update = vi.fn(async () =>
      phoneRow({ userId: 'user-1', status: 'ACTIVE' }),
    );
    const { service, routingCache } = buildService({
      user: { findUnique: vi.fn(async () => ({ id: 'user-1' })) },
      phoneNumber: {
        findUnique: vi.fn(async () =>
          phoneRow({
            departmentId: 'dept-1',
            status: 'ACTIVE',
            isPrimary: true,
          }),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update,
      },
    });

    await service.update('phone-1', { userId: 'user-1' }, 'admin-1');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          user: { connect: { id: 'user-1' } },
          department: { disconnect: true },
          isPrimary: false,
          status: 'ACTIVE',
        }),
      }),
    );
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });

  test('should reserve a number that is unassigned from everyone', async () => {
    const update = vi.fn(async () => phoneRow());
    const { service } = buildService({
      phoneNumber: {
        findUnique: vi.fn(async () =>
          phoneRow({ userId: 'user-1', status: 'ACTIVE' }),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update,
      },
    });

    await service.update('phone-1', { userId: null }, 'admin-1');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'RESERVED', isPrimary: false }),
      }),
    );
  });

  test('should reject a move to a department that does not exist', async () => {
    const { service } = buildService({
      department: { findUnique: vi.fn(async () => null) },
      phoneNumber: { findUnique: vi.fn(async () => phoneRow()) },
    });

    await expect(
      service.update('phone-1', { departmentId: 'dept-404' }, 'admin-1'),
    ).rejects.toEqual(new AdminServiceError('Department not found'));
  });

  test.each([
    {
      meanwhile: 'assigned to a department',
      read: phoneRow(),
      current: phoneRow({ departmentId: 'dept-2', status: 'ACTIVE' }),
      edit: { userId: 'user-1' },
    },
    {
      meanwhile: 'given to another user',
      read: phoneRow({ userId: 'user-2', status: 'ACTIVE' }),
      current: phoneRow({ userId: 'user-3', status: 'ACTIVE' }),
      edit: { label: 'Front desk' },
    },
    {
      meanwhile: 'taken from its department',
      read: phoneRow({ departmentId: 'dept-1', status: 'ACTIVE' }),
      current: phoneRow(),
      edit: { departmentId: 'dept-1', isPrimary: true },
    },
    {
      meanwhile: 'released',
      read: phoneRow(),
      current: phoneRow({
        status: 'RELEASED',
        deletedAt: new Date('2026-03-24T00:00:00.000Z'),
      }),
      edit: { userId: 'user-1' },
    },
  ])(
    'should refuse, and change nothing, when the number was $meanwhile during the edit',
    async ({ read, current, edit }) => {
      // A write matches the number as it is by now on every field it names,
      // and leaves unfiltered any field it does not name, as Prisma does.
      const now: Record<string, unknown> = { deletedAt: null, ...current };
      const updateMany = vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => ({
          count: Object.entries(where).every(
            ([field, value]) => now[field] === value,
          )
            ? 1
            : 0,
        }),
      );
      const update = vi.fn(async () => current);
      const { service, auditCreate, routingCache } = buildService({
        user: { findUnique: vi.fn(async () => ({ id: 'user-1' })) },
        department: { findUnique: vi.fn(async () => ({ id: 'dept-1' })) },
        phoneNumber: {
          findUnique: vi.fn(async () => read),
          updateMany,
          update,
        },
      });

      await expect(
        service.update('phone-1', edit, 'admin-1'),
      ).rejects.toMatchObject({
        statusCode: 409,
        message:
          'This number was assigned or released by somebody else in the meantime. Reload it and try again.',
      });
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
    },
  );
});

describe('PhoneNumberService.release', () => {
  test('should cancel with the provider before the local soft release and drop the routing entry', async () => {
    const steps: string[] = [];
    const provider = fakeProvider({
      cancelNumber: vi.fn(async () => {
        steps.push('cancel');
      }),
    });
    const { service, routingCache } = buildService(
      {
        phoneNumber: {
          findUnique: vi.fn(async () => ({
            id: 'phone-1',
            phoneNumber: NEW_LINE,
            country: null,
          })),
          update: vi.fn(async () => {
            steps.push('update');
            return {};
          }),
        },
      },
      provider,
    );

    expect(await service.release('phone-1', 'admin-1')).toBe(true);
    expect(steps).toEqual(['cancel', 'update']);
    expect(provider.cancelNumber).toHaveBeenCalledWith({
      country: 'US',
      phoneNumber: NEW_LINE,
    });
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });
});
