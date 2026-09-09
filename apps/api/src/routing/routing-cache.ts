import type { Prisma, PrismaClient } from '@repo/db';
import {
  type CachedDepartment,
  type CachedRouting,
  ROUTING_CACHE,
} from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';

/*
 * The call controller never reads Postgres. It routes inbound calls from the
 * `routing:phone:{e164}` entries this module writes, so every place that
 * turns department or user rows into routing data goes through here: the
 * startup warm-up, the controller's cache-miss lookup, and every admin
 * mutation that changes where a number rings.
 */

/** Only numbers in service route; reserved and released ones fall through to 404. */
const routableNumber = {
  deletedAt: null,
  status: 'ACTIVE',
} as const satisfies Prisma.PhoneNumberWhereInput;

/** Everything the controller needs to ring a department, in ring order. */
export const routingDepartmentInclude = {
  users: {
    where: { user: { deletedAt: null } },
    select: { userId: true, order: true },
    orderBy: { order: 'asc' },
  },
  settings: true,
  businessHours: { orderBy: { dayOfWeek: 'asc' } },
  holidays: true,
} as const satisfies Prisma.DepartmentInclude;

export type RoutingDepartmentRow = Prisma.DepartmentGetPayload<{
  include: typeof routingDepartmentInclude;
}>;

export interface RoutingUserRow {
  id: string;
  name: string | null;
}

export interface RoutingCacheWarmResult {
  departments: number;
  users: number;
}

export function projectDepartmentRouting(
  department: RoutingDepartmentRow,
  cachedAt: string,
): CachedRouting {
  const orderedUsers = department.users.map((membership) => ({
    userId: membership.userId,
    order: membership.order,
  }));
  const settings = department.settings;

  return {
    type: 'DEPARTMENT',
    userIds: orderedUsers.map((user) => user.userId),
    orderedUsers,
    settings: settings
      ? {
          timezone: settings.timezone,
          is24Hours: settings.is24Hours,
          openHoursRoutingType: settings.openHoursRoutingType,
          ringDuration: settings.ringDuration,
          closedHoursRoutingType: settings.closedHoursRoutingType,
          closedHoursExternalNumber: settings.closedHoursExternalNumber,
          voicemailGreetingUrl: settings.voicemailGreetingUrl,
          businessHours: department.businessHours.map((hours) => ({
            dayOfWeek: hours.dayOfWeek,
            isOpen: hours.isOpen,
            openTime: hours.openTime,
            closeTime: hours.closeTime,
          })),
          holidays: department.holidays.map((holiday) => ({
            name: holiday.name,
            date: holiday.date.toISOString(),
            isRecurring: holiday.isRecurring,
            routingType: holiday.routingType,
            routingValue: holiday.routingValue,
          })),
        }
      : undefined,
    departmentId: department.id,
    departmentName: department.name,
    cachedAt,
  };
}

export function projectUserRouting(
  user: RoutingUserRow,
  cachedAt: string,
): CachedRouting {
  return {
    type: 'USER',
    userIds: [user.id],
    userId: user.id,
    userName: user.name ?? undefined,
    cachedAt,
  };
}

/** The `department:id:` entry is the department half of a routing entry. */
function projectDepartmentSummary(
  routing: CachedRouting,
): CachedDepartment | null {
  if (routing.type !== 'DEPARTMENT' || !routing.departmentId) {
    return null;
  }

  return {
    id: routing.departmentId,
    name: routing.departmentName ?? '',
    userIds: routing.userIds,
    cachedAt: routing.cachedAt,
  };
}

function phoneKey(phoneNumber: string): string {
  return `${ROUTING_CACHE.PHONE_KEY_PREFIX}${phoneNumber}`;
}

function departmentKey(departmentId: string): string {
  return `${ROUTING_CACHE.DEPARTMENT_ID_KEY_PREFIX}${departmentId}`;
}

