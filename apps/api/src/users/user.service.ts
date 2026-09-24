import type { Prisma, PrismaClient } from '@repo/db';
import type {
  AccessLinkResponse,
  CreateUser,
  InvitedUserResponse,
  SetPasswordPurpose,
  UpdateUser,
  UserListQuery,
  UserListResponse,
  UserResponse,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditAction, AuditLogService } from '../admin/index.js';
import {
  AdminServiceError,
  isUniqueConstraintViolation,
} from '../admin/index.js';
import type { AccessLinkService } from '../auth/index.js';
import { hasCredentialPassword, inviteStatus } from '../auth/index.js';
import type { RoutingCacheService } from '../routing/index.js';

const userInclude = {
  departments: {
    include: { department: { select: { id: true, name: true } } },
    orderBy: { order: 'asc' },
  },
  phoneNumbers: {
    where: { deletedAt: null },
    select: {
      id: true,
      phoneNumber: true,
      friendlyName: true,
      type: true,
      label: true,
      locality: true,
      region: true,
      country: true,
      voiceEnabled: true,
      smsEnabled: true,
      mmsEnabled: true,
      faxEnabled: true,
      isPrimary: true,
    },
  },
  /*
   * The credential is itself the record of whether someone can sign in: there
   * is no status column beside it to fall out of step. The hash is read only
   * to answer that yes-or-no question and never leaves this file.
   */
  accounts: {
    where: { providerId: 'credential' },
    select: { password: true },
  },
  setPasswordTokens: {
    where: { purpose: 'INVITE' },
    select: { expiresAt: true, consumedAt: true },
  },
} as const satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

export class UserService {
  constructor(
    private readonly db: PrismaClient,
    private readonly log: FastifyBaseLogger,
    private readonly auditLog: AuditLogService,
    private readonly routingCache: RoutingCacheService,
    private readonly accessLinks: AccessLinkService,
  ) {}

  async list(query: UserListQuery): Promise<UserListResponse> {
    const { page, limit, search, role, includeDeleted, deletedOnly } = query;
    const where: Prisma.UserWhereInput = {};

    if (deletedOnly) {
      where.deletedAt = { not: null };
    } else if (!includeDeleted) {
      where.deletedAt = null;
    }

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role) {
      where.role = role;
    }

