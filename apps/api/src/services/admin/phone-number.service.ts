import type { Prisma, PrismaClient } from '@repo/db';
import {
  type AvailableNumbersResponse,
  type PhoneNumberListQuery,
  type PhoneNumberListResponse,
  type PhoneNumberResponse,
  type PurchasePhoneNumber,
  type SearchAvailableNumbers,
  SUPPORTED_NUMBER_COUNTRY,
  type UpdatePhoneNumber,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type {
  OwnedNumberMetadata,
  TwilioNumberManagementService,
} from '../providers/twilio-number-management.service.js';
import type { RoutingCacheService } from '../routing-cache.service.js';
import type { AuditLogService } from './audit-log.service.js';
import { AdminServiceError } from './errors.js';

const phoneNumberInclude = {
  user: { select: { id: true, name: true, email: true } },
  department: { select: { id: true, name: true } },
} as const satisfies Prisma.PhoneNumberInclude;

type PhoneNumberRow = Prisma.PhoneNumberGetPayload<{
  include: typeof phoneNumberInclude;
}>;

/** The provider calls the service makes; tests substitute a fake. */
export type NumberProvider = Pick<
  TwilioNumberManagementService,
  | 'searchAvailableNumbers'
  | 'buyNumber'
  | 'configureNumber'
  | 'getOwnedNumberMetadata'
  | 'cancelNumber'
>;

interface Assignment {
  userId?: string | null | undefined;
  departmentId?: string | null | undefined;
}

export class PhoneNumberService {
  constructor(
    private readonly db: PrismaClient,
    private readonly log: FastifyBaseLogger,
    private readonly auditLog: AuditLogService,
    private readonly routingCache: RoutingCacheService,
    private readonly provider: NumberProvider,
  ) {}

  async list(query: PhoneNumberListQuery): Promise<PhoneNumberListResponse> {
    const { page, limit, status, type, unassigned, search } = query;
    const where: Prisma.PhoneNumberWhereInput = { deletedAt: null };

    if (status) {
      where.status = status;
    }

    if (type) {
      where.type = type;
    }

    if (unassigned) {
      where.userId = null;
      where.departmentId = null;
    }

    if (search) {
      where.OR = [
        { phoneNumber: { contains: search, mode: 'insensitive' } },
        { label: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [phoneNumbers, total] = await Promise.all([
      this.db.phoneNumber.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: phoneNumberInclude,
      }),
      this.db.phoneNumber.count({ where }),
    ]);

    return {
      phoneNumbers: phoneNumbers.map(toPhoneNumberResponse),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  searchAvailable(
    query: SearchAvailableNumbers,
  ): Promise<AvailableNumbersResponse> {
    return this.provider.searchAvailableNumbers(query);
  }

  async getById(id: string): Promise<PhoneNumberResponse | null> {
    const phoneNumber = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
      include: phoneNumberInclude,
    });

    return phoneNumber ? toPhoneNumberResponse(phoneNumber) : null;
  }

  /**
   * Buys the number, records it, then points its webhooks here. The row is
   * written before configuration so a webhook failure leaves a visible number
   * to retry instead of an orphan in the Twilio account.
   *
   * @throws AdminServiceError 400 on an invalid assignment target.
   */
  async purchase(
    data: PurchasePhoneNumber,
    actorId: string,
    ipAddress?: string,
  ): Promise<PhoneNumberResponse> {
    await this.assertAssignmentTarget(data);

    await this.provider.buyNumber({
      country: data.country,
      phoneNumber: data.phoneNumber,
    });

    let created: PhoneNumberRow;

    try {
      created = await this.db.$transaction(async (tx) => {
        const isPrimary = await this.resolvePrimaryAssignment(tx, data);
        const metadata = fallbackMetadata(data);
        const row = await tx.phoneNumber.create({
          data: {
            phoneNumber: metadata.phoneNumber,
            friendlyName: metadata.friendlyName,
            type: metadata.type,
            label: data.label,
            provider: 'TWILIO',
            locality: metadata.locality,
            region: metadata.region,
            country: metadata.country,
            voiceEnabled: metadata.voiceEnabled,
            smsEnabled: metadata.smsEnabled,
            mmsEnabled: metadata.mmsEnabled,
            faxEnabled: metadata.faxEnabled,
            userId: data.userId,
            departmentId: data.departmentId,
            isPrimary,
            status: data.userId || data.departmentId ? 'ACTIVE' : 'RESERVED',
            createdBy: actorId,
          },
          include: phoneNumberInclude,
        });

        await this.auditLog.create(
          {
            action: 'phone_number.purchased',
            entityType: 'PhoneNumber',
            entityId: row.id,
            userId: actorId,
            changes: {
              phoneNumber: row.phoneNumber,
              type: row.type,
              label: data.label,
              country: data.country,
            },
            ipAddress,
          },
          tx,
        );

        return row;
      });
    } catch (error) {
      this.log.error(
        { error, actorId },
        'Twilio number was bought but could not be recorded locally',
      );
      throw new AdminServiceError(
        'Twilio number was purchased but local persistence failed. Manual reconciliation is required.',
        500,
      );
    }

    await this.provider.configureNumber({
      country: data.country,
      phoneNumber: data.phoneNumber,
    });

    const metadata = await this.provider.getOwnedNumberMetadata(
      data.phoneNumber,
      data.type,
    );
    const configured = await this.db.phoneNumber.update({
      where: { id: created.id },
      data: metadata
        ? {
            friendlyName: metadata.friendlyName,
            type: metadata.type,
            locality: metadata.locality,
            region: metadata.region,
            country: metadata.country,
            voiceEnabled: metadata.voiceEnabled,
            smsEnabled: metadata.smsEnabled,
            mmsEnabled: metadata.mmsEnabled,
            faxEnabled: metadata.faxEnabled,
          }
        : {},
      include: phoneNumberInclude,
    });

    await this.routingCache.refreshPhoneNumbers([configured.phoneNumber]);
    this.log.info(
      { phoneNumberId: configured.id, actorId },
      'Phone number purchased',
    );

    return toPhoneNumberResponse(configured);
  }

  /** @throws AdminServiceError 400 on an invalid assignment target. */
  async update(
    id: string,
    data: UpdatePhoneNumber,
    actorId: string,
    ipAddress?: string,
  ): Promise<PhoneNumberResponse | null> {
    const existing = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      return null;
    }

    await this.assertAssignmentTarget(data);

    // Naming either owner replaces the whole assignment; naming neither keeps it.
    const assignmentChanged =
      data.userId !== undefined || data.departmentId !== undefined;
    const nextUserId = assignmentChanged
      ? (data.userId ?? null)
      : existing.userId;
    const nextDepartmentId = assignmentChanged
      ? (data.departmentId ?? null)
      : existing.departmentId;
    const updateData: Prisma.PhoneNumberUpdateInput = {
      updatedBy: actorId,
      label: data.label,
      isPrimary: nextDepartmentId ? data.isPrimary : false,
    };

    if (assignmentChanged) {
      updateData.user = nextUserId
        ? { connect: { id: nextUserId } }
        : { disconnect: true };
      updateData.department = nextDepartmentId
        ? { connect: { id: nextDepartmentId } }
        : { disconnect: true };
      updateData.status =
        nextUserId || nextDepartmentId ? 'ACTIVE' : 'RESERVED';
    }

    const changes: Record<string, unknown> = {};

    if (data.label !== undefined && data.label !== existing.label) {
      changes.label = { from: existing.label, to: data.label };
    }
    if (data.userId !== undefined && data.userId !== existing.userId) {
      changes.userId = { from: existing.userId, to: data.userId };
    }
    if (
      data.departmentId !== undefined &&
      data.departmentId !== existing.departmentId
    ) {
      changes.departmentId = {
        from: existing.departmentId,
        to: data.departmentId,
      };
    }
    if (data.isPrimary !== undefined && data.isPrimary !== existing.isPrimary) {
      changes.isPrimary = { from: existing.isPrimary, to: data.isPrimary };
    }

    const updated = await this.db.$transaction(async (tx) => {
      // A department has one primary number; promoting this one demotes the rest.
      if (updateData.isPrimary === true && nextDepartmentId) {
        await tx.phoneNumber.updateMany({
          where: {
            departmentId: nextDepartmentId,
            isPrimary: true,
            id: { not: id },
          },
          data: { isPrimary: false },
        });
      }

      const row = await tx.phoneNumber.update({
        where: { id },
        data: updateData,
        include: phoneNumberInclude,
      });

      if (Object.keys(changes).length > 0) {
        await this.auditLog.create(
          {
            action: 'phone_number.updated',
            entityType: 'PhoneNumber',
            entityId: id,
            userId: actorId,
            changes,
            ipAddress,
          },
          tx,
        );
      }

      return row;
    });

    if (changes.userId || changes.departmentId) {
      await this.routingCache.refreshPhoneNumbers([updated.phoneNumber]);
    }

    return toPhoneNumberResponse(updated);
  }

  /** Cancels the number with the provider first; a number we still pay for must stay visible. */
  async release(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const phoneNumber = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
      select: { id: true, phoneNumber: true, country: true },
    });

    if (!phoneNumber) {
      return false;
    }

    await this.provider.cancelNumber({
      country: phoneNumber.country ?? SUPPORTED_NUMBER_COUNTRY,
      phoneNumber: phoneNumber.phoneNumber,
    });

    await this.db.$transaction(async (tx) => {
      await tx.phoneNumber.update({
        where: { id },
        data: {
          status: 'RELEASED',
          deletedAt: new Date(),
          userId: null,
          departmentId: null,
          isPrimary: false,
          updatedBy: actorId,
        },
      });
      await this.auditLog.create(
        {
          action: 'phone_number.released',
          entityType: 'PhoneNumber',
          entityId: id,
          userId: actorId,
          changes: { phoneNumber: phoneNumber.phoneNumber },
          ipAddress,
        },
        tx,
      );
    });

    await this.routingCache.refreshPhoneNumbers([phoneNumber.phoneNumber]);
    this.log.info({ phoneNumberId: id, actorId }, 'Phone number released');

    return true;
  }

  private async assertAssignmentTarget(assignment: Assignment): Promise<void> {
    if (assignment.userId && assignment.departmentId) {
      throw new AdminServiceError(
        'Cannot assign phone number to both user and department',
      );
    }

    if (assignment.userId) {
      const user = await this.db.user.findUnique({
        where: { id: assignment.userId, deletedAt: null },
        select: { id: true },
      });

      if (!user) {
        throw new AdminServiceError('User not found');
      }
    }

    if (assignment.departmentId) {
      const department = await this.db.department.findUnique({
        where: { id: assignment.departmentId, deletedAt: null },
        select: { id: true },
      });

      if (!department) {
        throw new AdminServiceError('Department not found');
      }
    }
  }

  /** A department's first number becomes primary; a later one only on request. */
  private async resolvePrimaryAssignment(
    tx: Prisma.TransactionClient,
    data: PurchasePhoneNumber,
  ): Promise<boolean> {
    if (!data.departmentId) {
      return false;
    }

    const existingPrimary = await tx.phoneNumber.count({
      where: {
        departmentId: data.departmentId,
        deletedAt: null,
        isPrimary: true,
      },
    });

    if (existingPrimary === 0) {
      return true;
    }

    if (data.isPrimary) {
      await tx.phoneNumber.updateMany({
        where: {
          departmentId: data.departmentId,
          deletedAt: null,
          isPrimary: true,
        },
        data: { isPrimary: false },
      });
    }

    return data.isPrimary;
  }
}

