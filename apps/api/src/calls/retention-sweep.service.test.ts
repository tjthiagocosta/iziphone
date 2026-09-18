import type { RecordingRetention } from '@repo/dto';
import { RETENTION_SWEEP_LOCK } from '@repo/events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RecordingDeletion } from './recording.service.js';
import {
  RecordingRetentionSweep,
  startRetentionSweep,
} from './retention-sweep.service.js';

/*
 * The sweep is driven through fakes: a Prisma double that answers each query
 * with the rows the test put there, an in-memory recording service, and a Redis
 * double whose lock can be held by somebody else. Nothing here talks to Twilio,
 * Redis or a bucket.
 */

const now = new Date('2026-09-18T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

interface Row {
  id: string;
  context: 'VOICEMAIL' | 'CONFERENCE';
  recordingSid: string;
  providerUrl: string;
  objectKey: string | null;
  providerDeletedAt: Date | null;
  deletedAt: Date | null;
  deletionReason: 'RETENTION_POLICY' | 'MANUAL' | null;
  copyStartedAt: Date | null;
  createdAt: Date;
  call: { conversationUuid: string };
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    context: 'VOICEMAIL',
    recordingSid: `RE${id}`,
    providerUrl: `https://api.twilio.com/2010-04-01/Accounts/ACaaaa/Recordings/RE${id}`,
    objectKey: `recordings/conv-${id}/RE${id}.mp3`,
    providerDeletedAt: daysAgo(100),
    deletedAt: null,
    deletionReason: null,
    copyStartedAt: null,
    createdAt: daysAgo(100),
    call: { conversationUuid: `conv-${id}` },
    ...overrides,
  };
}

/** Answers `findMany` from `rows`, applying the filters the sweep uses. */
function createDb(rows: Row[]) {
  const findMany = vi.fn(async (args: Record<string, never>) => {
    const where = (args as { where: Record<string, unknown> }).where;
    const take = (args as unknown as { take: number }).take;

    return rows.filter((candidate) => matches(candidate, where)).slice(0, take);
  });

  return { callRecording: { findMany } };
}

function matches(candidate: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') {
      const clauses = condition as Array<Record<string, unknown>>;
      return clauses.some((clause) => matches(candidate, clause));
    }

    const value = candidate[field as keyof Row];

    if (condition === null) return value === null;
    if (typeof condition === 'string') return value === condition;

    const comparison = condition as { lt?: Date; not?: null };
    if (comparison.lt !== undefined) {
      return value instanceof Date && value.getTime() < comparison.lt.getTime();
    }
    if ('not' in comparison && comparison.not === null) return value !== null;

    throw new Error(`Unsupported condition on ${field}`);
  });
}

const keepEverything: RecordingRetention = {
  voicemail: 'KEEP_UNTIL_DELETED',
  callRecordings: 'KEEP_UNTIL_DELETED',
};

function createSweep(
  rows: Row[],
  options: {
    retention?: RecordingRetention;
    lockHeldElsewhere?: boolean;
  } = {},
) {
  const db = createDb(rows);
  const set = vi.fn(async () => (options.lockHeldElsewhere ? null : 'OK'));
  const evalScript = vi.fn(async () => 1);
  const readRecordingRetention = vi.fn(
    async () => options.retention ?? keepEverything,
  );
  const deleteAudio = vi.fn(
    async (): Promise<RecordingDeletion> => ({
      outcome: 'deleted',
      providerDeleted: false,
    }),
  );
  const copy = vi.fn(async () => ({ copied: true, providerDeleted: true }));
  const create = vi.fn(async () => ({ id: 'audit-1' }));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const sweep = new RecordingRetentionSweep({
    db: db as never,
    redis: { set, eval: evalScript } as never,
    settings: { readRecordingRetention },
    recordings: { copy, deleteAudio } as never,
    auditLog: { create } as never,
    log,
  });

  return { sweep, db, set, evalScript, deleteAudio, copy, create, log };
}

/** What the recording service was asked to delete, by row id. */
function deletedIds(deleteAudio: ReturnType<typeof vi.fn>): string[] {
  return deleteAudio.mock.calls.map(([recording]) => recording.id);
}

function copiedIds(copy: ReturnType<typeof vi.fn>): string[] {
  return copy.mock.calls.map(([recording]) => recording.id);
}

