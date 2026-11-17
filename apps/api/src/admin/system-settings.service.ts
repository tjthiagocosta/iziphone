import type { PrismaClient } from '@repo/db';
import type {
  RecordingRetention,
  SystemSettingsResponse,
  UpdateRecordingRetention,
} from '@repo/dto';
import type { AuditLogService } from './audit-log.js';

/*
 * The deployment's own settings. One row, because this is one stack per
 * customer: `id` is fixed, and the row is written the first time an admin
 * changes anything rather than seeded, so a fresh database needs no migration
 * of its own to answer.
 */

export const SYSTEM_SETTINGS_ID = 'system';

/** What the settings say before anybody has changed them. */
export const DEFAULT_RECORDING_RETENTION: RecordingRetention = {
  voicemail: 'KEEP_UNTIL_DELETED',
  callRecordings: 'KEEP_UNTIL_DELETED',
};

const SETTINGS_SELECT = {
  voicemailRetention: true,
  callRecordingRetention: true,
  updatedAt: true,
} as const;

interface SettingsRow {
  voicemailRetention: RecordingRetention['voicemail'];
  callRecordingRetention: RecordingRetention['callRecordings'];
  updatedAt: Date;
}

export class SystemSettingsService {
  constructor(
    private readonly db: Pick<PrismaClient, 'systemSettings' | '$transaction'>,
    private readonly auditLog: AuditLogService,
  ) {}

  /** The settings as the console reads them, defaults included. */
  async read(): Promise<SystemSettingsResponse> {
    const row = await this.db.systemSettings.findUnique({
      where: { id: SYSTEM_SETTINGS_ID },
      select: SETTINGS_SELECT,
    });

    return {
      recordingRetention: retentionOf(row),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** The messaging service new local numbers join, or null for none. */
  async readDefaultMessagingService(): Promise<string | null> {
    const row = await this.db.systemSettings.findUnique({
      where: { id: SYSTEM_SETTINGS_ID },
      select: { defaultMessagingServiceSid: true },
    });

    return row?.defaultMessagingServiceSid ?? null;
  }

  /**
   * Stores the messaging service new local numbers join, with an audit entry
   * naming the one before. Whether the service can be the default is the
   * caller's to check: only it can ask Twilio.
   */
  async updateDefaultMessagingService(
    messagingServiceSid: string | null,
    actorId: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const previous = await tx.systemSettings.findUnique({
        where: { id: SYSTEM_SETTINGS_ID },
        select: { defaultMessagingServiceSid: true },
      });

      await tx.systemSettings.upsert({
        where: { id: SYSTEM_SETTINGS_ID },
        create: {
          id: SYSTEM_SETTINGS_ID,
          defaultMessagingServiceSid: messagingServiceSid,
        },
        update: { defaultMessagingServiceSid: messagingServiceSid },
        select: { id: true },
      });

      await this.auditLog.create(
        {
          action: 'settings.default_messaging_service_updated',
          entityType: 'SystemSettings',
          entityId: SYSTEM_SETTINGS_ID,
          userId: actorId,
          changes: {
            from: previous?.defaultMessagingServiceSid ?? null,
            to: messagingServiceSid,
          },
          ipAddress,
        },
        tx,
      );
    });
  }

  /** What the retention sweep reads before each run. */
  async readRecordingRetention(): Promise<RecordingRetention> {
    const { recordingRetention } = await this.read();

    return recordingRetention;
  }

  /**
   * Sets both retention policies. They are written together so the audit entry
   * records one decision, with what each policy was before it: shortening a
   * policy is what makes the next sweep delete recordings, and that has to be
   * readable afterwards.
   */
  async updateRecordingRetention(
    next: UpdateRecordingRetention,
    actorId: string,
    ipAddress?: string,
  ): Promise<SystemSettingsResponse> {
    const row = await this.db.$transaction(async (tx) => {
      const previous = await tx.systemSettings.findUnique({
        where: { id: SYSTEM_SETTINGS_ID },
        select: SETTINGS_SELECT,
      });

      const written = await tx.systemSettings.upsert({
        where: { id: SYSTEM_SETTINGS_ID },
        create: {
          id: SYSTEM_SETTINGS_ID,
          voicemailRetention: next.voicemail,
          callRecordingRetention: next.callRecordings,
        },
        update: {
          voicemailRetention: next.voicemail,
          callRecordingRetention: next.callRecordings,
        },
        select: SETTINGS_SELECT,
      });

      await this.auditLog.create(
        {
          action: 'settings.recording_retention_updated',
          entityType: 'SystemSettings',
          entityId: SYSTEM_SETTINGS_ID,
          userId: actorId,
          changes: { from: retentionOf(previous), to: next },
          ipAddress,
        },
        tx,
      );

      return written;
    });

    return {
      recordingRetention: retentionOf(row),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function retentionOf(row: SettingsRow | null): RecordingRetention {
  return row
    ? {
        voicemail: row.voicemailRetention,
        callRecordings: row.callRecordingRetention,
      }
    : DEFAULT_RECORDING_RETENTION;
}
