import { describe, expect, test, vi } from 'vitest';
import {
  buildCallListWhere,
  buildCallScope,
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
