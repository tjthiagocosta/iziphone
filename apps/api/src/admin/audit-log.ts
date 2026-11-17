import type { Prisma, PrismaClient } from '@repo/db';

export type AuditAction =
  | 'user.created'
  /** A fresh invite link for someone who has not set a password yet. */
  | 'user.invited'
  /** A reset link for someone who is locked out; never the password itself. */
  | 'user.password_reset_issued'
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
  | 'department.greeting_uploaded'
  | 'department.greeting_removed'
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
  /** A number the Twilio account already held, brought into the list; records what it had attached. */
  | 'phone_number.imported'
  | 'phone_number.updated'
  | 'phone_number.released'
  | 'phone_number.assigned'
  | 'phone_number.unassigned'
  /**
   * Reconnect asked Twilio to point it here again. Written before Twilio is
   * changed, with what the number carried (`previously`), so it stands even
   * when the change then failed.
   */
  | 'phone_number.reconnected'
  /** Twilio refused a release; says whether the number went back to the reserve. */
  | 'phone_number.release_failed'
  /** A number just bought or added joined a messaging service (`from` null, `to`). */
  | 'phone_number.messaging_service_joined'
  /**
   * An admin put the number in a messaging service from its page. Written
   * before Twilio is changed, naming the service it leaves (`from`, null for
   * none) and the one it joins (`to`), so it stands when the move then fails.
   */
  | 'phone_number.messaging_service_changed'
  | 'settings.recording_retention_updated'
  /** The messaging service new local numbers join (`from`, `to`, either null for none). */
  | 'settings.default_messaging_service_updated'
  | 'recording.deleted'
  /** One entry per sweep run, summarising it; never one per recording. */
  | 'recording.retention_swept';

export type EntityType =
  | 'User'
  | 'Department'
  | 'PhoneNumber'
  | 'Holiday'
  | 'SystemSettings'
  | 'CallRecording';

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
