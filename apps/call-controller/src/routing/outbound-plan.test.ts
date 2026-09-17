import type { CachedRouting } from '@repo/events';
import { describe, expect, test } from 'vitest';
import { e164 } from '../test/e164.js';
import { planOutboundCall } from './outbound-plan.js';

const supportLine = e164('+15555550100');
const directLine = e164('+15555550101');

const support: CachedRouting = {
  type: 'DEPARTMENT',
  departmentId: 'dept-1',
  departmentName: 'Support',
  userIds: ['user-1', 'user-2'],
  voiceEnabled: true,
  cachedAt: '2026-09-08T12:00:00.000Z',
};

const direct: CachedRouting = {
  type: 'USER',
  userId: 'user-1',
  userName: 'Alex Example',
  userIds: ['user-1'],
  voiceEnabled: true,
  cachedAt: '2026-09-08T12:00:00.000Z',
};

describe('planOutboundCall', () => {
  test('a member calls from a department line, and the call belongs to the department', () => {
    expect(
      planOutboundCall({ agentUserId: 'user-2', line: supportLine }, support),
    ).toEqual({
      action: 'dial',
      line: '+15555550100',
      departmentId: 'dept-1',
      departmentName: 'Support',
    });
  });

  test('the owner calls from a direct line, which belongs to no department', () => {
    expect(
      planOutboundCall({ agentUserId: 'user-1', line: directLine }, direct),
    ).toEqual({ action: 'dial', line: '+15555550101' });
  });

  test('a number with no routing entry is refused: it is not ours, not assigned, or could not be looked up', () => {
    expect(
      planOutboundCall({ agentUserId: 'user-1', line: supportLine }, null),
    ).toEqual({ action: 'refuse', reason: 'line-unavailable' });
  });

  test('someone outside the department may not call from its line', () => {
    expect(
      planOutboundCall({ agentUserId: 'user-9', line: supportLine }, support),
    ).toEqual({ action: 'refuse', reason: 'line-not-allowed' });
  });

  test("nobody but the owner may call from a colleague's direct line", () => {
    expect(
      planOutboundCall({ agentUserId: 'user-2', line: directLine }, direct),
    ).toEqual({ action: 'refuse', reason: 'line-not-allowed' });
  });

  test('a line that does not do voice is refused, even to its owner', () => {
    expect(
      planOutboundCall(
        { agentUserId: 'user-1', line: directLine },
        { ...direct, voiceEnabled: false },
      ),
    ).toEqual({ action: 'refuse', reason: 'line-without-voice' });
  });

  test('an entry written before the voice flag existed still lets its owner call, and nobody else', () => {
    // Such an entry is a cache hit until its TTL ends. Refusing on it would
    // stop every outbound call whenever the API failed to rewrite the cache.
    const { voiceEnabled: _unset, ...stale } = direct;

    expect(
      planOutboundCall({ agentUserId: 'user-1', line: directLine }, stale),
    ).toEqual({ action: 'dial', line: directLine });
    expect(
      planOutboundCall({ agentUserId: 'user-9', line: directLine }, stale),
    ).toEqual({ action: 'refuse', reason: 'line-not-allowed' });
  });

  test('an outsider learns nothing about whether a line does voice', () => {
    expect(
      planOutboundCall(
        { agentUserId: 'user-9', line: directLine },
        { ...direct, voiceEnabled: false },
      ),
    ).toEqual({ action: 'refuse', reason: 'line-not-allowed' });
  });
});
