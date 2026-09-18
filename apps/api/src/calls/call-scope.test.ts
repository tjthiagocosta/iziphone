import { describe, expect, test, vi } from 'vitest';
import {
  buildCallListWhere,
  buildCallScope,
  canListenToRecording,
  loadCallScope,
} from './call-scope.js';

describe('buildCallScope', () => {
  test.each(['ADMIN', 'SUPERVISOR'] as const)(
    'lets a %s see every call',
    (role) => {
      expect(buildCallScope({ id: 'user-1', role }, ['dept-1'])).toEqual({});
    },
  );

  test('limits an agent to their own calls and their departments', () => {
    expect(
      buildCallScope({ id: 'user-1', role: 'AGENT' }, ['dept-1', 'dept-2']),
    ).toEqual({
      OR: [
        { userId: 'user-1' },
        { departmentId: { in: ['dept-1', 'dept-2'] } },
      ],
    });
  });
});

describe('loadCallScope', () => {
  test('reads department memberships only for agents', async () => {
    const findMany = vi.fn(async () => [{ departmentId: 'dept-9' }]);
    const db = { userDepartment: { findMany } };

    await expect(
      loadCallScope(db, { id: 'user-2', role: 'SUPERVISOR' }),
    ).resolves.toEqual({});
    expect(findMany).not.toHaveBeenCalled();

    await expect(
      loadCallScope(db, { id: 'user-2', role: 'AGENT' }),
    ).resolves.toEqual({
      OR: [{ userId: 'user-2' }, { departmentId: { in: ['dept-9'] } }],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-2' },
      select: { departmentId: true },
    });
  });
});

describe('canListenToRecording', () => {
  test.each(['ADMIN', 'SUPERVISOR', 'AGENT'] as const)(
    'lets a %s hear the voicemail of a call they may see',
    (role) => {
      expect(canListenToRecording(role, 'VOICEMAIL')).toBe(true);
    },
  );

  test.each(['ADMIN', 'SUPERVISOR'] as const)(
    'lets a %s hear the recording of the call itself',
    (role) => {
      expect(canListenToRecording(role, 'CONFERENCE')).toBe(true);
    },
  );

  test('keeps the recording of the call itself from an agent', () => {
    expect(canListenToRecording('AGENT', 'CONFERENCE')).toBe(false);
  });
});

describe('buildCallListWhere', () => {
  const agentScope = {
    OR: [{ userId: 'user-1' }, { departmentId: { in: ['dept-1'] } }],
  };

  test('leaves the scope alone when the query asks for nothing', () => {
    expect(buildCallListWhere(agentScope, {})).toEqual(agentScope);
    expect(buildCallListWhere({}, {})).toEqual({});
  });

  test('keeps the scope a condition of its own so filters narrow it', () => {
    expect(buildCallListWhere(agentScope, { direction: 'outbound' })).toEqual({
      AND: [agentScope, { direction: 'outbound' }],
    });
  });

  test('matches each phone filter against both legs of the call', () => {
    expect(
      buildCallListWhere(
        {},
        { linePhone: '+15155550101', contactPhone: '+15155550104' },
      ),
    ).toEqual({
      AND: [
        {},
        { OR: [{ from: '+15155550101' }, { to: '+15155550101' }] },
        { OR: [{ from: '+15155550104' }, { to: '+15155550104' }] },
      ],
    });
  });

  test('finds an outbound call by the line it left from, which a user id in its place never did', () => {
    const line = '+15155550101';
    const customer = '+15155550104';
    const where = buildCallListWhere(
      {},
      { linePhone: line, contactPhone: customer },
    );

    // What the subscriber stores for an outbound call, now and before.
    const onItsLine = { direction: 'outbound', from: line, to: customer };
    const onTheAgent = { direction: 'outbound', from: 'user-1', to: customer };

    expect(matches(where, onItsLine)).toBe(true);
    expect(matches(where, onTheAgent)).toBe(false);
    // The same pair finds the inbound calls of the conversation too.
    expect(
      matches(where, { direction: 'inbound', from: customer, to: line }),
    ).toBe(true);
  });

  test('selects voicemails by their timeline entry, not by a recording', () => {
    const leftAVoicemail = {
      events: { some: { eventType: 'VOICEMAIL_COMPLETED' } },
    };

    expect(buildCallListWhere({}, { hasVoicemail: true })).toEqual({
      AND: [{}, leftAVoicemail],
    });
    expect(buildCallListWhere({}, { hasVoicemail: false })).toEqual({
      AND: [{}, { NOT: leftAVoicemail }],
    });
  });

  test('accepts several statuses at once', () => {
    expect(buildCallListWhere({}, { status: ['missed', 'busy'] })).toEqual({
      AND: [{}, { status: { in: ['missed', 'busy'] } }],
    });
  });
});

/**
 * Reads the part of a Prisma filter these tests build, `AND`, `OR` and column
 * equality, against one row, so a test can say which calls a filter finds.
 */
function matches(where: unknown, row: Record<string, string>): boolean {
  if (typeof where !== 'object' || where === null) {
    return false;
  }

  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND' && Array.isArray(condition)) {
      return condition.every((part) => matches(part, row));
    }
    if (key === 'OR' && Array.isArray(condition)) {
      return condition.some((part) => matches(part, row));
    }
    return row[key] === condition;
  });
}
