import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_RECORDING_RETENTION,
  SYSTEM_SETTINGS_ID,
  SystemSettingsService,
} from './system-settings.service.js';

/*
 * The retention sweep reads the policies through this service rather than the
 * row, so what it gets when nobody has set anything is part of the contract:
 * a fresh database has no row at all.
 */

function createService(row: unknown) {
  const findUnique = vi.fn(async () => row);
  const service = new SystemSettingsService(
    { systemSettings: { findUnique } } as never,
    { create: vi.fn() } as never,
  );

  return { service, findUnique };
}

describe('SystemSettingsService.readRecordingRetention', () => {
  test('keeps everything until somebody has chosen otherwise', async () => {
    const { service, findUnique } = createService(null);

    await expect(service.readRecordingRetention()).resolves.toEqual(
      DEFAULT_RECORDING_RETENTION,
    );
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: SYSTEM_SETTINGS_ID },
      select: {
        voicemailRetention: true,
        callRecordingRetention: true,
        updatedAt: true,
      },
    });
  });

  test('reads both policies from the row', async () => {
    const { service } = createService({
      voicemailRetention: 'DAYS_90',
      callRecordingRetention: 'YEARS_7',
      updatedAt: new Date('2026-09-18T09:30:00.000Z'),
    });

    await expect(service.readRecordingRetention()).resolves.toEqual({
      voicemail: 'DAYS_90',
      callRecordings: 'YEARS_7',
    });
  });
});

describe('SystemSettingsService default messaging service', () => {
  const CUSTOMER_CARE_SID = 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  function createWritableService(
    row: { defaultMessagingServiceSid: string | null } | null,
  ) {
    const findUnique = vi.fn(async () => row);
    const upsert = vi.fn(async () => ({ id: SYSTEM_SETTINGS_ID }));
    const tx = { systemSettings: { findUnique, upsert } };
    const auditCreate = vi.fn(async () => undefined);
    const service = new SystemSettingsService(
      {
        ...tx,
        $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
      } as never,
      { create: auditCreate } as never,
    );

    return { service, upsert, auditCreate, tx };
  }

  test('reads none before anybody has chosen one', async () => {
    const { service } = createService(null);

    await expect(service.readDefaultMessagingService()).resolves.toBeNull();
  });

  test('reads the service stored', async () => {
    const { service } = createService({
      defaultMessagingServiceSid: CUSTOMER_CARE_SID,
    });

    await expect(service.readDefaultMessagingService()).resolves.toBe(
      CUSTOMER_CARE_SID,
    );
  });

  test('stores the service with an audit entry naming the one before, in one transaction', async () => {
    const { service, upsert, auditCreate, tx } = createWritableService(null);

    await service.updateDefaultMessagingService(
      CUSTOMER_CARE_SID,
      'admin-1',
      '203.0.113.7',
    );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          id: SYSTEM_SETTINGS_ID,
          defaultMessagingServiceSid: CUSTOMER_CARE_SID,
        },
        update: { defaultMessagingServiceSid: CUSTOMER_CARE_SID },
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      {
        action: 'settings.default_messaging_service_updated',
        entityType: 'SystemSettings',
        entityId: SYSTEM_SETTINGS_ID,
        userId: 'admin-1',
        changes: { from: null, to: CUSTOMER_CARE_SID },
        ipAddress: '203.0.113.7',
      },
      tx,
    );
  });

  test('clears the default, recording the service it was', async () => {
    const { service, auditCreate } = createWritableService({
      defaultMessagingServiceSid: CUSTOMER_CARE_SID,
    });

    await service.updateDefaultMessagingService(null, 'admin-1');

    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: { from: CUSTOMER_CARE_SID, to: null },
      }),
      expect.anything(),
    );
  });
});
