import { Prisma, type PrismaClient } from '@repo/db';
import type { ImportPhoneNumber, PurchasePhoneNumber } from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, type Mock, test, vi } from 'vitest';
import type { AuditLogService } from '../admin/index.js';
import { AdminServiceError } from '../admin/index.js';
import type { RoutingCacheService } from '../routing/index.js';
import {
  type NumberProvider,
  PhoneNumberService,
} from './phone-number.service.js';
import { ReleaseRefusedError, TwilioProviderError } from './twilio-numbers.js';

const NEW_LINE = '+15555550101';
const OTHER_LINE = '+15555550102';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

type Row = Record<string, unknown> & { id: string };

const USERS: Row[] = [
  { id: 'user-alex', name: 'Alex Example', email: 'alex@example.com' },
  { id: 'user-blair', name: null, email: 'blair@example.com' },
];
const DEPARTMENTS: Row[] = [
  { id: 'dept-sales', name: 'Sales' },
  { id: 'dept-support', name: 'Support' },
];

function phoneRow(overrides: Record<string, unknown> = {}): Row {
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
    deletedAt: null,
    createdAt: new Date('2026-03-23T00:00:00.000Z'),
    updatedAt: new Date('2026-03-23T00:00:00.000Z'),
    ...overrides,
  };
}

/** Equality, `null`, `{ not }` and `{ in }`: all the filters the service writes. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (
      expected !== null &&
      typeof expected === 'object' &&
      'not' in expected
    ) {
      return row[key] !== expected.not;
    }
    if (
      expected !== null &&
      typeof expected === 'object' &&
      'in' in expected &&
      Array.isArray(expected.in)
    ) {
      return expected.in.includes(row[key]);
    }

    return (row[key] ?? null) === expected;
  });
}

/**
 * The `phone_numbers` table as the service uses it, with the user and
 * department relations it includes, so tests read who holds a number after
 * the fact instead of which calls were made.
 */
function fakePhoneNumbers(initial: Row[]) {
  const rows = initial.map((row) => ({ ...row }));
  const withRelations = (row: Row) => ({
    ...row,
    user: USERS.find((user) => user.id === row.userId) ?? null,
    department:
      DEPARTMENTS.find((dept) => dept.id === row.departmentId) ?? null,
  });
  const find = (where: Record<string, unknown>) =>
    rows.find((row) => matches(row, where)) ?? null;

  return {
    rows,
    table: {
      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          const row = find(where);
          return row ? withRelations(row) : null;
        },
      ),
      findUniqueOrThrow: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          const row = find(where);
          if (!row) throw new Error('not found');
          return withRelations(row);
        },
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)).map(withRelations),
      ),
      count: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((row) => matches(row, where)).length,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = rows.filter((row) => matches(row, where));
          for (const row of hit) {
            Object.assign(row, definedOnly(data));
          }
          return { count: hit.length };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = find(where);
          if (!row) throw new Error('not found');
          Object.assign(row, definedOnly(data));
          return withRelations(row);
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = phoneRow({ id: `phone-${rows.length + 1}`, ...data });
        rows.push(row);
        return withRelations(row);
      }),
    },
  };
}

/** Prisma leaves a field alone when it is `undefined`. */
function definedOnly(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

/** What a number carried before it was pointed here: a demo app's webhook and a TwiML App. */
const ATTACHED_BEFORE = {
  voiceUrl: 'https://demo.example.com/welcome/voice',
  voiceMethod: 'POST',
  voiceFallbackUrl: null,
  voiceFallbackMethod: null,
  statusCallback: null,
  statusCallbackMethod: null,
  smsUrl: 'https://demo.example.com/sms',
  smsMethod: 'POST',
  voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  smsApplicationSid: null,
  trunkSid: null,
};

/** A number the account holds, as Twilio describes it. */
const HELD_METADATA = {
  phoneNumber: NEW_LINE,
  friendlyName: 'Old front desk',
  type: 'TOLL_FREE' as const,
  providerType: 'toll-free' as const,
  locality: null,
  region: null,
  country: 'US',
  voiceEnabled: true,
  smsEnabled: true,
  mmsEnabled: true,
  faxEnabled: false,
};

function fakeProvider(overrides: Partial<NumberProvider> = {}) {
  return {
    searchAvailableNumbers: vi.fn(async () => ({ numbers: [] })),
    getMonthlyPrice: vi.fn(async () => ({ amount: '1.15', currency: 'USD' })),
    buyNumber: vi.fn(async () => undefined),
    // Hands what the number had to the caller before changing it, as Twilio's does.
    configureNumber: vi.fn(
      async (
        _phoneNumber: string,
        beforeChange?: (previously: typeof ATTACHED_BEFORE) => Promise<void>,
      ) => {
        await beforeChange?.(ATTACHED_BEFORE);
        return ATTACHED_BEFORE;
      },
    ),
    getOwnedNumberMetadata: vi.fn(async () => null),
    cancelNumber: vi.fn(async () => 'released' as const),
    readNumberForImport: vi.fn(async () => ({
      metadata: HELD_METADATA,
      settings: ATTACHED_BEFORE,
    })),
    listAccountNumbers: vi.fn(async () => ({ numbers: [], truncated: false })),
    checkConnection: vi.fn(async () => ({
      state: 'checked' as const,
      needsReconnect: [],
      texting: null,
    })),
    ...overrides,
  };
}

function importOf(
  overrides: Partial<ImportPhoneNumber> = {},
): ImportPhoneNumber {
  return { phoneNumber: NEW_LINE, isPrimary: false, ...overrides };
}

/** An account number as the import list describes it. */
function accountNumber(phoneNumber: string) {
  return {
    phoneNumber,
    friendlyName: phoneNumber,
    type: 'LOCAL' as const,
    capabilities: { voice: true, sms: true, mms: false, fax: false },
    attached: {
      voiceUrlHost: 'demo.example.com',
      smsUrlHost: null,
      voiceApplication: null,
      smsApplication: null,
      sipTrunkSid: null,
      messagingService: null,
    },
    texting: null,
  };
}

function buildService(phoneNumbers: Row[] = [], provider = fakeProvider()) {
  const store = fakePhoneNumbers(phoneNumbers);
  const db: Record<string, unknown> = {
    phoneNumber: store.table,
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          USERS.find((user) => user.id === where.id) ?? null,
      ),
    },
    department: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          DEPARTMENTS.find((dept) => dept.id === where.id) ?? null,
      ),
    },
  };
  db.$transaction = async (run: (tx: unknown) => unknown) => run(db);
  const auditCreate = vi.fn(async () => undefined);
  const routingCache = {
    refreshPhoneNumbers: vi.fn(async () => undefined),
    refreshDepartment: vi.fn(async () => undefined),
  };
  const service = new PhoneNumberService(
    db as unknown as PrismaClient,
    log,
    { create: auditCreate } as unknown as AuditLogService,
    routingCache as unknown as RoutingCacheService,
    provider as unknown as NumberProvider,
  );

  return {
    service,
    rows: store.rows,
    table: store.table,
    auditCreate,
    routingCache,
    provider,
  };
}

