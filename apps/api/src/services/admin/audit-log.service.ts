import type { Prisma, PrismaClient } from '@repo/db';

export type AuditAction =
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  | 'user.restored'
  | 'user.department_assigned'
  | 'user.department_removed'
  | 'user.phone_number_assigned'
  | 'user.phone_number_removed'
  | 'department.created'
  | 'department.updated'
  | 'department.deleted'
  | 'department.restored'
  | 'department.settings_updated'
  | 'department.business_hours_updated'
  | 'department.holiday_created'
  | 'department.holiday_updated'
  | 'department.holiday_deleted'
  | 'department.agent_added'
  | 'department.agent_removed'
  | 'department.agent_order_updated'
  | 'department.phone_number_assigned'
  | 'department.phone_number_removed'
  | 'phone_number.purchased'
  | 'phone_number.updated'
  | 'phone_number.released'
  | 'phone_number.assigned'
  | 'phone_number.unassigned';

export type EntityType = 'User' | 'Department' | 'PhoneNumber' | 'Holiday';

export interface AuditLogParams {
  action: AuditAction;
  entityType: EntityType;
  entityId: string;
  userId?: string;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/** The client a mutation runs on: the pool, or the transaction it is part of. */
export type AuditLogWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * Records who changed what through the admin API. An entry that cannot be
 * written fails the mutation it belongs to; pass the transaction client so
 * both commit together.
 */
export class AuditLogService {
  constructor(private readonly db: PrismaClient) {}

  async create(
    params: AuditLogParams,
    writer: AuditLogWriter = this.db,
  ): Promise<void> {
    await writer.auditLog.create({
      data: {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        userId: params.userId,
        changes: params.changes as Prisma.InputJsonValue,
        metadata: params.metadata as Prisma.InputJsonValue,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
    });
  }
}
