import type { Prisma, PrismaClient } from '@repo/db';
import type {
  CreateUser,
  UpdateUser,
  UserListQuery,
  UserListResponse,
  UserResponse,
} from '@repo/dto';
import bcrypt from 'bcryptjs';
import type { FastifyBaseLogger } from 'fastify';
import type { RoutingCacheService } from '../routing-cache.service.js';
import type { AuditLogService } from './audit-log.service.js';
import { AdminServiceError, isUniqueConstraintViolation } from './errors.js';

const PASSWORD_HASH_ROUNDS = 12;

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
} as const satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

export class UserService {
  constructor(
    private readonly db: PrismaClient,
    private readonly log: FastifyBaseLogger,
    private readonly auditLog: AuditLogService,
    private readonly routingCache: RoutingCacheService,
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

    return {
      users: users.map(toUserResponse),
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

  /** @throws AdminServiceError 409 when the email is already taken. */
  async create(
    data: CreateUser,
    actorId: string,
    ipAddress?: string,
  ): Promise<UserResponse> {
    const hashedPassword = await bcrypt.hash(
      data.password,
      PASSWORD_HASH_ROUNDS,
    );

    try {
      const { user, assignedNumbers } = await this.db.$transaction(
        async (tx) => {
          const created = await tx.user.create({
            data: {
              email: data.email,
              name: data.name,
              role: data.role,
              createdBy: actorId,
              accounts: {
                create: {
                  accountId: data.email,
                  providerId: 'credential',
                  password: hashedPassword,
                },
              },
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
            assignedNumbers: user.phoneNumbers.map((pn) => pn.phoneNumber),
          };
        },
      );

      await this.routingCache.refreshPhoneNumbers(assignedNumbers);
      await this.refreshDepartments(user.departments);
      this.log.info({ userId: user.id, actorId }, 'User created');

      return toUserResponse(user);
    } catch (error) {
      throw translateUniqueViolation(error);
    }
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

    const hashedPassword = data.password
      ? await bcrypt.hash(data.password, PASSWORD_HASH_ROUNDS)
      : undefined;
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
    if (hashedPassword) {
      changes.password = 'changed';
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

        if (hashedPassword) {
          await tx.account.updateMany({
            where: { userId: id, providerId: 'credential' },
            data: { password: hashedPassword },
          });
        }

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

  async restore(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<UserResponse | null> {
    const user = await this.db.user.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });

    if (!user?.deletedAt) {
      return null;
    }

    const restored = await this.db.$transaction(async (tx) => {
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
          ipAddress,
        },
        tx,
      );
      return updated;
    });

    await this.refreshDepartments(restored.departments);

    return toUserResponse(restored);
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

    await this.db.$transaction(async (tx) => {
      await tx.phoneNumber.update({
        where: { id: phoneNumberId },
        data: { userId, status: 'ACTIVE', updatedBy: actorId },
      });
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
    });

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
}

function translateUniqueViolation(error: unknown): unknown {
  return isUniqueConstraintViolation(error)
    ? new AdminServiceError('A user with this email already exists', 409)
    : error;
}

function toUserResponse(user: UserRow): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.emailVerified,
    image: user.image,
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
