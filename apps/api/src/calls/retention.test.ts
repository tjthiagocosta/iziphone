import type { RecordingRetention } from '@repo/dto';
import { RETENTION_SWEEP_LOCK } from '@repo/events';
import { describe, expect, test } from 'vitest';
import {
  COPY_CLAIM_STALE_MS,
  claimableCopyWhere,
  expiryScans,
  hasTimeLeft,
  isExpired,
  policyFor,
  retentionCutoff,
  SWEEP_BUDGET_MS,
  staleClaimCutoff,
  sweepDeadline,
} from './retention.js';

const now = new Date('2026-09-18T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** `days` before `now`, to the millisecond. */
function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

const keepEverything: RecordingRetention = {
  voicemail: 'KEEP_UNTIL_DELETED',
  callRecordings: 'KEEP_UNTIL_DELETED',
};

describe('policyFor', () => {
  test('reads a voicemail under the voicemail policy and a call under the other', () => {
    const retention: RecordingRetention = {
      voicemail: 'DAYS_30',
      callRecordings: 'YEARS_1',
    };

    expect(policyFor(retention, 'VOICEMAIL')).toBe('DAYS_30');
    expect(policyFor(retention, 'CONFERENCE')).toBe('YEARS_1');
  });
});

describe('retentionCutoff', () => {
  test('has no cutoff while recordings are kept until deleted', () => {
    expect(retentionCutoff('KEEP_UNTIL_DELETED', now)).toBeNull();
  });

  test.each([
    { policy: 'DAYS_30', days: 30 },
    { policy: 'DAYS_60', days: 60 },
    { policy: 'DAYS_90', days: 90 },
    { policy: 'DAYS_180', days: 180 },
    { policy: 'YEARS_1', days: 365 },
    { policy: 'YEARS_2', days: 730 },
    { policy: 'YEARS_3', days: 1095 },
    { policy: 'YEARS_5', days: 1825 },
    { policy: 'YEARS_7', days: 2555 },
  ] as const)('puts the $policy cutoff $days days back', ({ policy, days }) => {
    expect(retentionCutoff(policy, now)).toEqual(daysAgo(days));
  });
});

describe('isExpired', () => {
  test('never expires a recording kept until deleted, however old', () => {
    expect(isExpired('KEEP_UNTIL_DELETED', daysAgo(10_000), now)).toBe(false);
  });

  test('expires a recording older than the policy', () => {
    expect(isExpired('DAYS_30', daysAgo(31), now)).toBe(true);
  });

  test('keeps a recording younger than the policy', () => {
    expect(isExpired('DAYS_30', daysAgo(29), now)).toBe(false);
  });

  test('keeps a recording exactly at the cutoff, so a day counts as whole', () => {
    expect(isExpired('DAYS_30', daysAgo(30), now)).toBe(false);
    expect(isExpired('DAYS_30', new Date(daysAgo(30).getTime() - 1), now)).toBe(
      true,
    );
  });
});

describe('expiryScans', () => {
  test('has no work while both policies keep recordings until deleted', () => {
    expect(expiryScans(keepEverything, now)).toEqual([]);
  });

  test('scans only the context whose policy names a period', () => {
    expect(
      expiryScans({ ...keepEverything, callRecordings: 'DAYS_90' }, now),
    ).toEqual([{ context: 'CONFERENCE', cutoff: daysAgo(90) }]);
  });

  test('scans both contexts, each at its own cutoff', () => {
    expect(
      expiryScans({ voicemail: 'DAYS_30', callRecordings: 'YEARS_1' }, now),
    ).toEqual([
      { context: 'VOICEMAIL', cutoff: daysAgo(30) },
      { context: 'CONFERENCE', cutoff: daysAgo(365) },
    ]);
  });
});

describe('claimableCopyWhere', () => {
  /** Reads the filter against one row, the way the database would. */
  function matches(row: {
    objectKey: string | null;
    deletedAt: Date | null;
    copyStartedAt: Date | null;
  }): boolean {
    const where = claimableCopyWhere(now);
    const claim = where.OR as Array<{ copyStartedAt: null | { lt: Date } }>;

    return (
      row.objectKey === where.objectKey &&
      row.deletedAt === where.deletedAt &&
      claim.some((clause) =>
        clause.copyStartedAt === null
          ? row.copyStartedAt === null
          : row.copyStartedAt !== null &&
            row.copyStartedAt.getTime() < clause.copyStartedAt.lt.getTime(),
      )
    );
  }

  const owed = { objectKey: null, deletedAt: null, copyStartedAt: null };

  test('claims a recording nobody is copying', () => {
    expect(matches(owed)).toBe(true);
  });

  test('leaves a copy that started moments ago to whoever started it', () => {
    expect(
      matches({ ...owed, copyStartedAt: new Date(now.getTime() - 1_000) }),
    ).toBe(false);
  });

  test('takes over a claim whose holder is gone', () => {
    expect(
      matches({
        ...owed,
        copyStartedAt: new Date(now.getTime() - COPY_CLAIM_STALE_MS - 1),
      }),
    ).toBe(true);
  });

  test('holds a claim for the full staleness window', () => {
    expect(matches({ ...owed, copyStartedAt: staleClaimCutoff(now) })).toBe(
      false,
    );
  });

  test('never copies a recording that is already copied or deleted', () => {
    expect(matches({ ...owed, objectKey: 'recordings/conv-1/RE.mp3' })).toBe(
      false,
    );
    expect(matches({ ...owed, deletedAt: now })).toBe(false);
  });
});

describe('the run budget', () => {
  test('stops taking on work while the lock is still the run own', () => {
    expect(SWEEP_BUDGET_MS).toBeLessThan(
      RETENTION_SWEEP_LOCK.TTL_SECONDS * 1000,
    );
  });

  test('leaves enough of the lock for the work already started to end', () => {
    const left = RETENTION_SWEEP_LOCK.TTL_SECONDS * 1000 - SWEEP_BUDGET_MS;

    // One provider round trip is 30 s of waiting at worst.
    expect(left).toBeGreaterThan(2 * 30_000);
  });

  test('has time while the deadline is ahead and none once it has passed', () => {
    const deadline = sweepDeadline(now);

    expect(hasTimeLeft(deadline, now)).toBe(true);
    expect(hasTimeLeft(deadline, new Date(deadline.getTime() - 1))).toBe(true);
    expect(hasTimeLeft(deadline, deadline)).toBe(false);
    expect(hasTimeLeft(deadline, new Date(deadline.getTime() + 1))).toBe(false);
  });
});
