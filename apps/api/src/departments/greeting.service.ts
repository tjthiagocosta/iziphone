import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditLogService } from '../admin/index.js';
import { HttpError } from '../infra/index.js';
import type { MediaStore, StoredObject } from '../media-store/index.js';
import {
  departmentGreetingUrl,
  type RoutingCacheService,
} from '../routing/index.js';
import {
  GREETING_FORMATS,
  type GreetingRejection,
  inspectGreetingFile,
} from './greeting-file.js';

/*
 * The voicemail greeting a department plays before the beep. An admin
 * uploads the file, it lives in the media store, and Twilio fetches it from
 * this API by an id nobody can guess. The settings row names the current
 * one; the routing cache carries its URL to the call controller.
 */

interface DepartmentGreetingServiceDeps {
  db: PrismaClient;
  mediaStore: MediaStore;
  /** Where this API is reached from outside; the greeting URL is built on it. */
  publicUrl: string;
  auditLog: AuditLogService;
  routingCache: RoutingCacheService;
  log: FastifyBaseLogger;
}

export interface GreetingUpload {
  /** The request's declared type, parameters and all. */
  contentType: string | undefined;
  bytes: Buffer;
}

/** What the settings row says about the greeting: both null when there is none. */
interface GreetingColumns {
  voicemailGreetingId: string | null;
  voicemailGreetingKey: string | null;
}

const REJECTION_STATUS: Record<GreetingRejection['reason'], 400 | 413 | 415> = {
  unsupported_type: 415,
  not_audio: 415,
  empty: 400,
  too_large: 413,
};

/** An upload this service refuses, carrying the status the route answers with. */
export class GreetingRejectedError extends HttpError {
  constructor(readonly rejection: GreetingRejection) {
    super(describeRejection(rejection), REJECTION_STATUS[rejection.reason]);
  }
}

/**
 * Another admin changed the greeting between this request reading it and
 * writing it. Overwriting would silently drop their upload and strand its
 * file, so the request is refused and the console asked to reload.
 */
export class GreetingChangedError extends HttpError {
  constructor() {
    super(
      'The greeting was changed by someone else; reload and try again',
      409,
    );
  }
}

export class DepartmentGreetingService {
  private readonly db: PrismaClient;
  private readonly mediaStore: MediaStore;
  private readonly publicUrl: string;
  private readonly auditLog: AuditLogService;
  private readonly routingCache: RoutingCacheService;
  private readonly log: FastifyBaseLogger;

  constructor(deps: DepartmentGreetingServiceDeps) {
    this.db = deps.db;
    this.mediaStore = deps.mediaStore;
    this.publicUrl = deps.publicUrl;
    this.auditLog = deps.auditLog;
    this.routingCache = deps.routingCache;
    this.log = deps.log;
  }

  /**
   * Makes the upload the department's greeting, replacing the one it had.
   * Resolves the URL the greeting is served from, or `null` when there is
   * no such department. Throws `GreetingRejectedError` for a file that is
   * not one of the accepted audio formats.
   */
  async upload(
    departmentId: string,
    upload: GreetingUpload,
    actorId: string,
    ipAddress?: string,
  ): Promise<string | null> {
    const settings = await this.findSettings(departmentId);

    if (!settings) {
      return null;
    }

    const inspection = inspectGreetingFile(upload.contentType, upload.bytes);

    if (!inspection.ok) {
      throw new GreetingRejectedError(inspection.rejection);
    }

    const format = GREETING_FORMATS[inspection.format];
    const greetingId = randomUUID();
    const key = `greetings/${departmentId}/${greetingId}.${format.extension}`;

    // The bytes go in first: a row that names an object which is not there
    // would hand Twilio a URL that answers 404.
    await this.mediaStore.put({
      key,
      contentType: format.contentType,
      body: upload.bytes,
    });

    try {
      await this.db.$transaction(async (tx) => {
        await this.replaceGreeting(tx, departmentId, settings, {
          voicemailGreetingId: greetingId,
          voicemailGreetingKey: key,
        });
        await this.auditLog.create(
          {
            action: 'department.greeting_uploaded',
            entityType: 'Department',
            entityId: departmentId,
            userId: actorId,
            changes: {
              greetingId,
              contentType: format.contentType,
              sizeBytes: upload.bytes.byteLength,
              replacedGreetingId: settings.voicemailGreetingId,
            },
            ipAddress,
          },
          tx,
        );
      });
    } catch (error) {
      await this.discard(key, departmentId);
      throw error;
    }

    if (settings.voicemailGreetingKey) {
      await this.discard(settings.voicemailGreetingKey, departmentId);
    }

    await this.routingCache.refreshDepartment(departmentId);

    return departmentGreetingUrl(this.publicUrl, greetingId);
  }

