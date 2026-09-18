import type { CallRecordingContext, Prisma } from '@repo/db';
import {
  type RecordingRetention,
  type RecordingRetentionPolicy,
  retentionDays,
} from '@repo/dto';
import { RETENTION_SWEEP_LOCK } from '@repo/events';

/*
 * The retention rules that need no I/O: when a recording has outlived the
 * policy that covers it, what a sweep run owes, and when a claim on a copy has
 * gone stale. The sweep does the reading, deleting and logging; everything it
 * decides is here.
 *
 * A recording's age is counted from its row's `createdAt`, which is when the
 * call controller announced it: the moment the call produced it, not when the
 * copy happened to succeed. A copy retried a week later does not buy the
 * recording another week.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a claim on a copy is honoured. Long enough for the slowest copy
 * (Twilio is given 30 seconds per piece of a recording that can be hours
 * long), short enough that a process killed mid-copy does not strand the
 * recording until its retention runs out.
 */
export const COPY_CLAIM_STALE_MS = 10 * 60 * 1000;

/** Which policy covers a recording of each context. */
export function policyFor(
  retention: RecordingRetention,
  context: CallRecordingContext,
): RecordingRetentionPolicy {
  return context === 'VOICEMAIL'
    ? retention.voicemail
    : retention.callRecordings;
}

/**
 * The moment a recording must predate to have outlived `policy`, or `null`
 * when the policy keeps recordings until somebody deletes them. A cutoff
 * rather than a per-row answer, so the sweep asks the database for the expired
 * rows instead of reading every row to decide.
 */
export function retentionCutoff(
  policy: RecordingRetentionPolicy,
  now: Date,
): Date | null {
  const days = retentionDays(policy);

  return days === null ? null : new Date(now.getTime() - days * DAY_MS);
}

/** Whether a recording created at `createdAt` has outlived `policy`. */
export function isExpired(
  policy: RecordingRetentionPolicy,
  createdAt: Date,
  now: Date,
): boolean {
  const cutoff = retentionCutoff(policy, now);

  return cutoff !== null && createdAt.getTime() < cutoff.getTime();
}

/** A context the sweep has expiry work for, and the age it deletes past. */
export interface ExpiryScan {
  context: CallRecordingContext;
  cutoff: Date;
}

/**
 * What this run owes in expiries: one scan per context whose policy names a
 * period. A context kept until deleted is left out entirely, so the default
 * settings give the sweep no expiry work at all.
 */
export function expiryScans(
  retention: RecordingRetention,
  now: Date,
): ExpiryScan[] {
  const contexts: CallRecordingContext[] = ['VOICEMAIL', 'CONFERENCE'];

  return contexts.flatMap((context) => {
    const cutoff = retentionCutoff(policyFor(retention, context), now);

    return cutoff === null ? [] : [{ context, cutoff }];
  });
}

/**
 * The moment a claim must predate to be taken over. A claim is how the event
 * subscriber, a fallback play and the sweep avoid copying one recording twice;
 * an attempt that died without clearing its claim must not hold the recording
 * for ever.
 */
export function staleClaimCutoff(now: Date): Date {
  return new Date(now.getTime() - COPY_CLAIM_STALE_MS);
}

/**
 * A recording whose copy may be claimed: no copy exists, nobody deleted it,
 * and either nobody holds the claim or its holder is gone. Both the claim
 * itself and the sweep's search for owed copies are built from this, so the
 * two cannot drift apart.
 */
export function claimableCopyWhere(now: Date): Prisma.CallRecordingWhereInput {
  return {
    objectKey: null,
    deletedAt: null,
    OR: [
      { copyStartedAt: null },
      { copyStartedAt: { lt: staleClaimCutoff(now) } },
    ],
  };
}

/**
 * How long a run may keep starting work. Two thirds of the lock's life, so a
 * run that finds a large backlog, or a provider that answers slowly, stops
 * while the lock it holds is still its own; what is left waits for the next
 * run rather than being swept by a second instance at the same time.
 */
export const SWEEP_BUDGET_MS = Math.floor(
  (RETENTION_SWEEP_LOCK.TTL_SECONDS * 1000 * 2) / 3,
);

/** The moment a run started at `startedAt` stops taking on new work. */
export function sweepDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + SWEEP_BUDGET_MS);
}

/** Whether there is still time to start another recording's work. */
export function hasTimeLeft(deadline: Date, now: Date): boolean {
  return now.getTime() < deadline.getTime();
}