export class RoutingCacheService {
  constructor(
    private readonly redis: Redis,
    private readonly db: PrismaClient,
    private readonly ttlSeconds: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Resolves one number from the database and caches the result. Returns null
   * when the number is unknown, out of service, or assigned to nobody.
   */
  async lookupByPhone(phoneNumber: string): Promise<CachedRouting | null> {
    const routing = await this.loadRouting(phoneNumber);

    if (!routing) {
      return null;
    }

    const pipeline = this.redis.pipeline();
    this.queueRouting(pipeline, phoneNumber, routing);
    await pipeline.exec();

    return routing;
  }

  /**
   * Recomputes the entries for numbers whose assignment or status changed.
   * Numbers that no longer route anywhere lose their entry.
   */
  async refreshPhoneNumbers(phoneNumbers: readonly string[]): Promise<void> {
    if (phoneNumbers.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();

    for (const phoneNumber of phoneNumbers) {
      const routing = await this.loadRouting(phoneNumber);

      if (routing) {
        this.queueRouting(pipeline, phoneNumber, routing);
      } else {
        pipeline.del(phoneKey(phoneNumber));
      }
    }

    await pipeline.exec();
    this.log.debug({ count: phoneNumbers.length }, 'Routing cache refreshed');
  }

  /**
   * Rewrites every entry a department contributes after its agents, hours,
   * holidays, settings, or name changed. A deleted department loses its entry;
   * its numbers are refreshed by the mutation that reassigned them.
   */
  async refreshDepartment(departmentId: string): Promise<void> {
    const department = await this.db.department.findFirst({
      where: { id: departmentId, deletedAt: null },
      include: {
        ...routingDepartmentInclude,
        phoneNumbers: { where: routableNumber, select: { phoneNumber: true } },
      },
    });
    const pipeline = this.redis.pipeline();

    if (!department) {
      pipeline.del(departmentKey(departmentId));
    } else {
      const routing = projectDepartmentRouting(
        department,
        new Date().toISOString(),
      );
      this.queueDepartmentSummary(pipeline, routing);

      for (const { phoneNumber } of department.phoneNumbers) {
        pipeline.set(
          phoneKey(phoneNumber),
          JSON.stringify(routing),
          'EX',
          this.ttlSeconds,
        );
      }
    }

    await pipeline.exec();
    this.log.debug({ departmentId }, 'Routing cache refreshed');
  }

  /** Writes every routable number, so a fresh Redis serves calls immediately. */
  async warmAll(): Promise<RoutingCacheWarmResult> {
    const cachedAt = new Date().toISOString();
    const [departments, directLines] = await Promise.all([
      this.db.department.findMany({
        where: { deletedAt: null },
        include: {
          ...routingDepartmentInclude,
          phoneNumbers: {
            where: routableNumber,
            select: { phoneNumber: true },
          },
        },
      }),
      this.db.phoneNumber.findMany({
        where: {
          ...routableNumber,
          departmentId: null,
          user: { is: { deletedAt: null } },
        },
        select: {
          phoneNumber: true,
          user: { select: { id: true, name: true } },
        },
      }),
    ]);
    const pipeline = this.redis.pipeline();
    const result: RoutingCacheWarmResult = { departments: 0, users: 0 };

    for (const department of departments) {
      if (department.phoneNumbers.length === 0) {
        continue;
      }

      const routing = projectDepartmentRouting(department, cachedAt);
      this.queueDepartmentSummary(pipeline, routing);

      for (const { phoneNumber } of department.phoneNumbers) {
        pipeline.set(
          phoneKey(phoneNumber),
          JSON.stringify(routing),
          'EX',
          this.ttlSeconds,
        );
      }

      result.departments += 1;
    }

    for (const line of directLines) {
      if (!line.user) {
        continue;
      }

      pipeline.set(
        phoneKey(line.phoneNumber),
        JSON.stringify(projectUserRouting(line.user, cachedAt)),
        'EX',
        this.ttlSeconds,
      );
      result.users += 1;
    }

    await pipeline.exec();
    this.log.info(result, 'Routing cache warmed');

    return result;
  }

  private async loadRouting(
    phoneNumber: string,
  ): Promise<CachedRouting | null> {
    const row = await this.db.phoneNumber.findFirst({
      where: { phoneNumber, ...routableNumber },
      include: {
        department: { include: routingDepartmentInclude },
        user: { select: { id: true, name: true, deletedAt: true } },
      },
    });

    if (!row) {
      return null;
    }

    const cachedAt = new Date().toISOString();

    if (row.department && !row.department.deletedAt) {
      return projectDepartmentRouting(row.department, cachedAt);
    }

    if (row.user && !row.user.deletedAt) {
      return projectUserRouting(row.user, cachedAt);
    }

    return null;
  }

  private queueRouting(
    pipeline: ReturnType<Redis['pipeline']>,
    phoneNumber: string,
    routing: CachedRouting,
  ): void {
    pipeline.set(
      phoneKey(phoneNumber),
      JSON.stringify(routing),
      'EX',
      this.ttlSeconds,
    );
    this.queueDepartmentSummary(pipeline, routing);
  }

  private queueDepartmentSummary(
    pipeline: ReturnType<Redis['pipeline']>,
    routing: CachedRouting,
  ): void {
    const summary = projectDepartmentSummary(routing);

    if (summary) {
      pipeline.set(
        departmentKey(summary.id),
        JSON.stringify(summary),
        'EX',
        this.ttlSeconds,
      );
    }
  }
}