  /**
   * Takes the department's greeting away, so callers hear the spoken one
   * again. Resolves `false` when there is no such department; a department
   * without a greeting is left as it is.
   */
  async remove(
    departmentId: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<boolean> {
    const settings = await this.findSettings(departmentId);

    if (!settings) {
      return false;
    }

    if (!settings.voicemailGreetingId) {
      return true;
    }

    await this.db.$transaction(async (tx) => {
      await this.replaceGreeting(tx, departmentId, settings, {
        voicemailGreetingId: null,
        voicemailGreetingKey: null,
      });
      await this.auditLog.create(
        {
          action: 'department.greeting_removed',
          entityType: 'Department',
          entityId: departmentId,
          userId: actorId,
          changes: { greetingId: settings.voicemailGreetingId },
          ipAddress,
        },
        tx,
      );
    });

    if (settings.voicemailGreetingKey) {
      await this.discard(settings.voicemailGreetingKey, departmentId);
    }

    await this.routingCache.refreshDepartment(departmentId);

    return true;
  }

  /** The greeting's bytes and type for the public route; `null` when the id names nothing. */
  async open(greetingId: string): Promise<StoredObject | null> {
    const settings = await this.db.departmentSettings.findUnique({
      where: { voicemailGreetingId: greetingId },
      select: { voicemailGreetingKey: true },
    });

    if (!settings?.voicemailGreetingKey) {
      return null;
    }

    return this.mediaStore.get(settings.voicemailGreetingKey);
  }

  private findSettings(departmentId: string): Promise<GreetingColumns | null> {
    return this.db.departmentSettings.findFirst({
      where: { departmentId, department: { deletedAt: null } },
      select: { voicemailGreetingId: true, voicemailGreetingKey: true },
    });
  }

  /**
   * Writes the greeting columns only if they still hold what `read` saw, so
   * two admins acting on the same department at once cannot overwrite each
   * other: the later one is told to reload instead.
   */
  private async replaceGreeting(
    tx: Prisma.TransactionClient,
    departmentId: string,
    read: GreetingColumns,
    next: GreetingColumns,
  ): Promise<void> {
    const { count } = await tx.departmentSettings.updateMany({
      where: { departmentId, voicemailGreetingId: read.voicemailGreetingId },
      data: next,
    });

    if (count !== 1) {
      throw new GreetingChangedError();
    }
  }

  /**
   * Best effort: the row no longer names this object, so a failure here
   * leaves an orphan in the bucket, not a broken greeting. The warning is
   * what there is to find it by.
   */
  private async discard(key: string, departmentId: string): Promise<void> {
    try {
      await this.mediaStore.delete(key);
    } catch (error) {
      this.log.warn(
        { err: error, departmentId, key },
        'Could not delete a voicemail greeting the department no longer uses',
      );
    }
  }
}

function describeRejection(rejection: GreetingRejection): string {
  switch (rejection.reason) {
    case 'unsupported_type':
      return 'Upload an MP3, WAV or AIFF file';
    case 'not_audio':
      return rejection.declared
        ? `The file is not a ${rejection.declared.toUpperCase()} recording`
        : 'The file is not an MP3, WAV or AIFF recording';
    case 'empty':
      return 'The file is empty';
    case 'too_large':
      return `The file is larger than ${Math.floor(rejection.maxBytes / (1024 * 1024))} MB`;
  }
}