/** When a mock was first called, across every mock; NaN when it never was. */
function firstCall(mock: Mock): number {
  return mock.mock.invocationCallOrder[0] ?? Number.NaN;
}

function purchaseOf(
  overrides: Partial<PurchasePhoneNumber> = {},
): PurchasePhoneNumber {
  return {
    phoneNumber: NEW_LINE,
    country: 'US',
    type: 'LOCAL',
    isPrimary: false,
    ...overrides,
  };
}

describe('PhoneNumberService.purchase', () => {
  test('should record the number before configuring it and make a department first number its primary', async () => {
    const provider = fakeProvider();
    const { service, table, routingCache } = buildService([], provider);

    const result = await service.purchase(
      purchaseOf({ owner: { type: 'department', id: 'dept-sales' } }),
      'admin-1',
    );

    expect(firstCall(provider.buyNumber)).toBeLessThan(firstCall(table.create));
    expect(firstCall(table.create)).toBeLessThan(
      firstCall(provider.configureNumber),
    );
    expect(result).toMatchObject({
      status: 'ACTIVE',
      isPrimary: true,
      assignedTo: { type: 'department', id: 'dept-sales', name: 'Sales' },
    });
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });

  test('should keep the details Twilio reports for the number', async () => {
    const { service } = buildService(
      [],
      fakeProvider({
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
      }),
    );

    const result = await service.purchase(purchaseOf(), 'admin-1');

    expect(result).toMatchObject({
      locality: 'Example City',
      mmsEnabled: true,
      status: 'RESERVED',
      assignedTo: null,
    });
  });

  test('should make the bought number primary on request and demote the one before', async () => {
    const { service, rows } = buildService([
      phoneRow({
        id: 'phone-old',
        phoneNumber: OTHER_LINE,
        departmentId: 'dept-sales',
        status: 'ACTIVE',
        isPrimary: true,
      }),
    ]);

    await service.purchase(
      purchaseOf({
        owner: { type: 'department', id: 'dept-sales' },
        isPrimary: true,
      }),
      'admin-1',
    );

    expect(rows.find((row) => row.id === 'phone-old')?.isPrimary).toBe(false);
    expect(rows.find((row) => row.phoneNumber === NEW_LINE)?.isPrimary).toBe(
      true,
    );
  });

  test('should not make a later department number primary unless asked', async () => {
    const { service, rows } = buildService([
      phoneRow({
        id: 'phone-old',
        phoneNumber: OTHER_LINE,
        departmentId: 'dept-sales',
        status: 'ACTIVE',
        isPrimary: true,
      }),
    ]);

    await service.purchase(
      purchaseOf({ owner: { type: 'department', id: 'dept-sales' } }),
      'admin-1',
    );

    expect(rows.find((row) => row.id === 'phone-old')?.isPrimary).toBe(true);
    expect(rows.find((row) => row.phoneNumber === NEW_LINE)?.isPrimary).toBe(
      false,
    );
  });

  test('should reject an unknown owner before buying', async () => {
    const { service, provider } = buildService();

    await expect(
      service.purchase(
        purchaseOf({ owner: { type: 'user', id: 'user-404' } }),
        'admin-1',
      ),
    ).rejects.toEqual(new AdminServiceError('User not found'));
    expect(provider.buyNumber).not.toHaveBeenCalled();
  });

  test('should refuse a number already on the account before paying for it again', async () => {
    const { service, provider } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
    ]);

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(provider.buyNumber).not.toHaveBeenCalled();
  });

  test('should send the admin to finish a release before buying the number again', async () => {
    const { service, provider } = buildService([
      phoneRow({ status: 'RELEASED' }),
    ]);

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Finish release'),
    });
    expect(provider.buyNumber).not.toHaveBeenCalled();
  });

  test('should bring back the row of a number released here before instead of failing after the purchase', async () => {
    const { service, rows, table, auditCreate } = buildService([
      phoneRow({
        status: 'RELEASED',
        deletedAt: new Date('2026-06-01T00:00:00.000Z'),
        label: 'Old front desk',
      }),
    ]);

    const result = await service.purchase(
      purchaseOf({ owner: { type: 'user', id: 'user-alex' } }),
      'admin-1',
    );

    expect(table.create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'phone-1',
      deletedAt: null,
      status: 'ACTIVE',
      userId: 'user-alex',
      label: null,
      createdBy: 'admin-1',
    });
    // Bought back today, so it lists with today's purchases.
    expect(rows[0]?.createdAt).not.toEqual(
      new Date('2026-03-23T00:00:00.000Z'),
    );
    expect(result.assignedTo).toEqual({
      type: 'user',
      id: 'user-alex',
      name: 'Alex Example',
    });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.purchased',
        changes: expect.objectContaining({ boughtBack: true }),
      }),
      expect.anything(),
    );
  });

  test('should tell a purchase that another one recorded first that the number is on the account', async () => {
    const { service, table, auditCreate } = buildService();
    table.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'This number is already on your account.',
    });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  test('should bring a number back once when two purchases of it finish together', async () => {
    const { service, rows, table, auditCreate } = buildService([
      phoneRow({
        status: 'RELEASED',
        deletedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ]);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      // The other purchase brings it back between our read and our write.
      Object.assign(rows[0] ?? {}, {
        deletedAt: null,
        status: 'ACTIVE',
        userId: 'user-blair',
      });
      return seen;
    });

    await expect(
      service.purchase(
        purchaseOf({ owner: { type: 'user', id: 'user-alex' } }),
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(rows[0]).toMatchObject({ userId: 'user-blair' });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  test('should not create a local record when the provider purchase fails', async () => {
    const { service, rows } = buildService(
      [],
      fakeProvider({
        buyNumber: vi.fn(async () => {
          throw new TwilioProviderError(
            'That number is no longer available.',
            409,
          );
        }),
      }),
    );

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(rows).toHaveLength(0);
  });

  test('should write and change nothing for a number the account held before', async () => {
    const { service, rows, auditCreate, routingCache, provider } = buildService(
      [],
      fakeProvider({
        buyNumber: vi.fn(async () => {
          throw new TwilioProviderError(
            'Your Twilio account has had this number since 2025-03-14, so it was not bought again and nothing was changed. To bring it into this list, use Add a number you own, which keeps a record of how it is set up today.',
            409,
          );
        }),
      }),
    );

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Add a number you own'),
    });
    expect(rows).toHaveLength(0);
    expect(auditCreate).not.toHaveBeenCalled();
    expect(provider.configureNumber).not.toHaveBeenCalled();
    expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
  });

  test('should flag a bought number that could not be recorded', async () => {
    const { service, table, provider } = buildService();
    table.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(provider.configureNumber).not.toHaveBeenCalled();
  });

  test('should answer a number whose webhooks cannot be set as bought but not connected', async () => {
    const { service, rows, routingCache } = buildService(
      [],
      fakeProvider({
        configureNumber: vi.fn(async () => {
          throw new TwilioProviderError('Twilio is unreachable');
        }),
      }),
    );

    const result = await service.purchase(
      purchaseOf({ owner: { type: 'user', id: 'user-alex' } }),
      'admin-1',
    );

    expect(result).toMatchObject({
      phoneNumber: NEW_LINE,
      status: 'ACTIVE',
      connected: false,
    });
    expect(rows).toHaveLength(1);
    // Its holder is routed already, so Reconnect is all that is left.
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });

  test('should still answer when Twilio cannot describe the number it just sold', async () => {
    const { service } = buildService(
      [],
      fakeProvider({
        getOwnedNumberMetadata: vi.fn(async () => {
          throw new Error('timeout');
        }),
      }),
    );

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).resolves.toMatchObject({ phoneNumber: NEW_LINE, connected: true });
  });

  test('should answer a recorded purchase as bought when what follows it fails', async () => {
    const { service, rows, table, routingCache } = buildService(
      [],
      fakeProvider({
        getOwnedNumberMetadata: vi.fn(async () => ({
          friendlyName: '(555) 555-0101',
          type: 'LOCAL' as const,
          locality: 'Springfield',
          region: 'IL',
          country: 'US',
          voiceEnabled: true,
          smsEnabled: true,
          mmsEnabled: true,
          faxEnabled: false,
        })),
      }),
    );
    table.update.mockRejectedValueOnce(new Error('database is down'));
    routingCache.refreshPhoneNumbers.mockRejectedValueOnce(
      new Error('redis is down'),
    );

    await expect(
      service.purchase(purchaseOf(), 'admin-1'),
    ).resolves.toMatchObject({ phoneNumber: NEW_LINE, connected: true });
    expect(rows).toHaveLength(1);
  });
});

