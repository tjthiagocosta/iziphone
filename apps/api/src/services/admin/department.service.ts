import type { Prisma, PrismaClient } from '@repo/db';
import type {
  AddAgent,
  BusinessHoursItem,
  CreateDepartment,
  CreateHoliday,
  DepartmentListQuery,
  DepartmentListResponse,
  DepartmentResponse,
  UpdateAgentOrder,
  UpdateDepartment,
  UpdateDepartmentSettings,
  UpdateHoliday,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { RoutingCacheService } from '../routing-cache.service.js';
import type { AuditLogService } from './audit-log.service.js';
import { AdminServiceError, isUniqueConstraintViolation } from './errors.js';

const departmentInclude = {
  settings: true,
  businessHours: { orderBy: { dayOfWeek: 'asc' } },
  holidays: { orderBy: { date: 'asc' } },
  users: {
    orderBy: { order: 'asc' },
    include: { user: { select: { id: true, name: true, email: true } } },
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
} as const satisfies Prisma.DepartmentInclude;

type DepartmentRow = Prisma.DepartmentGetPayload<{
  include: typeof departmentInclude;
}>;

const WEEKDAYS = [1, 2, 3, 4, 5];

export class DepartmentService {
  constructor(
    private readonly db: PrismaClient,
    private readonly log: FastifyBaseLogger,
    private readonly auditLog: AuditLogService,
    private readonly routingCache: RoutingCacheService,
  ) {}

  async list(query: DepartmentListQuery): Promise<DepartmentListResponse> {
    const { page, limit, search, includeDeleted, deletedOnly } = query;
    const where: Prisma.DepartmentWhereInput = {};

    if (deletedOnly) {
      where.deletedAt = { not: null };
    } else if (!includeDeleted) {
      where.deletedAt = null;
    }

    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const [departments, total] = await Promise.all([
      this.db.department.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          settings: { select: { timezone: true } },
          phoneNumbers: {
            where: { isPrimary: true, deletedAt: null },
            select: { phoneNumber: true },
            take: 1,
          },
          _count: { select: { users: true } },
        },
      }),
      this.db.department.count({ where }),
    ]);

    return {
      departments: departments.map((dept) => ({
        id: dept.id,
        name: dept.name,
        description: dept.description,
        timezone: dept.settings?.timezone ?? null,
        primaryPhoneNumber: dept.phoneNumbers[0]?.phoneNumber ?? null,
        agentCount: dept._count.users,
        createdAt: dept.createdAt.toISOString(),
        deletedAt: dept.deletedAt?.toISOString() ?? null,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getById(id: string): Promise<DepartmentResponse | null> {
    const department = await this.db.department.findUnique({
      where: { id },
      include: departmentInclude,
    });

    return department ? toDepartmentResponse(department) : null;
  }

  /** @throws AdminServiceError 409 when the name is already taken. */
  async create(
    data: CreateDepartment,
    actorId: string,
    ipAddress?: string,
  ): Promise<DepartmentResponse> {
    try {
      const department = await this.db.$transaction(async (tx) => {
        const created = await tx.department.create({
          data: {
            name: data.name,
            description: data.description,
            createdBy: actorId,
            settings: { create: {} },
            // New departments answer Monday to Friday, 08:00 to 17:00, until edited.
            businessHours: {
              create: Array.from({ length: 7 }, (_, dayOfWeek) => {
                const isOpen = WEEKDAYS.includes(dayOfWeek);
                return {
                  dayOfWeek,
                  isOpen,
                  openTime: isOpen ? '08:00' : null,
                  closeTime: isOpen ? '17:00' : null,
                };
              }),
            },
          },
          include: departmentInclude,
        });

        await this.auditLog.create(
          {
            action: 'department.created',
            entityType: 'Department',
            entityId: created.id,
            userId: actorId,
            changes: { name: data.name, description: data.description },
            ipAddress,
          },
          tx,
        );

        return created;
      });

      this.log.info(
        { departmentId: department.id, actorId },
        'Department created',
      );

      return toDepartmentResponse(department);
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  /** @throws AdminServiceError 409 when the new name is already taken. */
  async update(
    id: string,
    data: UpdateDepartment,
    actorId: string,
    ipAddress?: string,
  ): Promise<DepartmentResponse | null> {
    const existing = await this.db.department.findUnique({ where: { id } });

    if (!existing) {
      return null;
    }

    const changes: Record<string, unknown> = {};

    if (data.name && data.name !== existing.name) {
      changes.name = { from: existing.name, to: data.name };
    }
    if (
      data.description !== undefined &&
      data.description !== existing.description
    ) {
      changes.description = {
        from: existing.description,
        to: data.description,
      };
    }

    try {
      const department = await this.db.$transaction(async (tx) => {
        const updated = await tx.department.update({
          where: { id },
          data: {
            name: data.name,
            description: data.description,
            updatedBy: actorId,
          },
          include: departmentInclude,
        });

        if (Object.keys(changes).length > 0) {
          await this.auditLog.create(
            {
              action: 'department.updated',
              entityType: 'Department',
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

      // The controller shows the department name to agents on inbound calls.
      if (changes.name) {
        await this.routingCache.refreshDepartment(id);
      }

      return toDepartmentResponse(department);
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  async delete(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const department = await this.db.department.findUnique({
      where: { id },
      select: {
        id: true,
        deletedAt: true,
        phoneNumbers: {
          where: { deletedAt: null },
          select: { phoneNumber: true },
        },
      },
    });

    if (!department || department.deletedAt) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.department.update({
        where: { id },
        data: { deletedAt: new Date(), updatedBy: actorId },
      });
      await tx.phoneNumber.updateMany({
        where: { departmentId: id },
        data: {
          departmentId: null,
          isPrimary: false,
          status: 'RESERVED',
          updatedBy: actorId,
        },
      });
      await this.auditLog.create(
        {
          action: 'department.deleted',
          entityType: 'Department',
          entityId: id,
          userId: actorId,
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshPhoneNumbers(
      department.phoneNumbers.map((pn) => pn.phoneNumber),
    );
    await this.routingCache.refreshDepartment(id);
    this.log.info({ departmentId: id, actorId }, 'Department deleted');

    return true;
  }

  async restore(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<DepartmentResponse | null> {
    const department = await this.db.department.findUnique({
      where: { id },
      select: { id: true, deletedAt: true },
    });

    if (!department?.deletedAt) {
      return null;
    }

    const restored = await this.db.$transaction(async (tx) => {
      const updated = await tx.department.update({
        where: { id },
        data: { deletedAt: null, updatedBy: actorId },
        include: departmentInclude,
      });
      await this.auditLog.create(
        {
          action: 'department.restored',
          entityType: 'Department',
          entityId: id,
          userId: actorId,
          ipAddress,
        },
        tx,
      );
      return updated;
    });

    return toDepartmentResponse(restored);
  }

  async updateSettings(
    departmentId: string,
    data: UpdateDepartmentSettings,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    if (!(await this.findActiveDepartment(departmentId))) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.departmentSettings.update({
        where: { departmentId },
        data: {
          timezone: data.timezone,
          is24Hours: data.is24Hours,
          openHoursRoutingType: data.openHoursRoutingType,
          closedHoursRoutingType: data.closedHoursRoutingType,
          closedHoursExternalNumber: data.closedHoursExternalNumber,
          ringDuration: data.ringDuration,
          voicemailGreetingUrl: data.voicemailGreetingUrl,
        },
      });
      await this.auditLog.create(
        {
          action: 'department.settings_updated',
          entityType: 'Department',
          entityId: departmentId,
          userId: actorId,
          changes: data,
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  async updateBusinessHours(
    departmentId: string,
    hours: BusinessHoursItem[],
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    if (!(await this.findActiveDepartment(departmentId))) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      for (const day of hours) {
        await tx.businessHours.upsert({
          where: {
            departmentId_dayOfWeek: { departmentId, dayOfWeek: day.dayOfWeek },
          },
          create: {
            departmentId,
            dayOfWeek: day.dayOfWeek,
            isOpen: day.isOpen,
            openTime: day.openTime,
            closeTime: day.closeTime,
          },
          update: {
            isOpen: day.isOpen,
            openTime: day.openTime,
            closeTime: day.closeTime,
          },
        });
      }

      await this.auditLog.create(
        {
          action: 'department.business_hours_updated',
          entityType: 'Department',
          entityId: departmentId,
          userId: actorId,
          changes: { hours },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  async addHoliday(
    departmentId: string,
    data: CreateHoliday,
    actorId: string,
    ipAddress?: string,
  ): Promise<string | null> {
    if (!(await this.findActiveDepartment(departmentId))) {
      return null;
    }

    const holiday = await this.db.$transaction(async (tx) => {
      const created = await tx.holiday.create({
        data: {
          departmentId,
          name: data.name,
          date: new Date(data.date),
          isRecurring: data.isRecurring,
          routingType: data.routingType,
          routingValue: data.routingValue,
        },
        select: { id: true },
      });
      await this.auditLog.create(
        {
          action: 'department.holiday_created',
          entityType: 'Holiday',
          entityId: created.id,
          userId: actorId,
          changes: data,
          metadata: { departmentId },
          ipAddress,
        },
        tx,
      );
      return created;
    });

    await this.routingCache.refreshDepartment(departmentId);

    return holiday.id;
  }

  async updateHoliday(
    departmentId: string,
    holidayId: string,
    data: UpdateHoliday,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const holiday = await this.db.holiday.findUnique({
      where: { id: holidayId, departmentId },
      select: { id: true },
    });

    if (!holiday) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.holiday.update({
        where: { id: holidayId },
        data: {
          name: data.name,
          date: data.date ? new Date(data.date) : undefined,
          isRecurring: data.isRecurring,
          routingType: data.routingType,
          routingValue: data.routingValue,
        },
      });
      await this.auditLog.create(
        {
          action: 'department.holiday_updated',
          entityType: 'Holiday',
          entityId: holidayId,
          userId: actorId,
          changes: data,
          metadata: { departmentId },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  async deleteHoliday(
    departmentId: string,
    holidayId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const holiday = await this.db.holiday.findUnique({
      where: { id: holidayId, departmentId },
      select: { id: true, name: true },
    });

    if (!holiday) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.holiday.delete({ where: { id: holidayId } });
      await this.auditLog.create(
        {
          action: 'department.holiday_deleted',
          entityType: 'Holiday',
          entityId: holidayId,
          userId: actorId,
          changes: { name: holiday.name },
          metadata: { departmentId },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  async addAgent(
    departmentId: string,
    data: AddAgent,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const [department, user] = await Promise.all([
      this.findActiveDepartment(departmentId),
      this.db.user.findUnique({
        where: { id: data.userId, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);

    if (!department || !user) {
      return false;
    }

    const existing = await this.db.userDepartment.findUnique({
      where: { userId_departmentId: { userId: data.userId, departmentId } },
    });

    if (existing) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.userDepartment.create({
        data: { userId: data.userId, departmentId, order: data.order },
      });
      await this.auditLog.create(
        {
          action: 'department.agent_added',
          entityType: 'Department',
          entityId: departmentId,
          userId: actorId,
          changes: { userId: data.userId, order: data.order },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  /** @throws AdminServiceError 400 when the order names a user outside the department. */
  async updateAgentOrder(
    departmentId: string,
    data: UpdateAgentOrder,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    if (!(await this.findActiveDepartment(departmentId))) {
      return false;
    }

    const memberships = await this.db.userDepartment.findMany({
      where: { departmentId },
      select: { userId: true },
    });
    const memberIds = new Set(memberships.map((m) => m.userId));
    const outsider = data.agentOrder.find(
      (agent) => !memberIds.has(agent.userId),
    );

    if (outsider) {
      throw new AdminServiceError(
        `User ${outsider.userId} is not an agent of this department`,
      );
    }

    await this.db.$transaction(async (tx) => {
      for (const agent of data.agentOrder) {
        await tx.userDepartment.update({
          where: {
            userId_departmentId: { userId: agent.userId, departmentId },
          },
          data: { order: agent.order },
        });
      }

      await this.auditLog.create(
        {
          action: 'department.agent_order_updated',
          entityType: 'Department',
          entityId: departmentId,
          userId: actorId,
          changes: { agentOrder: data.agentOrder },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  async removeAgent(
    departmentId: string,
    userId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const assignment = await this.db.userDepartment.findUnique({
      where: { userId_departmentId: { userId, departmentId } },
      select: { id: true },
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
          action: 'department.agent_removed',
          entityType: 'Department',
          entityId: departmentId,
          userId: actorId,
          changes: { userId },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  async assignPhoneNumber(
    departmentId: string,
    phoneNumberId: string,
    isPrimary: boolean,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    if (!(await this.findActiveDepartment(departmentId))) {
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
      if (isPrimary) {
        await tx.phoneNumber.updateMany({
          where: { departmentId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      await tx.phoneNumber.update({
        where: { id: phoneNumberId },
        data: { departmentId, isPrimary, status: 'ACTIVE', updatedBy: actorId },
      });
      await this.auditLog.create(
        {
          action: 'department.phone_number_assigned',
          entityType: 'Department',
          entityId: departmentId,
          userId: actorId,
          changes: {
            phoneNumberId,
            phoneNumber: phoneNumber.phoneNumber,
            isPrimary,
          },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshPhoneNumbers([phoneNumber.phoneNumber]);

    return true;
  }

  async removePhoneNumber(
    departmentId: string,
    phoneNumberId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const phoneNumber = await this.db.phoneNumber.findUnique({
      where: { id: phoneNumberId, departmentId, deletedAt: null },
      select: { id: true, phoneNumber: true },
    });

    if (!phoneNumber) {
      return false;
    }

    await this.db.$transaction(async (tx) => {
      await tx.phoneNumber.update({
        where: { id: phoneNumberId },
        data: {
          departmentId: null,
          isPrimary: false,
          status: 'RESERVED',
          updatedBy: actorId,
        },
      });
      await this.auditLog.create(
        {
          action: 'department.phone_number_removed',
          entityType: 'Department',
          entityId: departmentId,
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

  private findActiveDepartment(id: string): Promise<{ id: string } | null> {
    return this.db.department.findUnique({
      where: { id, deletedAt: null },
      select: { id: true },
    });
  }
}

function translateUniqueViolation(error: unknown): unknown {
  return isUniqueConstraintViolation(error)
    ? new AdminServiceError('A department with this name already exists', 409)
    : error;
}

function toDepartmentResponse(department: DepartmentRow): DepartmentResponse {
  return {
    id: department.id,
    name: department.name,
    description: department.description,
    settings: department.settings
      ? {
          id: department.settings.id,
          timezone: department.settings.timezone,
          is24Hours: department.settings.is24Hours,
          openHoursRoutingType: department.settings.openHoursRoutingType,
          closedHoursRoutingType: department.settings.closedHoursRoutingType,
          closedHoursExternalNumber:
            department.settings.closedHoursExternalNumber,
          ringDuration: department.settings.ringDuration,
          voicemailGreetingUrl: department.settings.voicemailGreetingUrl,
        }
      : null,
    businessHours: department.businessHours.map((hours) => ({
      id: hours.id,
      dayOfWeek: hours.dayOfWeek,
      isOpen: hours.isOpen,
      openTime: hours.openTime,
      closeTime: hours.closeTime,
    })),
    holidays: department.holidays.map((holiday) => ({
      id: holiday.id,
      name: holiday.name,
      date: holiday.date.toISOString(),
      isRecurring: holiday.isRecurring,
      routingType: holiday.routingType,
      routingValue: holiday.routingValue,
    })),
    agents: department.users.map((membership) => ({
      id: membership.id,
      userId: membership.user.id,
      userName: membership.user.name,
      userEmail: membership.user.email,
      order: membership.order,
    })),
    phoneNumbers: department.phoneNumbers.map((pn) => ({
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
    createdAt: department.createdAt.toISOString(),
    updatedAt: department.updatedAt.toISOString(),
    deletedAt: department.deletedAt?.toISOString() ?? null,
  };
}