    const [users, total] = await Promise.all([
      this.db.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: userInclude,
      }),
      this.db.user.count({ where }),
    ]);

    // One moment for the whole page, so two rows cannot disagree about
    // whether the same invite is still live.
    const now = new Date();

    return {
      users: users.map((user) => toUserResponse(user, now)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getById(id: string): Promise<UserResponse | null> {
    const user = await this.db.user.findUnique({
      where: { id },
      include: userInclude,
    });

    return user ? toUserResponse(user) : null;
  }

  /**
   * Creates a user and the invite that lets them in. They get no password
   * here: the link they follow is where the only one they will ever have is
   * chosen, so nobody but its owner knows it.
   *
   * @throws AdminServiceError 409 when the email is already taken.
   */
  async create(
    data: CreateUser,
    actorId: string,
    ipAddress?: string,
  ): Promise<InvitedUserResponse> {
    try {
      const { user, assignedNumbers, link } = await this.db.$transaction(
        async (tx) => {
          const created = await tx.user.create({
            data: {
              email: data.email,
              name: data.name,
              role: data.role,
              createdBy: actorId,
              departments: data.departmentIds?.length
                ? {
                    create: data.departmentIds.map((departmentId, index) => ({
                      departmentId,
                      order: index,
                    })),
                  }
                : undefined,
            },
            select: { id: true },
          });

          /*
           * The credential exists from the start, with no password in it.
           * Better Auth finds it by the user's id and refuses a sign-in while
           * it holds none, which is exactly the "invited, not yet in" state.
           */
          await tx.account.create({
            data: {
              userId: created.id,
              accountId: created.id,
              providerId: 'credential',
            },
          });

          const link = await this.accessLinks.issueIn(tx, {
            userId: created.id,
            purpose: 'INVITE',
            issuedBy: actorId,
          });

          if (data.phoneNumberIds?.length) {
            await tx.phoneNumber.updateMany({
              where: {
                id: { in: data.phoneNumberIds },
                deletedAt: null,
                userId: null,
                departmentId: null,
              },
              data: {
                userId: created.id,
                status: 'ACTIVE',
                updatedBy: actorId,
              },
            });
          }

          await this.auditLog.create(
            {
              action: 'user.created',
              entityType: 'User',
              entityId: created.id,
              userId: actorId,
              changes: { email: data.email, name: data.name, role: data.role },
              ipAddress,
            },
            tx,
          );

          const user = await tx.user.findUniqueOrThrow({
            where: { id: created.id },
            include: userInclude,
          });

          return {
            user,
            link,
            assignedNumbers: user.phoneNumbers.map((pn) => pn.phoneNumber),
          };
        },
      );

      await this.routingCache.refreshPhoneNumbers(assignedNumbers);
      await this.refreshDepartments(user.departments);
      this.log.info({ userId: user.id, actorId }, 'User invited');

      // Only now that the account is committed, so the link in the email
      // always opens something.
      const invite = await this.accessLinks.deliver(link, {
        email: user.email,
        name: user.name,
      });

      return { user: toUserResponse(user), invite };
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  /**
   * Issues a fresh invite for someone who has not got in yet, and retires the
   * previous one. Returns null when there is no such live user.
   *
   * @throws AdminServiceError 409 when they already have a password.
   */
  async sendInvite(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<AccessLinkResponse | null> {
    const user = await this.findForAccessLink(id);

    if (!user) {
      return null;
    }

    if (user.hasPassword) {
      throw new AdminServiceError(
        'This user has already set a password. Send a password reset link instead.',
        409,
      );
    }

    return this.issueAndDeliver(
      user,
      'INVITE',
      'user.invited',
      actorId,
      ipAddress,
    );
  }

  /**
   * Issues a reset link for someone who is locked out. An admin never learns
   * or chooses the password itself.
   *
   * @throws AdminServiceError 409 when they have never set one.
   */
  async sendPasswordReset(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<AccessLinkResponse | null> {
    const user = await this.findForAccessLink(id);

    if (!user) {
      return null;
    }

    if (!user.hasPassword) {
      throw new AdminServiceError(
        'This user has never set a password. Send an invite link instead.',
        409,
      );
    }

    return this.issueAndDeliver(
      user,
      'RESET',
      'user.password_reset_issued',
      actorId,
      ipAddress,
    );
  }

  /** @throws AdminServiceError 409 when the new email is already taken. */
  async update(
    id: string,
    data: UpdateUser,
    actorId: string,
    ipAddress?: string,
  ): Promise<UserResponse | null> {
    const existingUser = await this.db.user.findUnique({ where: { id } });

    if (!existingUser) {
      return null;
    }

    const changes: Record<string, unknown> = {};

    if (data.email && data.email !== existingUser.email) {
      changes.email = { from: existingUser.email, to: data.email };
    }
    if (data.name && data.name !== existingUser.name) {
      changes.name = { from: existingUser.name, to: data.name };
    }
    if (data.role && data.role !== existingUser.role) {
      changes.role = { from: existingUser.role, to: data.role };
    }

    try {
      const user = await this.db.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: { id },
          data: {
            email: data.email,
            name: data.name,
            role: data.role,
            updatedBy: actorId,
          },
          include: userInclude,
        });

        if (Object.keys(changes).length > 0) {
          await this.auditLog.create(
            {
              action: 'user.updated',
              entityType: 'User',
              entityId: id,
              userId: actorId,
              changes,
              ipAddress,
            },
            tx,
          );
        }

        return updated;
      });

      return toUserResponse(user);
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  async delete(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const user = await this.db.user.findUnique({
      where: { id },
      select: {
        id: true,
        deletedAt: true,
        departments: { select: { departmentId: true } },
        phoneNumbers: {
          where: { deletedAt: null },
          select: { phoneNumber: true },
        },
      },
    });

    if (!user || user.deletedAt) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), updatedBy: actorId },
      });
      await tx.phoneNumber.updateMany({
        where: { userId: id },
        data: { userId: null, status: 'RESERVED', updatedBy: actorId },
      });
      /*
       * Deleting a user is the only off-boarding control this product has, so
       * it has to end access, not just hide the row. Three things go with it,
       * in the same transaction as the deletion: the sessions they are signed
       * in with, the password they could sign in again with, and any link that
       * would let them set a new one. A restored user is invited afresh.
       */
      await tx.session.deleteMany({ where: { userId: id } });
      await tx.account.updateMany({
        where: { userId: id, providerId: 'credential' },
        data: { password: null },
      });
      await tx.setPasswordToken.deleteMany({ where: { userId: id } });
      await this.auditLog.create(
        {
          action: 'user.deleted',
          entityType: 'User',
          entityId: id,
          userId: actorId,
          ipAddress,
        },
        tx,
      );
    });

    // A deleted agent leaves every ring group and their direct line stops routing.
    await this.routingCache.refreshPhoneNumbers(
      user.phoneNumbers.map((pn) => pn.phoneNumber),
    );
    await this.refreshDepartments(user.departments);
    this.log.info({ userId: id, actorId }, 'User deleted');

    return true;
  }

  /**
   * Brings a deleted user back, with a fresh invite. Deleting took their
   * password and their links away, so clearing `deletedAt` on its own would
   * hand back an account nobody can sign into; the invite is what makes the
   * restore mean anything.
   */
  async restore(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<InvitedUserResponse | null> {
    const user = await this.db.user.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });

    if (!user?.deletedAt) {
      return null;
    }

    const { restored, link } = await this.db.$transaction(async (tx) => {
      // Issued before the row is read back, so the invite this returns is the
      // same one the response reports as pending.
      const issued = await this.accessLinks.issueIn(tx, {
        userId: id,
        purpose: 'INVITE',
        issuedBy: actorId,
      });
      const updated = await tx.user.update({
        where: { id },
        data: { deletedAt: null, updatedBy: actorId },
        include: userInclude,
      });
      await this.auditLog.create(
        {
          action: 'user.restored',
          entityType: 'User',
          entityId: id,
          userId: actorId,
          changes: { purpose: 'INVITE' },
          ipAddress,
        },
        tx,
      );
      return { restored: updated, link: issued };
    });

    await this.refreshDepartments(restored.departments);
    this.log.info({ userId: id, actorId }, 'User restored and invited');

    const invite = await this.accessLinks.deliver(link, {
      email: restored.email,
      name: restored.name,
    });

    return { user: toUserResponse(restored), invite };
  }

  async assignPhoneNumber(
    userId: string,
    phoneNumberId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const user = await this.db.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });

    if (!user) {
      return false;
    }

    const phoneNumber = await this.db.phoneNumber.findUnique({
      where: { id: phoneNumberId, deletedAt: null },
      select: { id: true, phoneNumber: true, userId: true, departmentId: true },
    });

    if (!phoneNumber || phoneNumber.userId || phoneNumber.departmentId) {
      return false;
    }

    const assigned = await this.db.$transaction(async (tx) => {
      // Only while nobody holds it: another administrator can assign it after
      // the check above. Unconditionally, this would take it from another
      // user, or leave it held by a department as well, and a number held by
      // both files the department's messages under this user alone.
      const claimed = await tx.phoneNumber.updateMany({
        where: {
          id: phoneNumberId,
          deletedAt: null,
          userId: null,
          departmentId: null,
        },
        data: { userId, status: 'ACTIVE', updatedBy: actorId },
      });

      if (claimed.count === 0) {
        return false;
      }

      await this.auditLog.create(
        {
          action: 'user.phone_number_assigned',
          entityType: 'User',
          entityId: userId,
          userId: actorId,
          changes: { phoneNumberId, phoneNumber: phoneNumber.phoneNumber },
          ipAddress,
        },
        tx,
      );
      return true;
    });

    if (!assigned) {
      return false;
    }

    await this.routingCache.refreshPhoneNumbers([phoneNumber.phoneNumber]);

    return true;
  }

  async removePhoneNumber(
    userId: string,
    phoneNumberId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const phoneNumber = await this.db.phoneNumber.findUnique({
      where: { id: phoneNumberId, userId, deletedAt: null },
      select: { id: true, phoneNumber: true },
    });

    if (!phoneNumber) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.phoneNumber.update({
        where: { id: phoneNumberId },
        data: { userId: null, status: 'RESERVED', updatedBy: actorId },
      });
      await this.auditLog.create(
        {
          action: 'user.phone_number_removed',
          entityType: 'User',
          entityId: userId,
          userId: actorId,
          changes: { phoneNumberId, phoneNumber: phoneNumber.phoneNumber },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshPhoneNumbers([phoneNumber.phoneNumber]);

    return true;
  }

  async assignDepartment(
    userId: string,
    departmentId: string,
    order: number,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const user = await this.db.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });

    if (!user) {
      return false;
    }

    const department = await this.db.department.findUnique({
      where: { id: departmentId, deletedAt: null },
      select: { id: true, name: true },
    });

    if (!department) {
      return false;
    }

    const existing = await this.db.userDepartment.findUnique({
      where: { userId_departmentId: { userId, departmentId } },
    });

    if (existing) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.userDepartment.create({ data: { userId, departmentId, order } });
      await this.auditLog.create(
        {
          action: 'user.department_assigned',
          entityType: 'User',
          entityId: userId,
          userId: actorId,
          changes: { departmentId, departmentName: department.name, order },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  async removeDepartment(
    userId: string,
    departmentId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const assignment = await this.db.userDepartment.findUnique({
      where: { userId_departmentId: { userId, departmentId } },
      include: { department: { select: { name: true } } },
    });

    if (!assignment) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.userDepartment.delete({
        where: { userId_departmentId: { userId, departmentId } },
      });
      await this.auditLog.create(
        {
          action: 'user.department_removed',
          entityType: 'User',
          entityId: userId,
          userId: actorId,
          changes: { departmentId, departmentName: assignment.department.name },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  private async refreshDepartments(
    memberships: readonly { departmentId: string }[],
  ): Promise<void> {
    for (const { departmentId } of memberships) {
      await this.routingCache.refreshDepartment(departmentId);
    }
  }

  private async findForAccessLink(
    id: string,
  ): Promise<AccessLinkTarget | null> {
    const user = await this.db.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        accounts: {
          where: { providerId: 'credential' },
          select: { password: true },
        },
      },
    });

    return user
      ? {
          id: user.id,
          email: user.email,
          name: user.name,
          hasPassword: hasCredentialPassword(user.accounts),
        }
      : null;
  }

  private async issueAndDeliver(
    user: AccessLinkTarget,
    purpose: SetPasswordPurpose,
    action: AuditAction,
    actorId: string,
    ipAddress?: string,
  ): Promise<AccessLinkResponse> {
    const link = await this.db.$transaction(async (tx) => {
      const issued = await this.accessLinks.issueIn(tx, {
        userId: user.id,
        purpose,
        issuedBy: actorId,
      });
      // Which kind of link, never the link: the audit log is read by people
      // who must not be able to take over an account from it.
      await this.auditLog.create(
        {
          action,
          entityType: 'User',
          entityId: user.id,
          userId: actorId,
          changes: { purpose },
          ipAddress,
        },
        tx,
      );
      return issued;
    });

    this.log.info({ userId: user.id, actorId, purpose }, 'Access link issued');

    return this.accessLinks.deliver(link, {
      email: user.email,
      name: user.name,
    });
  }
}

/** The facts an access link needs about the person it is for. */
interface AccessLinkTarget {
  id: string;
  email: string;
  name: string | null;
  hasPassword: boolean;
}

function translateUniqueViolation(error: unknown): unknown {
  return isUniqueConstraintViolation(error)
    ? new AdminServiceError('A user with this email already exists', 409)
    : error;
}

function toUserResponse(user: UserRow, now: Date = new Date()): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.emailVerified,
    image: user.image,
    inviteStatus: inviteStatus(
      {
        hasPassword: hasCredentialPassword(user.accounts),
        // At most one, since a user has one live invite at a time.
        invite: user.setPasswordTokens[0] ?? null,
      },
      now,
    ),
    departments: user.departments.map((membership) => ({
      id: membership.id,
      departmentId: membership.department.id,
      departmentName: membership.department.name,
      order: membership.order,
    })),
    phoneNumbers: user.phoneNumbers.map((pn) => ({
      id: pn.id,
      phoneNumber: pn.phoneNumber,
      friendlyName: pn.friendlyName,
      type: pn.type,
      label: pn.label,
      locality: pn.locality,
      region: pn.region,
      country: pn.country,
      voiceEnabled: pn.voiceEnabled,
      smsEnabled: pn.smsEnabled,
      mmsEnabled: pn.mmsEnabled,
      faxEnabled: pn.faxEnabled,
      isPrimary: pn.isPrimary,
    })),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}