describe('RecordingRetentionSweep.run', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });

  test('deletes what the policy has outlived and leaves the rest', async () => {
    const { sweep, deleteAudio } = createSweep(
      [
        row('old', { createdAt: daysAgo(100) }),
        row('young', { createdAt: daysAgo(10) }),
        row('old-call', { context: 'CONFERENCE', createdAt: daysAgo(100) }),
      ],
      { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    );

    const outcome = await sweep.run();

    expect(deletedIds(deleteAudio)).toEqual(['old']);
    expect(deleteAudio).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'old' }),
      'conv-old',
      'RETENTION_POLICY',
    );
    expect(outcome).toMatchObject({ ran: true, deleted: 1, failed: 0 });
  });

  test('deletes nothing at all while both policies keep until deleted', async () => {
    const { sweep, deleteAudio, db } = createSweep([
      row('ancient', { createdAt: daysAgo(4000) }),
    ]);

    const outcome = await sweep.run();

    expect(deleteAudio).not.toHaveBeenCalled();
    expect(outcome.deleted).toBe(0);
    // Only the two owed-work queries; no expiry scan was even issued.
    expect(db.callRecording.findMany).toHaveBeenCalledTimes(2);
  });

  test('counts a deletion that failed again as owed, not as done', async () => {
    const { sweep, deleteAudio } = createSweep(
      [row('stuck', { createdAt: daysAgo(100) })],
      { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    );
    deleteAudio.mockResolvedValue({ outcome: 'failed' });

    const outcome = await sweep.run();

    expect(outcome).toMatchObject({ deleted: 0, failed: 1 });
  });

  test('counts the Twilio deletion of an expired recording it never copied', async () => {
    const { sweep, copy, deleteAudio } = createSweep(
      [
        row('never-copied', {
          objectKey: null,
          providerDeletedAt: null,
          createdAt: daysAgo(100),
        }),
      ],
      { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    );
    deleteAudio.mockResolvedValue({
      outcome: 'deleted',
      providerDeleted: true,
    });
    // The row the fake database answers with is the one read before the
    // deletion; the later passes find nothing left to do with it.
    copy.mockResolvedValue({ copied: false, providerDeleted: false });

    const outcome = await sweep.run();

    // The deletion pass removed it at Twilio; the report has to say so.
    expect(outcome).toMatchObject({ deleted: 1, providerDeleted: 1 });
  });

  test('retries a copy an earlier attempt owed', async () => {
    const { sweep, copy } = createSweep([
      row('owed', { objectKey: null, providerDeletedAt: null }),
    ]);

    const outcome = await sweep.run();

    expect(copiedIds(copy)).toEqual(['owed']);
    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'owed' }),
      'conv-owed',
    );
    expect(outcome).toMatchObject({ copied: 1, providerDeleted: 1 });
  });

  test('leaves a copy another process claimed moments ago to that process', async () => {
    const { sweep, copy } = createSweep([
      row('claimed', {
        objectKey: null,
        providerDeletedAt: null,
        copyStartedAt: new Date(now.getTime() - 1_000),
      }),
    ]);

    await sweep.run();

    expect(copy).not.toHaveBeenCalled();
  });

  test('takes over a copy whose claim went stale', async () => {
    const { sweep, copy } = createSweep([
      row('abandoned', {
        objectKey: null,
        providerDeletedAt: null,
        copyStartedAt: new Date(now.getTime() - 60 * 60 * 1000),
      }),
    ]);

    await sweep.run();

    expect(copiedIds(copy)).toEqual(['abandoned']);
  });

  test('retries a Twilio deletion owed for a recording already copied', async () => {
    const { sweep, copy } = createSweep([
      row('undeleted', { providerDeletedAt: null }),
    ]);
    copy.mockResolvedValue({ copied: false, providerDeleted: true });

    const outcome = await sweep.run();

    expect(copiedIds(copy)).toEqual(['undeleted']);
    expect(outcome).toMatchObject({ copied: 0, providerDeleted: 1 });
  });

  test('retries a Twilio deletion owed for a recording deleted before it was copied', async () => {
    const { sweep, copy } = createSweep([
      row('swept', {
        objectKey: null,
        providerDeletedAt: null,
        deletedAt: daysAgo(1),
        deletionReason: 'RETENTION_POLICY',
      }),
    ]);
    copy.mockResolvedValue({ copied: false, providerDeleted: true });

    const outcome = await sweep.run();

    // Deleted here, so no copy is owed: it appears only in the deletion pass.
    expect(copiedIds(copy)).toEqual(['swept']);
    expect(outcome).toMatchObject({ copied: 0, providerDeleted: 1 });
  });

  test('stops while its lock is still its own and leaves the rest for the next run', async () => {
    const { sweep, db, deleteAudio, log } = createSweep(
      [
        row('a', { createdAt: daysAgo(100) }),
        row('b', { createdAt: daysAgo(101) }),
        row('c', { createdAt: daysAgo(102) }),
        row('d', { createdAt: daysAgo(103) }),
      ],
      { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    );
    // A provider answering slowly: six minutes of a ten-minute budget each.
    deleteAudio.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1000));
      return { outcome: 'deleted', providerDeleted: false };
    });

    const outcome = await sweep.run();

    expect(deleteAudio).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ deleted: 2, ranOutOfTime: true });
    // The owed work is not even asked for once the budget is gone.
    expect(db.callRecording.findMany).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 2 }),
      'Recording retention sweep ran out of time; the rest waits for the next run',
    );
  });

  test('deletes nothing the policy does not cover, whatever the query answered', async () => {
    const { sweep, db, deleteAudio } = createSweep([], {
      retention: { ...keepEverything, voicemail: 'DAYS_30' },
    });
    db.callRecording.findMany.mockResolvedValue([
      row('young', { createdAt: daysAgo(3) }),
    ]);

    const outcome = await sweep.run();

    expect(deleteAudio).not.toHaveBeenCalled();
    expect(outcome.deleted).toBe(0);
  });

  test('writes one audit entry for the whole run, not one per recording', async () => {
    const { sweep, create } = createSweep(
      [
        row('a', { createdAt: daysAgo(100) }),
        row('b', { createdAt: daysAgo(101) }),
        row('c', { createdAt: daysAgo(102) }),
      ],
      { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    );

    await sweep.run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      action: 'recording.retention_swept',
      entityType: 'SystemSettings',
      entityId: 'system',
      changes: { deleted: 3, copied: 0, providerDeleted: 0, failed: 0 },
      metadata: { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    });
  });

  test('writes no audit entry for a run that had nothing to do', async () => {
    const { sweep, create, log } = createSweep([]);

    await sweep.run();

    expect(create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { deleted: 0, copied: 0, providerDeleted: 0, failed: 0 },
      'Recording retention sweep had nothing to do',
    );
  });

  test('reports the run even when the audit entry cannot be written', async () => {
    const { sweep, create, log } = createSweep(
      [row('old', { createdAt: daysAgo(100) })],
      { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    );
    create.mockRejectedValue(new Error('db down'));

    const outcome = await sweep.run();

    expect(outcome).toMatchObject({ ran: true, deleted: 1 });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 1 }),
      'Could not record the retention sweep in the audit log',
    );
  });

  test('reads and deletes nothing while another instance holds the lock', async () => {
    const { sweep, db, deleteAudio, copy, create, log } = createSweep(
      [row('old', { createdAt: daysAgo(100) })],
      {
        retention: { ...keepEverything, voicemail: 'DAYS_30' },
        lockHeldElsewhere: true,
      },
    );

    const outcome = await sweep.run();

    expect(outcome).toEqual({
      ran: false,
      deleted: 0,
      copied: 0,
      providerDeleted: 0,
      failed: 0,
      ranOutOfTime: false,
    });
    expect(db.callRecording.findMany).not.toHaveBeenCalled();
    expect(deleteAudio).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'Another instance is sweeping recordings; skipping this run',
    );
  });

  test('takes the lock for one holder and hands it back at the end', async () => {
    const { sweep, set, evalScript } = createSweep([]);

    await sweep.run();

    expect(set).toHaveBeenCalledWith(
      RETENTION_SWEEP_LOCK.KEY,
      expect.any(String),
      'EX',
      RETENTION_SWEEP_LOCK.TTL_SECONDS,
      'NX',
    );
    const holder = set.mock.calls[0]?.[1];
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining('del'),
      1,
      RETENTION_SWEEP_LOCK.KEY,
      holder,
    );
  });

  test('hands the lock back when the run fails', async () => {
    const { sweep, evalScript, deleteAudio } = createSweep(
      [row('old', { createdAt: daysAgo(100) })],
      { retention: { ...keepEverything, voicemail: 'DAYS_30' } },
    );
    deleteAudio.mockRejectedValue(new Error('store down'));

    await expect(sweep.run()).rejects.toThrow('store down');
    expect(evalScript).toHaveBeenCalledTimes(1);
  });

  test('skips the run when Redis cannot be asked for the lock', async () => {
    const { sweep, set, db, log } = createSweep([]);
    set.mockRejectedValue(new Error('redis down'));

    const outcome = await sweep.run();

    expect(outcome.ran).toBe(false);
    expect(db.callRecording.findMany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Could not take the retention sweep lock; skipping this run',
    );
  });
});

describe('startRetentionSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test('sweeps shortly after boot and then on the interval', async () => {
    const run = vi.fn(async () => ({}) as never);
    const schedule = startRetentionSweep(
      { run },
      { error: vi.fn() },
      { firstRunDelayMs: 1_000, intervalMs: 10_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(3);

    schedule.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  test('does not start a second run while one is still going', async () => {
    let finish: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<never>((resolve) => {
          finish = resolve as () => void;
        }),
    );
    const schedule = startRetentionSweep(
      { run },
      { error: vi.fn() },
      { firstRunDelayMs: 1_000, intervalMs: 1_000 },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);

    finish?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);

    schedule.stop();
  });

  test('logs a failed sweep and keeps the schedule', async () => {
    const error = vi.fn();
    const run = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(new Error('sweep failed'))
      .mockResolvedValue({} as never);
    const schedule = startRetentionSweep(
      { run },
      { error },
      { firstRunDelayMs: 1_000, intervalMs: 1_000 },
    );

    await vi.advanceTimersByTimeAsync(2_500);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Recording retention sweep failed',
    );
    expect(run.mock.calls.length).toBeGreaterThan(1);

    schedule.stop();
  });
});
