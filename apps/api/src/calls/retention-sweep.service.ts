import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import type { RecordingRetention } from '@repo/dto';
import { RETENTION_SWEEP_LOCK } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import {
  type AuditLogService,
  SYSTEM_SETTINGS_ID,
  type SystemSettingsService,
} from '../admin/index.js';
import {
  type CallRecordingRow,
  type CallRecordingService,
  RECORDING_SELECT,
} from './recording.service.js';
import {
  claimableCopyWhere,
  expiryScans,
  hasTimeLeft,
  isExpired,
  policyFor,
  sweepDeadline,
} from './retention.js';

/*
 * The retention sweep. Once an hour, one API instance deletes the recordings
 * that have outlived the policy covering them, and picks up the work earlier
 * attempts left owed: copies that never completed, and deletions Twilio
 * refused. Each kind of work is bounded per run, so a backlog drains over
 * several hours instead of holding the pool for one long one.
 *
 * What is decided lives in `retention.ts`; this reads, deletes and reports.
 */

/** How many recordings one run touches, per kind of work. */
const PER_RUN = {
  expired: 200,
  owedCopies: 25,
  owedProviderDeletions: 50,
} as const;

/** Frees the lock only when this run still holds it. */
const RELEASE_LOCK = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

export interface RetentionSweepOutcome {
  /** False when another instance held the lock: nothing was read or written. */
  ran: boolean;
  /** Recordings whose audio the policy deleted. */
  deleted: number;
  /** Copies an earlier attempt owed and this run completed. */
  copied: number;
  /** Recordings this run finally deleted at Twilio. */
  providerDeleted: number;
  /** Deletions that failed again and stay owed. */
  failed: number;
  /** The run stopped while its lock was still its own; the rest waits. */
  ranOutOfTime: boolean;
}

const NOTHING: Omit<RetentionSweepOutcome, 'ran'> = {
  deleted: 0,
  copied: 0,
  providerDeleted: 0,
  failed: 0,
  ranOutOfTime: false,
};

/** A recording with the conversation it belongs to, which every step needs. */
const SWEEP_SELECT = {
  ...RECORDING_SELECT,
  createdAt: true,
  call: { select: { conversationUuid: true } },
} as const;

type SweepRow = CallRecordingRow & {
  createdAt: Date;
  call: { conversationUuid: string };
};

export interface RecordingRetentionSweepDeps {
  db: Pick<PrismaClient, 'callRecording'>;
  redis: Pick<Redis, 'set' | 'eval'>;
  settings: Pick<SystemSettingsService, 'readRecordingRetention'>;
  recordings: Pick<CallRecordingService, 'copy' | 'deleteAudio'>;
  auditLog: Pick<AuditLogService, 'create'>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

export class RecordingRetentionSweep {
  private readonly db: RecordingRetentionSweepDeps['db'];
  private readonly redis: RecordingRetentionSweepDeps['redis'];
  private readonly settings: RecordingRetentionSweepDeps['settings'];
  private readonly recordings: RecordingRetentionSweepDeps['recordings'];
  private readonly auditLog: RecordingRetentionSweepDeps['auditLog'];
  private readonly log: RecordingRetentionSweepDeps['log'];

  constructor(deps: RecordingRetentionSweepDeps) {
    this.db = deps.db;
    this.redis = deps.redis;
    this.settings = deps.settings;
    this.recordings = deps.recordings;
    this.auditLog = deps.auditLog;
    this.log = deps.log;
  }

