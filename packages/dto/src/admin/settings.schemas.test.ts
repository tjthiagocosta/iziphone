import { describe, expect, test } from 'vitest';
import {
  RECORDING_RETENTION_OPTIONS,
  RecordingRetentionPolicySchema,
  retentionDays,
  retentionPolicyLabel,
  SystemSettingsResponseSchema,
  UpdateRecordingRetentionSchema,
} from './settings.schemas.js';

describe('RecordingRetentionPolicySchema', () => {
  test('accepts every policy the console offers', () => {
    for (const option of RECORDING_RETENTION_OPTIONS) {
      expect(RecordingRetentionPolicySchema.parse(option.policy)).toBe(
        option.policy,
      );
    }
  });

  test.each(['DAYS_45', '30', 30, 'days_30', '', null])(
    'refuses %p, so a period nobody chose cannot be set',
    (value) => {
      expect(RecordingRetentionPolicySchema.safeParse(value).success).toBe(
        false,
      );
    },
  );
});

describe('retentionDays', () => {
  test('keeps a recording until deleted when no period is set', () => {
    expect(retentionDays('KEEP_UNTIL_DELETED')).toBeNull();
  });

  test('counts a year as 365 days', () => {
    expect(retentionDays('YEARS_1')).toBe(365);
    expect(retentionDays('YEARS_7')).toBe(7 * 365);
  });

  test('gives every policy but the open-ended one a number of days', () => {
    for (const { policy } of RECORDING_RETENTION_OPTIONS) {
      const days = retentionDays(policy);

      if (policy === 'KEEP_UNTIL_DELETED') continue;
      expect(days).toBeGreaterThan(0);
    }
  });

  test('offers the periods from shortest to longest', () => {
    const days = RECORDING_RETENTION_OPTIONS.slice(1).map(({ policy }) =>
      retentionDays(policy),
    );

    expect(days).toEqual([...days].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe('retentionPolicyLabel', () => {
  test('reads each policy as the console words it', () => {
    expect(retentionPolicyLabel('KEEP_UNTIL_DELETED')).toBe(
      'Keep until deleted',
    );
    expect(retentionPolicyLabel('DAYS_90')).toBe('90 days');
    expect(retentionPolicyLabel('YEARS_2')).toBe('2 years');
  });
});

describe('UpdateRecordingRetentionSchema', () => {
  test('takes both policies together', () => {
    expect(
      UpdateRecordingRetentionSchema.parse({
        voicemail: 'DAYS_30',
        callRecordings: 'YEARS_1',
      }),
    ).toEqual({ voicemail: 'DAYS_30', callRecordings: 'YEARS_1' });
  });

  test('refuses an update that names only one of them', () => {
    expect(
      UpdateRecordingRetentionSchema.safeParse({ voicemail: 'DAYS_30' })
        .success,
    ).toBe(false);
  });
});

describe('SystemSettingsResponseSchema', () => {
  test('reads settings nobody has changed yet', () => {
    expect(
      SystemSettingsResponseSchema.parse({
        recordingRetention: {
          voicemail: 'KEEP_UNTIL_DELETED',
          callRecordings: 'KEEP_UNTIL_DELETED',
        },
        updatedAt: null,
      }).updatedAt,
    ).toBeNull();
  });

  test('refuses a time that is not a timestamp', () => {
    expect(
      SystemSettingsResponseSchema.safeParse({
        recordingRetention: {
          voicemail: 'DAYS_30',
          callRecordings: 'DAYS_30',
        },
        updatedAt: 'yesterday',
      }).success,
    ).toBe(false);
  });
});