describe('PhoneNumberService.importOwned', () => {
  test('should record the number as Twilio describes it, audit what it carried, then point it here', async () => {
    const provider = fakeProvider();
    const { service, table, auditCreate, routingCache } = buildService(
      [],
      provider,
    );

    const result = await service.importOwned(
      importOf({
        label: 'Front desk',
        owner: { type: 'department', id: 'dept-sales' },
      }),
      'admin-1',
      '203.0.113.7',
    );

    expect(firstCall(provider.readNumberForImport)).toBeLessThan(
      firstCall(table.create),
    );
    expect(firstCall(auditCreate)).toBeLessThan(
      firstCall(provider.configureNumber),
    );
    expect(result).toMatchObject({
      phoneNumber: NEW_LINE,
      friendlyName: 'Old front desk',
      type: 'TOLL_FREE',
      mmsEnabled: true,
      label: 'Front desk',
      provider: 'TWILIO',
      status: 'ACTIVE',
      // A department's first number is its primary, as with a purchase.
      isPrimary: true,
      assignedTo: { type: 'department', id: 'dept-sales', name: 'Sales' },
      connected: true,
    });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.imported',
        userId: 'admin-1',
        ipAddress: '203.0.113.7',
        changes: expect.objectContaining({
          phoneNumber: NEW_LINE,
          owner: { type: 'department', id: 'dept-sales' },
          previously: ATTACHED_BEFORE,
        }),
      }),
      expect.anything(),
    );
    expect(provider.configureNumber).toHaveBeenCalledWith(NEW_LINE);
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });

  test('should put a number imported for nobody in the reserve', async () => {
    const { service } = buildService();

    await expect(
      service.importOwned(importOf(), 'admin-1'),
    ).resolves.toMatchObject({
      status: 'RESERVED',
      assignedTo: null,
      isPrimary: false,
    });
  });

  test('should refuse a number already in the list before asking Twilio', async () => {
    const provider = fakeProvider();
    const { service, rows } = buildService(
      [phoneRow({ status: 'ACTIVE', userId: 'user-alex' })],
      provider,
    );

    await expect(
      service.importOwned(importOf(), 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'This number is already in the list.',
    });
    expect(provider.readNumberForImport).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ userId: 'user-alex' });
  });

  test('should send the admin to finish a release before adding the number again', async () => {
    const provider = fakeProvider();
    const { service } = buildService(
      [phoneRow({ status: 'RELEASED' })],
      provider,
    );

    await expect(
      service.importOwned(importOf(), 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Finish release'),
    });
    expect(provider.readNumberForImport).not.toHaveBeenCalled();
  });

  test('should bring back the row of a number released here before', async () => {
    const { service, rows, table, auditCreate } = buildService([
      phoneRow({
        status: 'RELEASED',
        deletedAt: new Date('2026-06-01T00:00:00.000Z'),
        label: 'Old front desk',
      }),
    ]);

    const result = await service.importOwned(
      importOf({ owner: { type: 'user', id: 'user-alex' } }),
      'admin-1',
    );

    expect(table.create).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'phone-1',
      deletedAt: null,
      status: 'ACTIVE',
      userId: 'user-alex',
      label: null,
      createdBy: 'admin-1',
    });
    expect(result.id).toBe('phone-1');
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.imported',
        changes: expect.objectContaining({ releasedHereBefore: true }),
      }),
      expect.anything(),
    );
  });

  test('should answer a number Twilio would not point here as added but not connected', async () => {
    const { service, rows, routingCache } = buildService(
      [],
      fakeProvider({
        configureNumber: vi.fn(async () => {
          throw new TwilioProviderError('Twilio is unreachable');
        }),
      }),
    );

    await expect(
      service.importOwned(importOf(), 'admin-1'),
    ).resolves.toMatchObject({ phoneNumber: NEW_LINE, connected: false });
    expect(rows).toHaveLength(1);
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });

  test('should record nothing when the account does not hold the number', async () => {
    const provider = fakeProvider({
      readNumberForImport: vi.fn(async () => {
        throw new TwilioProviderError(
          'This Twilio account does not have the number, so its calls and texts cannot be pointed here.',
          409,
        );
      }),
    });
    const { service, rows, auditCreate } = buildService([], provider);

    await expect(
      service.importOwned(importOf(), 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(rows).toHaveLength(0);
    expect(auditCreate).not.toHaveBeenCalled();
    expect(provider.configureNumber).not.toHaveBeenCalled();
  });

  test('should leave Twilio alone when the number cannot be recorded', async () => {
    const provider = fakeProvider();
    const { service, table } = buildService([], provider);
    table.create.mockRejectedValueOnce(new Error('db down'));

    await expect(service.importOwned(importOf(), 'admin-1')).rejects.toThrow(
      'db down',
    );
    expect(provider.configureNumber).not.toHaveBeenCalled();
  });

  test('should tell an import that another one recorded first that the number is in the list', async () => {
    const provider = fakeProvider();
    const { service, table } = buildService([], provider);
    table.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.importOwned(importOf(), 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'This number is already in the list.',
    });
    expect(provider.configureNumber).not.toHaveBeenCalled();
  });

  test('should refuse a number outside the US and an unknown owner before asking Twilio', async () => {
    const provider = fakeProvider();
    const { service } = buildService([], provider);

    await expect(
      service.importOwned(
        importOf({ phoneNumber: '+445555550101' }),
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.importOwned(
        importOf({ owner: { type: 'user', id: 'user-nobody' } }),
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(provider.readNumberForImport).not.toHaveBeenCalled();
  });
});

describe('PhoneNumberService.listOwned', () => {
  test('should offer the account’s US numbers the list does not hold, saying which were released here', async () => {
    const { service } = buildService(
      [
        phoneRow({ id: 'phone-1', phoneNumber: NEW_LINE, status: 'ACTIVE' }),
        phoneRow({
          id: 'phone-2',
          phoneNumber: OTHER_LINE,
          status: 'RELEASED',
          deletedAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
        // Its release did not finish, so it is still in the list.
        phoneRow({
          id: 'phone-3',
          phoneNumber: '+15555550103',
          status: 'RELEASED',
        }),
      ],
      fakeProvider({
        listAccountNumbers: vi.fn(async () => ({
          numbers: [
            accountNumber(NEW_LINE),
            accountNumber(OTHER_LINE),
            accountNumber('+15555550103'),
            accountNumber('+15555550104'),
            accountNumber('+445555550105'),
          ],
          truncated: true,
        })),
      }),
    );

    const owned = await service.listOwned();

    expect(owned.truncated).toBe(true);
    expect(
      owned.numbers.map(({ phoneNumber, releasedHere }) => ({
        phoneNumber,
        releasedHere,
      })),
    ).toEqual([
      { phoneNumber: OTHER_LINE, releasedHere: true },
      { phoneNumber: '+15555550104', releasedHere: false },
    ]);
  });
});

describe('PhoneNumberService.connection', () => {
  test('should ask Twilio about the listed number as its row describes it', async () => {
    const provider = fakeProvider({
      checkConnection: vi.fn(async () => ({
        state: 'checked' as const,
        needsReconnect: ['voice-application' as const],
        texting: { kind: 'unregistered' as const },
      })),
    });
    const { service } = buildService(
      [phoneRow({ type: 'TOLL_FREE' })],
      provider,
    );

    await expect(service.connection('phone-1')).resolves.toEqual({
      state: 'checked',
      needsReconnect: ['voice-application'],
      texting: { kind: 'unregistered' },
    });
    expect(provider.checkConnection).toHaveBeenCalledWith(
      NEW_LINE,
      'TOLL_FREE',
    );
  });

  test('should answer null for a number that is not listed', async () => {
    const provider = fakeProvider();
    const { service } = buildService([], provider);

    await expect(service.connection('phone-404')).resolves.toBeNull();
    expect(provider.checkConnection).not.toHaveBeenCalled();
  });
});

describe('PhoneNumberService.update', () => {
  test('should move a number from a department to a user and refresh its routing', async () => {
    const { service, rows, routingCache, auditCreate } = buildService([
      phoneRow({
        departmentId: 'dept-sales',
        status: 'ACTIVE',
        isPrimary: true,
      }),
    ]);

    const result = await service.update(
      'phone-1',
      { owner: { type: 'user', id: 'user-alex' } },
      'admin-1',
    );

    expect(rows[0]).toMatchObject({
      userId: 'user-alex',
      departmentId: null,
      isPrimary: false,
      status: 'ACTIVE',
    });
    expect(result?.assignedTo).toMatchObject({ type: 'user', id: 'user-alex' });
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.assigned',
        changes: expect.objectContaining({
          owner: {
            from: { type: 'department', id: 'dept-sales' },
            to: { type: 'user', id: 'user-alex' },
          },
        }),
      }),
      expect.anything(),
    );
  });

  test('should put a number in the reserve', async () => {
    const { service, rows, auditCreate } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
    ]);

    await service.update('phone-1', { owner: null }, 'admin-1');

    expect(rows[0]).toMatchObject({
      userId: null,
      departmentId: null,
      status: 'RESERVED',
    });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'phone_number.unassigned' }),
      expect.anything(),
    );
  });

  test('should answer a committed move as done when the routing cache cannot be refreshed', async () => {
    const { service, rows, routingCache } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
    ]);
    routingCache.refreshPhoneNumbers.mockRejectedValueOnce(
      new Error('redis is down'),
    );

    await expect(
      service.update('phone-1', { owner: null }, 'admin-1'),
    ).resolves.toMatchObject({ assignedTo: null });
    expect(rows[0]).toMatchObject({ userId: null, status: 'RESERVED' });
  });

  test('should refuse the move when the number changed hands after it was read', async () => {
    const { service, rows, table, routingCache } = buildService([phoneRow()]);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      // Another admin gives the number to Blair between our read and write.
      Object.assign(rows[0] ?? {}, { userId: 'user-blair', status: 'ACTIVE' });
      return seen;
    });

    await expect(
      service.update(
        'phone-1',
        { owner: { type: 'department', id: 'dept-sales' } },
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(rows[0]).toMatchObject({ userId: 'user-blair', departmentId: null });
    expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
  });

  test('should refuse a move decided on a holder the number no longer has', async () => {
    const { service, rows, table } = buildService([
      phoneRow({ departmentId: 'dept-sales', status: 'ACTIVE' }),
    ]);

    await expect(
      service.update(
        'phone-1',
        {
          owner: { type: 'user', id: 'user-blair' },
          // The admin's screen still showed Alex holding it.
          expectedOwner: { type: 'user', id: 'user-alex' },
        },
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(table.updateMany).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ departmentId: 'dept-sales', userId: null });
  });

  test('should apply a move decided on the holder the number still has', async () => {
    const { service, rows } = buildService([phoneRow()]);

    await service.update(
      'phone-1',
      {
        owner: { type: 'department', id: 'dept-support' },
        expectedOwner: null,
      },
      'admin-1',
    );

    expect(rows[0]).toMatchObject({
      departmentId: 'dept-support',
      status: 'ACTIVE',
    });
  });

  test('should not carry a primary into a department that already has one', async () => {
    const { service, rows } = buildService([
      phoneRow({
        departmentId: 'dept-sales',
        status: 'ACTIVE',
        isPrimary: true,
      }),
      phoneRow({
        id: 'phone-support',
        phoneNumber: OTHER_LINE,
        departmentId: 'dept-support',
        status: 'ACTIVE',
        isPrimary: true,
      }),
    ]);

    await service.update(
      'phone-1',
      { owner: { type: 'department', id: 'dept-support' } },
      'admin-1',
    );

    expect(
      rows.filter(
        (row) => row.departmentId === 'dept-support' && row.isPrimary,
      ),
    ).toHaveLength(1);
    expect(rows[0]?.isPrimary).toBe(false);
  });

  test('should make a number primary when it joins a department that has none', async () => {
    const { service, rows } = buildService([phoneRow()]);

    await service.update(
      'phone-1',
      { owner: { type: 'department', id: 'dept-support' } },
      'admin-1',
    );

    expect(rows[0]).toMatchObject({
      departmentId: 'dept-support',
      isPrimary: true,
    });
  });

  test('should demote the other primary when promoting a number in the same department', async () => {
    const { service, rows, routingCache } = buildService([
      phoneRow({ departmentId: 'dept-sales', status: 'ACTIVE' }),
      phoneRow({
        id: 'phone-2',
        phoneNumber: OTHER_LINE,
        departmentId: 'dept-sales',
        status: 'ACTIVE',
        isPrimary: true,
      }),
    ]);

    const result = await service.update(
      'phone-1',
      { isPrimary: true },
      'admin-1',
    );

    expect(result?.isPrimary).toBe(true);
    expect(rows[1]?.isPrimary).toBe(false);
    expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
  });

  test('should save a label even when somebody moved the number meanwhile', async () => {
    const { service, rows, table } = buildService([phoneRow()]);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      // Another admin gives the number to Blair between our read and write.
      Object.assign(rows[0] ?? {}, { userId: 'user-blair', status: 'ACTIVE' });
      return seen;
    });

    await service.update('phone-1', { label: 'Front desk' }, 'admin-1');

    expect(rows[0]).toMatchObject({
      label: 'Front desk',
      userId: 'user-blair',
      status: 'ACTIVE',
    });
  });

  test('should refuse to make a number primary when no department will hold it', async () => {
    const { service, rows, auditCreate } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
    ]);

    await expect(
      service.update(
        'phone-1',
        { isPrimary: true, expectedOwner: { type: 'user', id: 'user-alex' } },
        'admin-1',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(rows[0]).toMatchObject({ userId: 'user-alex', isPrimary: false });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  test('should refuse a primary switch once somebody moved the number', async () => {
    const { service, rows, table } = buildService([
      phoneRow({ departmentId: 'dept-sales', status: 'ACTIVE' }),
    ]);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      Object.assign(rows[0] ?? {}, {
        departmentId: 'dept-support',
        isPrimary: false,
      });
      return seen;
    });

    await expect(
      service.update('phone-1', { isPrimary: true }, 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(rows[0]).toMatchObject({
      departmentId: 'dept-support',
      isPrimary: false,
    });
  });

  test('should change only the label when that is all that was asked', async () => {
    const { service, rows, auditCreate } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
    ]);

    await service.update('phone-1', { label: 'Front desk' }, 'admin-1');

    expect(rows[0]).toMatchObject({ label: 'Front desk', userId: 'user-alex' });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.updated',
        changes: { label: { from: null, to: 'Front desk' } },
      }),
      expect.anything(),
    );
  });

  test('should write nothing when nothing changes', async () => {
    const { service, table, auditCreate } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
    ]);

    await service.update(
      'phone-1',
      { owner: { type: 'user', id: 'user-alex' } },
      'admin-1',
    );

    expect(table.updateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  test('should reject a move to a department that does not exist', async () => {
    const { service, rows } = buildService([phoneRow()]);

    await expect(
      service.update(
        'phone-1',
        { owner: { type: 'department', id: 'dept-404' } },
        'admin-1',
      ),
    ).rejects.toEqual(new AdminServiceError('Department not found'));
    expect(rows[0]?.departmentId).toBeNull();
  });

  test('should answer null for a released number', async () => {
    const { service } = buildService([
      phoneRow({ deletedAt: new Date(), status: 'RELEASED' }),
    ]);

    expect(await service.update('phone-1', { owner: null }, 'admin-1')).toBe(
      null,
    );
  });
});