  /**
   * One sweep, under a lock no two instances can hold at once. A run that
   * changed something writes one audit entry summarising it; a run with
   * nothing to do writes none, so an hourly sweep does not fill the audit log
   * with entries about having done nothing.
   */
  async run(): Promise<RetentionSweepOutcome> {
    const holder = randomUUID();

    if (!(await this.takeLock(holder))) {
      return { ran: false, ...NOTHING };
    }

    try {
      const now = new Date();
      const deadline = sweepDeadline(now);
      const retention = await this.settings.readRecordingRetention();

      const expired = await this.deleteExpired(retention, now, deadline);

      /*
       * Out of time already: the owed work is not even looked for. Asking for
       * it would spend what is left of the lock on two queries over the whole
       * backlog whose rows this run may no longer touch.
       */
      const copies = expired.ranOutOfTime
        ? { copied: 0, providerDeleted: 0, ranOutOfTime: true }
        : await this.retryOwedCopies(now, deadline);
      const deletions = copies.ranOutOfTime
        ? { providerDeleted: 0, ranOutOfTime: true }
        : await this.retryOwedProviderDeletions(deadline);

      const outcome: RetentionSweepOutcome = {
        ran: true,
        deleted: expired.deleted,
        copied: copies.copied,
        providerDeleted:
          expired.providerDeleted +
          copies.providerDeleted +
          deletions.providerDeleted,
        failed: expired.failed,
        ranOutOfTime:
          expired.ranOutOfTime || copies.ranOutOfTime || deletions.ranOutOfTime,
      };

      await this.report(retention, outcome);
      return outcome;
    } finally {
      await this.releaseLock(holder);
    }
  }

  /** Deletes the audio of every recording that has outlived its policy. */
  private async deleteExpired(
    retention: RecordingRetention,
    now: Date,
    deadline: Date,
  ): Promise<{
    deleted: number;
    /** Recordings this pass also removed at Twilio, never having copied them. */
    providerDeleted: number;
    failed: number;
    ranOutOfTime: boolean;
  }> {
    let deleted = 0;
    let providerDeleted = 0;
    let failed = 0;

    for (const scan of expiryScans(retention, now)) {
      const expired = await this.db.callRecording.findMany({
        where: {
          context: scan.context,
          deletedAt: null,
          createdAt: { lt: scan.cutoff },
        },
        orderBy: { createdAt: 'asc' },
        take: PER_RUN.expired,
        select: SWEEP_SELECT,
      });

      for (const recording of expired) {
        if (!hasTimeLeft(deadline, new Date())) {
          return { deleted, providerDeleted, failed, ranOutOfTime: true };
        }

        /*
         * The query already selected by the cutoff; this says again, from the
         * row itself, that the policy really covers it. Deleting audio cannot
         * be undone, so it is worth asking twice.
         */
        if (
          !isExpired(
            policyFor(retention, recording.context),
            recording.createdAt,
            now,
          )
        ) {
          continue;
        }

        const deletion = await this.recordings.deleteAudio(
          recording,
          recording.call.conversationUuid,
          'RETENTION_POLICY',
        );

        if (deletion.outcome === 'deleted') {
          deleted += 1;
          // A recording expired before its copy ever completed is removed at
          // Twilio here, and the run is accountable for that too.
          if (deletion.providerDeleted) providerDeleted += 1;
        }
        if (deletion.outcome === 'failed') failed += 1;
      }
    }

    return { deleted, providerDeleted, failed, ranOutOfTime: false };
  }

