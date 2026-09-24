import { Prisma, type PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import type { AuditLogService } from '../admin/index.js';
import { AdminServiceError } from '../admin/index.js';
import type { AccessLinkService } from '../auth/index.js';
import type { RoutingCacheService } from '../routing/index.js';
import { UserService } from './user.service.js';

const DIRECT_LINE = '+15555550101';
const INVITE_LINK =
  'https://app.example.com/set-password?token=a-fictional-token';

const log = { info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function fakeDb(tables: Record<string, unknown>): PrismaClient {
  const db: Record<string, unknown> = {
    account: {
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    setPasswordToken: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    ...tables,
  };
  db.$transaction = async (run: (tx: unknown) => unknown) => run(db);
  return db as unknown as PrismaClient;
}

/** A user row as `userInclude` loads it, with no password and no invite. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'new@example.com',
    name: 'New User',
    role: 'AGENT',
    emailVerified: false,
    image: null,
    createdAt: new Date('2026-03-20T00:00:00.000Z'),
    updatedAt: new Date('2026-03-20T00:00:00.000Z'),
    deletedAt: null,
    departments: [],
    phoneNumbers: [],
    accounts: [{ password: null }],
    setPasswordTokens: [],
    ...overrides,
  };
}

function buildService(tables: Record<string, unknown>) {
  const db = fakeDb(tables);
  const auditCreate = vi.fn(async () => undefined);
  const routingCache = {
    refreshPhoneNumbers: vi.fn(async () => undefined),
    refreshDepartment: vi.fn(async () => undefined),
  };
  const accessLinks = {
    issueIn: vi.fn(async () => ({
      purpose: 'INVITE' as const,
      url: INVITE_LINK,
      expiresAt: new Date('2026-03-27T00:00:00.000Z'),
    })),
    deliver: vi.fn(async () => ({
      purpose: 'INVITE' as const,
      url: INVITE_LINK,
      expiresAt: '2026-03-27T00:00:00.000Z',
      emailSent: true,
      emailError: null,
    })),
  };
  const service = new UserService(
    db,
    log,
    { create: auditCreate } as unknown as AuditLogService,
    routingCache as unknown as RoutingCacheService,
    accessLinks as unknown as AccessLinkService,
  );

  return { service, db, auditCreate, routingCache, accessLinks };
}

/**
 * One unassigned number. Another administrator's assignment can be set to
 * commit right after the service has read it, between its check and its
 * transaction, where a concurrent request lands; `updateMany` then applies
 * its `where` to the row as it stands, as the database does.
 */
function reservedNumber() {
  const row: Record<string, unknown> = {
    id: 'phone-1',
    phoneNumber: DIRECT_LINE,
    deletedAt: null,
    userId: null,
    departmentId: null,
    status: 'RESERVED',
  };
  let afterNextRead: (() => void) | null = null;

  return {
    row,
    assignRightAfterItIsRead(
      owner: { userId: string } | { departmentId: string },
    ) {
      afterNextRead = () => Object.assign(row, owner, { status: 'ACTIVE' });
    },
    table: {
      findUnique: vi.fn(async () => {
        const read = { ...row };
        afterNextRead?.();
        afterNextRead = null;
        return read;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matches = Object.entries(where).every(
            ([field, value]) => row[field] === value,
          );
          if (matches) {
            Object.assign(row, data);
          }
          return { count: matches ? 1 : 0 };
        },
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(row, data),
      ),
    },
  };
}

function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('UserService', () => {
  test('should refresh the direct line when a phone number is assigned', async () => {
    const number = reservedNumber();
    const { service, db, auditCreate, routingCache } = buildService({
      user: { findUnique: vi.fn(async () => ({ id: 'user-1' })) },
      phoneNumber: number.table,
    });

    const assigned = await service.assignPhoneNumber(
      'user-1',
      'phone-1',
      'admin-1',
    );

    expect(assigned).toBe(true);
    expect(number.row).toMatchObject({
      userId: 'user-1',
      departmentId: null,
      status: 'ACTIVE',
    });
    expect(routingCache.refreshPhoneNumbers).toHaveBeenCalledWith([
      DIRECT_LINE,
    ]);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.phone_number_assigned' }),
      db,
    );
  });

  test.each([
    ['a department', { departmentId: 'dept-1' }],
    ['another user', { userId: 'user-2' }],
  ])(
    'should refuse a number another administrator gave to %s while it was being assigned',
    async (_, owner) => {
      const number = reservedNumber();
      number.assignRightAfterItIsRead(owner);
      const { service, auditCreate, routingCache } = buildService({
        user: { findUnique: vi.fn(async () => ({ id: 'user-1' })) },
        phoneNumber: number.table,
      });

      expect(
        await service.assignPhoneNumber('user-1', 'phone-1', 'admin-1'),
      ).toBe(false);
      // Held by the other assignment alone, never by both.
      expect(number.row).toMatchObject({
        userId: null,
        departmentId: null,
        ...owner,
      });
      expect(auditCreate).not.toHaveBeenCalled();
      expect(routingCache.refreshPhoneNumbers).not.toHaveBeenCalled();
    },
  );

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

  test('deleting a user ends every way back in', async () => {
    const { service, db } = buildService({
      user: {
        findUnique: vi.fn(async () => ({
          id: 'user-1',
          deletedAt: null,
          departments: [],
          phoneNumbers: [],
        })),
        update: vi.fn(async () => ({})),
      },
      phoneNumber: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });

    await service.delete('user-1', 'admin-1');

    // The sessions they are signed in with...
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    // ...the password they could sign in again with...
    expect(db.account.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', providerId: 'credential' },
      data: { password: null },
    });
    // ...and any link that would let them set a new one.
    expect(db.setPasswordToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });

  test('restoring a user invites them again, since deleting took their password', async () => {
    const { service, accessLinks, db } = buildService({
      user: {
        findUnique: vi.fn(async () => ({
          id: 'user-1',
          deletedAt: new Date('2026-03-21T00:00:00.000Z'),
        })),
        update: vi.fn(async () =>
          userRow({
            setPasswordTokens: [
              // Live now, as the invite just issued in the same transaction is.
              {
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                consumedAt: null,
              },
            ],
          }),
        ),
      },
    });

    const restored = await service.restore('user-1', 'admin-1');

    expect(accessLinks.issueIn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        userId: 'user-1',
        purpose: 'INVITE',
        issuedBy: 'admin-1',
      }),
    );
    expect(accessLinks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ url: INVITE_LINK }),
      { email: 'new@example.com', name: 'New User' },
    );
    expect(restored?.invite.url).toBe(INVITE_LINK);
    // Back in the same state as a freshly invited user: no password, one link.
    expect(restored?.user.inviteStatus).toBe('pending');
  });

  test('restoring somebody who was never deleted issues no link', async () => {
    const { service, accessLinks } = buildService({
      user: {
        findUnique: vi.fn(async () => ({ id: 'user-1', deletedAt: null })),
        update: vi.fn(async () => userRow()),
      },
    });

    expect(await service.restore('user-1', 'admin-1')).toBeNull();
    expect(accessLinks.issueIn).not.toHaveBeenCalled();
    expect(accessLinks.deliver).not.toHaveBeenCalled();
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
        findUniqueOrThrow: vi.fn(async () =>
          userRow({
            departments: [
              {
                id: 'ud-1',
                departmentId: 'dept-1',
                order: 0,
                department: { id: 'dept-1', name: 'Support' },
              },
            ],
            phoneNumbers: [{ id: 'phone-1', phoneNumber: DIRECT_LINE }],
          }),
        ),
      },
      phoneNumber: { updateMany },
    });

    const { user } = await service.create(
      {
        email: 'new@example.com',
        name: 'New User',
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

  test('creating a user gives them a credential with no password, and an invite', async () => {
    const { service, db, accessLinks } = buildService({
      user: {
        create: vi.fn(async () => ({ id: 'user-1' })),
        findUniqueOrThrow: vi.fn(async () =>
          userRow({
            setPasswordTokens: [
              {
                expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
                consumedAt: null,
              },
            ],
          }),
        ),
      },
      phoneNumber: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });

    const result = await service.create(
      { email: 'new@example.com', name: 'New User', role: 'AGENT' },
      'admin-1',
    );

    expect(db.account.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        accountId: 'user-1',
        providerId: 'credential',
      },
    });
    expect(accessLinks.issueIn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ userId: 'user-1', purpose: 'INVITE' }),
    );
    expect(result.invite.url).toBe(INVITE_LINK);
    // Until they follow the link they have set no password, so they are pending.
    expect(result.user.inviteStatus).toBe('pending');
  });

  test('the invite email goes out only once the account is committed', async () => {
    const order: string[] = [];
    const db = fakeDb({
      user: {
        create: vi.fn(async () => ({ id: 'user-1' })),
        findUniqueOrThrow: vi.fn(async () => userRow()),
      },
      phoneNumber: { updateMany: vi.fn(async () => ({ count: 0 })) },
    });
    (db as unknown as { $transaction: unknown }).$transaction = async (
      run: (tx: unknown) => Promise<unknown>,
    ) => {
      const value = await run(db);
      order.push('committed');
      return value;
    };

    const accessLinks = {
      issueIn: vi.fn(async () => ({
        purpose: 'INVITE' as const,
        url: INVITE_LINK,
        expiresAt: new Date('2026-03-27T00:00:00.000Z'),
      })),
      deliver: vi.fn(async () => {
        order.push('delivered');
        return {
          purpose: 'INVITE' as const,
          url: INVITE_LINK,
          expiresAt: '2026-03-27T00:00:00.000Z',
          emailSent: true,
          emailError: null,
        };
      }),
    };

    await new UserService(
      db,
      log,
      { create: vi.fn(async () => undefined) } as unknown as AuditLogService,
      {
        refreshPhoneNumbers: vi.fn(async () => undefined),
        refreshDepartment: vi.fn(async () => undefined),
      } as unknown as RoutingCacheService,
      accessLinks as unknown as AccessLinkService,
    ).create(
      { email: 'new@example.com', name: 'New User', role: 'AGENT' },
      'admin-1',
    );

    expect(order).toEqual(['committed', 'delivered']);
  });

  test('a user who has set a password reads as active', async () => {
    const { service } = buildService({
      user: {
        findUnique: vi.fn(async () =>
          userRow({ accounts: [{ password: 'a-bcrypt-hash' }] }),
        ),
      },
    });

    expect((await service.getById('user-1'))?.inviteStatus).toBe('active');
  });

  test('a user whose invite has run out reads as expired', async () => {
    const { service } = buildService({
      user: {
        findUnique: vi.fn(async () =>
          userRow({
            setPasswordTokens: [
              { expiresAt: new Date('2020-01-01T00:00:00Z'), consumedAt: null },
            ],
          }),
        ),
      },
    });

    expect((await service.getById('user-1'))?.inviteStatus).toBe('expired');
  });

  test('resending an invite rotates the link and records who asked', async () => {
    const { service, db, auditCreate, accessLinks } = buildService({
      user: {
        findFirst: vi.fn(async () => ({
          id: 'user-1',
          email: 'new@example.com',
          name: 'New User',
          accounts: [{ password: null }],
        })),
      },
    });

    const invite = await service.sendInvite('user-1', 'admin-1', '203.0.113.7');

    expect(invite?.url).toBe(INVITE_LINK);
    expect(accessLinks.issueIn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ purpose: 'INVITE', issuedBy: 'admin-1' }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.invited' }),
      db,
    );
  });

  test('never records the link itself in the audit log', async () => {
    const { service, auditCreate } = buildService({
      user: {
        findFirst: vi.fn(async () => ({
          id: 'user-1',
          email: 'new@example.com',
          name: 'New User',
          accounts: [{ password: 'a-bcrypt-hash' }],
        })),
      },
    });

    await service.sendPasswordReset('user-1', 'admin-1');

    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(
      'a-fictional-token',
    );
  });

  test('refuses an invite for someone who already has a password', async () => {
    const { service } = buildService({
      user: {
        findFirst: vi.fn(async () => ({
          id: 'user-1',
          email: 'new@example.com',
          name: 'New User',
          accounts: [{ password: 'a-bcrypt-hash' }],
        })),
      },
    });

    await expect(service.sendInvite('user-1', 'admin-1')).rejects.toMatchObject(
      { statusCode: 409 },
    );
  });

  test('refuses a reset for someone who has never set a password', async () => {
    const { service } = buildService({
      user: {
        findFirst: vi.fn(async () => ({
          id: 'user-1',
          email: 'new@example.com',
          name: 'New User',
          accounts: [{ password: null }],
        })),
      },
    });

    await expect(
      service.sendPasswordReset('user-1', 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('issues no link for a user who is gone', async () => {
    const { service, accessLinks } = buildService({
      user: { findFirst: vi.fn(async () => null) },
    });

    expect(await service.sendInvite('user-1', 'admin-1')).toBeNull();
    expect(await service.sendPasswordReset('user-1', 'admin-1')).toBeNull();
    expect(accessLinks.issueIn).not.toHaveBeenCalled();
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
