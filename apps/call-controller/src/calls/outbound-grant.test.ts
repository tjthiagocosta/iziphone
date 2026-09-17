import type { CachedRouting } from '@repo/events';
import { describe, expect, test } from 'vitest';
import { e164 } from '../test/e164.js';
import {
  admitOutboundCall,
  decideOutboundGrant,
  type OutboundCallGrant,
  outboundCallRefusalMessage,
  parseStoredGrant,
} from './outbound-grant.js';

const supportLine = e164('+15555550100');
const customer = e164('+15555550199');
const issuedAt = new Date('2026-09-17T12:00:00.000Z');

const support: CachedRouting = {
  type: 'DEPARTMENT',
  departmentId: 'dept-1',
  departmentName: 'Support',
  userIds: ['user-1', 'user-2'],
  voiceEnabled: true,
  cachedAt: '2026-09-08T12:00:00.000Z',
};

const grant: OutboundCallGrant = {
  userId: 'user-1',
  to: customer,
  fromNumber: supportLine,
  departmentId: 'dept-1',
  departmentName: 'Support',
  createdAt: issuedAt.toISOString(),
};

describe('decideOutboundGrant', () => {
  test('grants a member a call from the department line, remembering the department', () => {
    expect(
      decideOutboundGrant(
        { userId: 'user-1', to: customer, fromNumber: supportLine },
        support,
        issuedAt,
      ),
    ).toEqual({ action: 'issue', grant });
  });

  test('refuses with the reason the line gives, and issues nothing', () => {
    expect(
      decideOutboundGrant(
        { userId: 'user-9', to: customer, fromNumber: supportLine },
        support,
        issuedAt,
      ),
    ).toEqual({ action: 'refuse', reason: 'line-not-allowed' });
    expect(
      decideOutboundGrant(
        { userId: 'user-1', to: customer, fromNumber: supportLine },
        null,
        issuedAt,
      ),
    ).toEqual({ action: 'refuse', reason: 'line-unavailable' });
  });
});

describe('admitOutboundCall', () => {
  const secondsLater = (seconds: number) =>
    new Date(issuedAt.getTime() + seconds * 1000);

  test('lets the call go ahead on a grant of its caller, while it is fresh', () => {
    expect(admitOutboundCall(grant, 'client:user-1', secondsLater(59))).toEqual(
      { action: 'dial', grant },
    );
  });

  test('refuses a call that brought no grant, or one the store no longer had', () => {
    expect(admitOutboundCall(null, 'client:user-1', issuedAt)).toEqual({
      action: 'refuse',
      reason: 'no-grant',
    });
  });

  test('refuses a grant past its age, even if the store still had it', () => {
    expect(admitOutboundCall(grant, 'client:user-1', secondsLater(60))).toEqual(
      { action: 'refuse', reason: 'grant-expired' },
    );
  });

  test('refuses a call whose caller is not the one the grant was issued to', () => {
    expect(admitOutboundCall(grant, 'client:user-2', issuedAt)).toEqual({
      action: 'refuse',
      reason: 'wrong-caller',
    });
    expect(admitOutboundCall(grant, '+15555550100', issuedAt)).toEqual({
      action: 'refuse',
      reason: 'wrong-caller',
    });
    expect(admitOutboundCall(grant, undefined, issuedAt)).toEqual({
      action: 'refuse',
      reason: 'wrong-caller',
    });
  });

  test.each(['no-grant', 'grant-expired', 'wrong-caller'] as const)(
    'tells the agent the call was not placed (%s)',
    (reason) => {
      expect(outboundCallRefusalMessage(reason)).toMatch(
        /^Your call was not placed\. /,
      );
    },
  );
});

describe('parseStoredGrant', () => {
  test('reads back what was kept, and nothing that is not a grant', () => {
    expect(parseStoredGrant(JSON.parse(JSON.stringify(grant)))).toEqual(grant);
    expect(parseStoredGrant({ ...grant, fromNumber: 'user-1' })).toBeNull();
    expect(parseStoredGrant({ ...grant, userId: '' })).toBeNull();
    expect(parseStoredGrant('not a grant')).toBeNull();
  });
});