  /**
   * Recordings Twilio still holds and the store never got: a copy that failed
   * when the recording was announced, or a play that could not complete it.
   * A recording another process is copying right now is left to it.
   */
  private async retryOwedCopies(
    now: Date,
    deadline: Date,
  ): Promise<{
    copied: number;
    providerDeleted: number;
    ranOutOfTime: boolean;
  }> {
    const owed = await this.db.callRecording.findMany({
      where: { ...claimableCopyWhere(now), providerDeletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: PER_RUN.owedCopies,
      select: SWEEP_SELECT,
    });

    return this.copyEach(owed, deadline);
  }

  /**
   * Recordings that are settled here but still at Twilio, because an earlier
   * deletion failed. Copying is skipped; only the deletion is owed.
   */
  private async retryOwedProviderDeletions(deadline: Date): Promise<{
    providerDeleted: number;
    ranOutOfTime: boolean;
  }> {
    const owed = await this.db.callRecording.findMany({
      where: {
        providerDeletedAt: null,
        OR: [{ objectKey: { not: null } }, { deletedAt: { not: null } }],
      },
      orderBy: { createdAt: 'asc' },
      take: PER_RUN.owedProviderDeletions,
      select: SWEEP_SELECT,
    });

    const { providerDeleted, ranOutOfTime } = await this.copyEach(
      owed,
      deadline,
    );
    return { providerDeleted, ranOutOfTime };
  }

  private async copyEach(
    recordings: readonly SweepRow[],
    deadline: Date,
  ): Promise<{
    copied: number;
    providerDeleted: number;
    ranOutOfTime: boolean;
  }> {
    let copied = 0;
    let providerDeleted = 0;

    for (const recording of recordings) {
      if (!hasTimeLeft(deadline, new Date())) {
        return { copied, providerDeleted, ranOutOfTime: true };
      }

      const result = await this.recordings.copy(
        recording,
        recording.call.conversationUuid,
      );

      if (result.copied) copied += 1;
      if (result.providerDeleted) providerDeleted += 1;
    }

    return { copied, providerDeleted, ranOutOfTime: false };
  }

  /**
   * What the run did, once: an audit entry for the deletions it is
   * accountable for, and a log line. Counts and policies only — a recording's
   * URL is the provider's and never goes anywhere.
   */
  private async report(
    retention: RecordingRetention,
    outcome: RetentionSweepOutcome,
  ): Promise<void> {
    const summary = {
      deleted: outcome.deleted,
      copied: outcome.copied,
      providerDeleted: outcome.providerDeleted,
      failed: outcome.failed,
    };

    if (outcome.ranOutOfTime) {
      // Stopped while the lock was still this run's own; the hourly schedule
      // picks the rest up. A run that keeps doing this needs a larger budget.
      this.log.warn(
        summary,
        'Recording retention sweep ran out of time; the rest waits for the next run',
      );
    }

    if (Object.values(summary).every((count) => count === 0)) {
      this.log.info(summary, 'Recording retention sweep had nothing to do');
      return;
    }

    this.log.info({ ...summary, retention }, 'Recording retention sweep ran');

    try {
      await this.auditLog.create({
        action: 'recording.retention_swept',
        entityType: 'SystemSettings',
        entityId: SYSTEM_SETTINGS_ID,
        changes: summary,
        metadata: { retention },
      });
    } catch (error) {
      // The recordings are already deleted; losing the entry must not make
      // the run look like it failed, and the log line above still has it.
      this.log.error(
        { err: error, ...summary },
        'Could not record the retention sweep in the audit log',
      );
    }
  }

  private async takeLock(holder: string): Promise<boolean> {
    try {
      const taken = await this.redis.set(
        RETENTION_SWEEP_LOCK.KEY,
        holder,
        'EX',
        RETENTION_SWEEP_LOCK.TTL_SECONDS,
        'NX',
      );

      if (taken !== 'OK') {
        this.log.info(
          'Another instance is sweeping recordings; skipping this run',
        );
        return false;
      }

      return true;
    } catch (error) {
      this.log.warn(
        { err: error },
        'Could not take the retention sweep lock; skipping this run',
      );
      return false;
    }
  }

  private async releaseLock(holder: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK, 1, RETENTION_SWEEP_LOCK.KEY, holder);
    } catch (error) {
      // The lock expires by itself; the next run is at worst one hour later.
      this.log.warn(
        { err: error },
        'Could not release the retention sweep lock',
      );
    }
  }
}

/** Once an hour is often enough for a policy measured in days. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Shortly after boot, not at boot: a deployment that restarts in a loop should
 * not sweep on every start, and the first minute belongs to serving requests.
 */
const FIRST_SWEEP_DELAY_MS = 60 * 1000;

export interface RetentionSweepSchedule {
  stop(): void;
}

/**
 * Runs the sweep on a timer for as long as the process lives. The timers do
 * not hold the event loop open, and a run that is still going when the next
 * one is due is left to finish alone.
 */
export function startRetentionSweep(
  sweep: Pick<RecordingRetentionSweep, 'run'>,
  log: Pick<FastifyBaseLogger, 'error'>,
  options: { intervalMs?: number; firstRunDelayMs?: number } = {},
): RetentionSweepSchedule {
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;

    try {
      await sweep.run();
    } catch (error) {
      log.error({ err: error }, 'Recording retention sweep failed');
    } finally {
      running = false;
    }
  };

  const first = setTimeout(
    () => void runOnce(),
    options.firstRunDelayMs ?? FIRST_SWEEP_DELAY_MS,
  );
  const repeat = setInterval(
    () => void runOnce(),
    options.intervalMs ?? SWEEP_INTERVAL_MS,
  );

  first.unref();
  repeat.unref();

  return {
    stop() {
      clearTimeout(first);
      clearInterval(repeat);
    },
  };
}