describe('PhoneNumberService.reconnect', () => {
  test('should point the webhooks here again and record who did it', async () => {
    const { service, provider, auditCreate, routingCache } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
    ]);

    const result = await service.reconnect('phone-1', 'admin-1');

    expect(result?.id).toBe('phone-1');
    expect(provider.configureNumber).toHaveBeenCalledWith(
      NEW_LINE,
      expect.any(Function),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.reconnected',
        // What it detached or replaced, so it can be put back by hand.
        changes: { phoneNumber: NEW_LINE, previously: ATTACHED_BEFORE },
      }),
    );
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([NEW_LINE]);
  });

  test('should record nothing when the number cannot be read from Twilio', async () => {
    const { service, auditCreate } = buildService(
      [phoneRow({ userId: 'user-alex', status: 'ACTIVE' })],
      fakeProvider({
        configureNumber: vi.fn(async () => {
          throw new TwilioProviderError(
            'This Twilio account does not have the number, so its calls and texts cannot be pointed here.',
            409,
          );
        }),
      }),
    );

    await expect(service.reconnect('phone-1', 'admin-1')).rejects.toMatchObject(
      { statusCode: 409 },
    );
    expect(auditCreate).not.toHaveBeenCalled();
  });

  test('should keep what the number had when the change fails after Twilio was asked', async () => {
    const { service, auditCreate, routingCache } = buildService(
      [phoneRow({ userId: 'user-alex', status: 'ACTIVE' })],
      fakeProvider({
        configureNumber: vi.fn(
          async (
            _phoneNumber: string,
            beforeChange?: (
              previously: typeof ATTACHED_BEFORE,
            ) => Promise<void>,
          ) => {
            await beforeChange?.(ATTACHED_BEFORE);
            throw new TwilioProviderError(
              'Twilio took the change, but a TwiML App takes its calls.',
            );
          },
        ),
      }),
    );

    await expect(service.reconnect('phone-1', 'admin-1')).rejects.toMatchObject(
      { statusCode: 502 },
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.reconnected',
        changes: { phoneNumber: NEW_LINE, previously: ATTACHED_BEFORE },
      }),
    );
    expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
  });

  test('should answer null for a number that is not listed', async () => {
    const { service, provider } = buildService();

    expect(await service.reconnect('phone-404', 'admin-1')).toBe(null);
    expect(provider.configureNumber).not.toHaveBeenCalled();
  });
});