/** What we know about a number before Twilio confirms its metadata. */
function fallbackMetadata(data: PurchasePhoneNumber): OwnedNumberMetadata {
  return {
    phoneNumber: data.phoneNumber,
    friendlyName: data.phoneNumber,
    type: data.type,
    providerType: data.type === 'TOLL_FREE' ? 'toll-free' : 'local',
    locality: null,
    region: null,
    country: data.country,
    voiceEnabled: true,
    smsEnabled: true,
    mmsEnabled: false,
    faxEnabled: false,
  };
}

function toPhoneNumberResponse(
  phoneNumber: PhoneNumberRow,
): PhoneNumberResponse {
  let assignedTo: PhoneNumberResponse['assignedTo'] = null;

  if (phoneNumber.user) {
    assignedTo = {
      type: 'user',
      id: phoneNumber.user.id,
      name: phoneNumber.user.name || phoneNumber.user.email,
    };
  } else if (phoneNumber.department) {
    assignedTo = {
      type: 'department',
      id: phoneNumber.department.id,
      name: phoneNumber.department.name,
    };
  }

  return {
    id: phoneNumber.id,
    phoneNumber: phoneNumber.phoneNumber,
    friendlyName: phoneNumber.friendlyName,
    type: phoneNumber.type,
    label: phoneNumber.label,
    provider: phoneNumber.provider,
    locality: phoneNumber.locality,
    region: phoneNumber.region,
    country: phoneNumber.country,
    voiceEnabled: phoneNumber.voiceEnabled,
    smsEnabled: phoneNumber.smsEnabled,
    mmsEnabled: phoneNumber.mmsEnabled,
    faxEnabled: phoneNumber.faxEnabled,
    status: phoneNumber.status,
    isPrimary: phoneNumber.isPrimary,
    assignedTo,
    createdAt: phoneNumber.createdAt.toISOString(),
    updatedAt: phoneNumber.updatedAt.toISOString(),
  };
}
