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