describe('PhoneNumberService.release', () => {
  test('should keep the number listed as being released while Twilio cancels it, then take it off the list and drop the routing entry', async () => {
    let duringCancel: Row | undefined;
    const provider = fakeProvider({
      cancelNumber: vi.fn(async () => {
        duringCancel = { ...(built.rows[0] ?? { id: 'missing' }) };
        return 'released' as const;
      }),
    });
    const built = buildService([phoneRow({ country: null })], provider);

    expect(await built.service.release('phone-1', 'admin-1')).toEqual({
      cancelledAtTwilio: true,
    });
    expect(duringCancel).toMatchObject({ status: 'RELEASED', deletedAt: null });
    expect(provider.cancelNumber).toHaveBeenCalledWith(NEW_LINE);
    expect(built.rows[0]).toMatchObject({ status: 'RELEASED' });
    expect(built.rows[0]?.deletedAt).toBeInstanceOf(Date);
    expect(built.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.released',
        changes: { phoneNumber: NEW_LINE },
      }),
      expect.anything(),
    );
    expect(built.routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      NEW_LINE,
    ]);
  });

  test('should refuse to release a number somebody holds, before asking Twilio', async () => {
    const provider = fakeProvider();
    const { service, rows } = buildService(
      [
        phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
        phoneRow({
          id: 'phone-2',
          phoneNumber: OTHER_LINE,
          departmentId: 'dept-sales',
          status: 'ACTIVE',
        }),
      ],
      provider,
    );

    for (const id of ['phone-1', 'phone-2']) {
      await expect(service.release(id, 'admin-1')).rejects.toMatchObject({
        statusCode: 409,
      });
    }
    expect(provider.cancelNumber).not.toHaveBeenCalled();
    expect(rows.every((row) => row.deletedAt === null)).toBe(true);
  });

  test('should release a number Twilio no longer has, and say so in the audit log', async () => {
    const { service, rows, auditCreate } = buildService(
      [phoneRow({ provider: 'VONAGE' })],
      fakeProvider({
        cancelNumber: vi.fn(async () => 'not-in-account' as const),
      }),
    );

    expect(await service.release('phone-1', 'admin-1')).toEqual({
      cancelledAtTwilio: false,
    });
    expect(rows[0]).toMatchObject({ status: 'RELEASED' });
    expect(rows[0]?.deletedAt).toBeInstanceOf(Date);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.released',
        changes: { phoneNumber: NEW_LINE, alreadyGoneFromTwilio: true },
      }),
      expect.anything(),
    );
  });

  test('should keep the number listed when Twilio refuses the release, and record the refusal', async () => {
    const { service, rows, auditCreate } = buildService(
      [phoneRow()],
      fakeProvider({
        cancelNumber: vi.fn(async () => {
          throw new TwilioProviderError('Twilio is unreachable');
        }),
      }),
    );

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(rows[0]).toMatchObject({ status: 'RESERVED', deletedAt: null });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.release_failed',
        userId: 'admin-1',
        changes: {
          phoneNumber: NEW_LINE,
          reason: 'Twilio is unreachable',
          returnedToReserve: true,
        },
      }),
    );
  });

  test('should keep the number marked when Twilio does not confirm the release', async () => {
    const { service, rows, auditCreate } = buildService(
      [phoneRow()],
      fakeProvider({
        cancelNumber: vi.fn(async () => 'unconfirmed' as const),
      }),
    );

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 504,
      message: expect.stringContaining('Finish release'),
    });
    expect(rows[0]).toMatchObject({ status: 'RELEASED', deletedAt: null });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.release_failed',
        changes: expect.objectContaining({ returnedToReserve: false }),
      }),
    );
  });

  test('should tell a second release of the same number that one is under way', async () => {
    const provider = fakeProvider();
    const { service, rows, table } = buildService([phoneRow()], provider);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      // Another admin's release marks it between our read and our mark.
      Object.assign(rows[0] ?? {}, { status: 'RELEASED' });
      return seen;
    });

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('releasing this number already'),
    });
    expect(provider.cancelNumber).not.toHaveBeenCalled();
  });

  test('should answer a finished release as finished when the routing cache cannot be refreshed', async () => {
    const { service, rows, routingCache } = buildService([phoneRow()]);
    routingCache.refreshPhoneNumbers.mockRejectedValueOnce(
      new Error('redis is down'),
    );

    expect(await service.release('phone-1', 'admin-1')).toEqual({
      cancelledAtTwilio: true,
    });
    expect(rows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  test('should not release a number somebody was given while the release began', async () => {
    const provider = fakeProvider();
    const { service, rows, table } = buildService([phoneRow()], provider);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      // Another admin gives the number to Sales between our read and claim.
      Object.assign(rows[0] ?? {}, {
        departmentId: 'dept-sales',
        status: 'ACTIVE',
      });
      return seen;
    });

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(provider.cancelNumber).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      departmentId: 'dept-sales',
      deletedAt: null,
    });
  });

  test('should keep the number out of reach of other changes while Twilio cancels it', async () => {
    const refusals: unknown[] = [];
    const provider = fakeProvider({
      cancelNumber: vi.fn(async () => {
        // Other admins try to give the number away, reconnect it or buy it
        // back while Twilio works.
        for (const attempt of [
          built.service.update(
            'phone-1',
            { owner: { type: 'user', id: 'user-alex' } },
            'admin-2',
          ),
          built.service.reconnect('phone-1', 'admin-2'),
          built.service.purchase(purchaseOf(), 'admin-2'),
        ]) {
          refusals.push(await attempt.catch((error: unknown) => error));
        }
        return 'released' as const;
      }),
    });
    const built = buildService([phoneRow()], provider);

    await built.service.release('phone-1', 'admin-1');

    expect(refusals).toEqual([
      expect.objectContaining({ statusCode: 409 }),
      expect.objectContaining({ statusCode: 409 }),
      expect.objectContaining({ statusCode: 409 }),
    ]);
    expect(provider.configureNumber).not.toHaveBeenCalled();
    expect(provider.buyNumber).not.toHaveBeenCalled();
    expect(built.rows[0]).toMatchObject({ status: 'RELEASED', userId: null });
  });

  test('should not give away a number a release took between the read and the write', async () => {
    const { service, rows, table } = buildService([phoneRow()]);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      // Another admin starts releasing it between our read and our write.
      Object.assign(rows[0] ?? {}, { status: 'RELEASED' });
      return seen;
    });

    await expect(
      service.update(
        'phone-1',
        { owner: { type: 'user', id: 'user-alex' } },
        'admin-1',
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('being released'),
    });
    expect(rows[0]).toMatchObject({ status: 'RELEASED', userId: null });
  });

  test('should tell a label saved while a release began that the number is being released', async () => {
    const { service, rows, table } = buildService([phoneRow()]);
    const read = table.findUnique.getMockImplementation();
    table.findUnique.mockImplementationOnce(async (args) => {
      const seen = await read?.(args);
      Object.assign(rows[0] ?? {}, { status: 'RELEASED' });
      return seen;
    });

    await expect(
      service.update('phone-1', { label: 'Front desk' }, 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('being released'),
    });
    expect(rows[0]?.label).toBeNull();
  });

  test('should finish a release that stopped after Twilio let go of the number', async () => {
    const { service, rows, auditCreate } = buildService(
      [phoneRow({ status: 'RELEASED' })],
      fakeProvider({
        cancelNumber: vi.fn(async () => 'not-in-account' as const),
      }),
    );

    // Most likely its first try took it: no advice to look elsewhere.
    expect(await service.release('phone-1', 'admin-1')).toEqual({
      cancelledAtTwilio: true,
    });
    expect(rows[0]?.deletedAt).toBeInstanceOf(Date);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.released',
        changes: {
          phoneNumber: NEW_LINE,
          alreadyGoneFromTwilio: true,
          finishedEarlierRelease: true,
        },
      }),
      expect.anything(),
    );
  });

  test('should send the admin to the previous provider when the release of an imported number finishes with nothing at Twilio', async () => {
    const { service } = buildService(
      [phoneRow({ status: 'RELEASED', provider: 'VONAGE' })],
      fakeProvider({
        cancelNumber: vi.fn(async () => 'not-in-account' as const),
      }),
    );

    // It was most likely never on Twilio, so it may still be billed there.
    expect(await service.release('phone-1', 'admin-1')).toEqual({
      cancelledAtTwilio: false,
    });
  });

  test('should answer once when another request finished the same release first', async () => {
    const provider = fakeProvider({
      cancelNumber: vi.fn(async () => {
        Object.assign(built.rows[0] ?? {}, { deletedAt: new Date() });
        return 'released' as const;
      }),
    });
    const built = buildService([phoneRow()], provider);

    expect(await built.service.release('phone-1', 'admin-1')).toEqual({
      cancelledAtTwilio: true,
    });
    expect(built.auditCreate).not.toHaveBeenCalled();
  });

  test('should tell the admin when the number was changed here while Twilio let go of it', async () => {
    const provider = fakeProvider({
      cancelNumber: vi.fn(async () => {
        // Another request put it back in the reserve meanwhile.
        Object.assign(built.rows[0] ?? {}, { status: 'RESERVED' });
        return 'released' as const;
      }),
    });
    const built = buildService([phoneRow()], provider);

    await expect(
      built.service.release('phone-1', 'admin-1'),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Twilio no longer has this number'),
    });
    expect(built.rows[0]).toMatchObject({ deletedAt: null });
    expect(built.auditCreate).not.toHaveBeenCalled();
  });

  test('should put an unfinished release back in the reserve when Twilio refuses it while it has the number', async () => {
    const { service, rows, auditCreate } = buildService(
      [phoneRow({ status: 'RELEASED' })],
      fakeProvider({
        cancelNumber: vi.fn(async () => {
          throw new ReleaseRefusedError(
            'Number is in use by a regulatory bundle',
          );
        }),
      }),
    );

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(rows[0]).toMatchObject({ status: 'RESERVED', deletedAt: null });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.release_failed',
        changes: expect.objectContaining({ returnedToReserve: true }),
      }),
    );
  });

  test('should leave an unfinished release marked when Twilio cannot be asked again', async () => {
    const { service, rows, auditCreate } = buildService(
      [phoneRow({ status: 'RELEASED' })],
      fakeProvider({
        cancelNumber: vi.fn(async () => {
          throw new TwilioProviderError('Twilio is unreachable');
        }),
      }),
    );

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(rows[0]).toMatchObject({ status: 'RELEASED', deletedAt: null });
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'phone_number.release_failed',
        changes: expect.objectContaining({ returnedToReserve: false }),
      }),
    );
  });

  test('should answer with the Twilio refusal even when the number cannot be put back', async () => {
    const { service, table } = buildService(
      [phoneRow()],
      fakeProvider({
        cancelNumber: vi.fn(async () => {
          throw new TwilioProviderError('Twilio is unreachable');
        }),
      }),
    );
    const write = table.updateMany.getMockImplementation();
    table.updateMany
      .mockImplementationOnce(async (args) => write?.(args))
      .mockRejectedValueOnce(new Error('database is down'));

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 502,
      message: 'Twilio is unreachable',
    });
  });

  test('should tell the admin to release again when Twilio let go but the list could not be updated', async () => {
    const { service, auditCreate } = buildService([phoneRow()]);
    auditCreate.mockRejectedValueOnce(new Error('database is down'));

    await expect(service.release('phone-1', 'admin-1')).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining('Release it again to finish'),
    });
  });

  test('should answer null for a number that is not listed', async () => {
    const { service } = buildService([phoneRow({ deletedAt: new Date() })]);

    expect(await service.release('phone-1', 'admin-1')).toBeNull();
  });
});

describe('PhoneNumberService.searchAvailable', () => {
  const query = { country: 'US', type: 'LOCAL', limit: 10 } as const;

  test('should quote the monthly price with the numbers found', async () => {
    const { service } = buildService();

    expect(await service.searchAvailable(query)).toEqual({
      numbers: [],
      monthlyPrice: { amount: '1.15', currency: 'USD' },
    });
  });

  test('should still answer when the price list cannot be read', async () => {
    const { service } = buildService(
      [],
      fakeProvider({
        getMonthlyPrice: vi.fn(async () => {
          throw new TwilioProviderError('Twilio is unreachable');
        }),
      }),
    );

    expect(await service.searchAvailable(query)).toEqual({
      numbers: [],
      monthlyPrice: null,
    });
  });
});

describe('PhoneNumberService.list', () => {
  test('should match a number typed with punctuation, and the name of whoever holds it', async () => {
    const { service, table } = buildService();

    await service.list({ page: 1, limit: 20, search: '(555) 555-01' });
    await service.list({ page: 1, limit: 20, search: 'alex' });

    const [first, second] = (table.count as ReturnType<typeof vi.fn>).mock
      .calls as [
      [{ where: { OR: unknown[] } }],
      [{ where: { OR: unknown[] } }],
    ];
    expect(first[0].where.OR).toContainEqual({
      phoneNumber: { contains: '55555501' },
    });
    expect(second[0].where.OR).toContainEqual({
      user: { name: { contains: 'alex', mode: 'insensitive' } },
    });
  });

  test('should list only the numbers held by the kind of holder asked for', async () => {
    const { service } = buildService([
      phoneRow({ userId: 'user-alex', status: 'ACTIVE' }),
      phoneRow({
        id: 'phone-2',
        phoneNumber: OTHER_LINE,
        departmentId: 'dept-sales',
        status: 'ACTIVE',
      }),
      phoneRow({ id: 'phone-3', phoneNumber: '+15555550103' }),
      phoneRow({
        id: 'phone-4',
        phoneNumber: '+15555550104',
        status: 'RELEASED',
        deletedAt: new Date(),
      }),
      // A release that did not finish: listed, but not in the reserve.
      phoneRow({
        id: 'phone-5',
        phoneNumber: '+15555550105',
        status: 'RELEASED',
      }),
    ]);
    const listed = async (assignedTo?: 'user' | 'department' | 'nobody') => {
      const { phoneNumbers, total } = await service.list({
        page: 1,
        limit: 20,
        assignedTo,
      });
      return { ids: phoneNumbers.map((number) => number.id), total };
    };

    expect(await listed('user')).toEqual({ ids: ['phone-1'], total: 1 });
    expect(await listed('department')).toEqual({ ids: ['phone-2'], total: 1 });
    expect(await listed('nobody')).toEqual({ ids: ['phone-3'], total: 1 });
    expect((await listed()).total).toBe(4);
  });
});
