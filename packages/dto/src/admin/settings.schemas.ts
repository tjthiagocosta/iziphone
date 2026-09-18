import { z } from 'zod';
import { IsoDateTimeSchema } from '../common/primitives.js';

/*
 * The deployment's own settings. Only recording retention lives here so far.
 *
 * A policy is one of a named set, never a number of days a request could carry:
 * "keep every recording for 4000 days" is not a decision anybody should be able
 * to make by typing, and a named period is what the console shows, what the
 * audit entry records and what the sweep reads.
 */

export const RecordingRetentionPolicySchema = z.enum([
  'KEEP_UNTIL_DELETED',
  'DAYS_30',
  'DAYS_60',
  'DAYS_90',
  'DAYS_180',
  'YEARS_1',
  'YEARS_2',
  'YEARS_3',
  'YEARS_5',
  'YEARS_7',
]);
export type RecordingRetentionPolicy = z.infer<
  typeof RecordingRetentionPolicySchema
>;

/** How long each policy keeps a recording; `null` keeps it until deleted. */
const RETENTION_DAYS: Record<RecordingRetentionPolicy, number | null> = {
  KEEP_UNTIL_DELETED: null,
  DAYS_30: 30,
  DAYS_60: 60,
  DAYS_90: 90,
  DAYS_180: 180,
  YEARS_1: 365,
  YEARS_2: 2 * 365,
  YEARS_3: 3 * 365,
  YEARS_5: 5 * 365,
  YEARS_7: 7 * 365,
};

/**
 * The age at which a policy lets a recording go, in days, or `null` for a
 * policy that keeps it until somebody deletes it. Years count as 365 days: the
 * shortest period here is a month, and a leap day either way is not a
 * distinction a retention policy makes.
 */
export function retentionDays(policy: RecordingRetentionPolicy): number | null {
  return RETENTION_DAYS[policy];
}

/** Every policy in the order the console offers them, with its wording. */
export const RECORDING_RETENTION_OPTIONS = [
  { policy: 'KEEP_UNTIL_DELETED', label: 'Keep until deleted' },
  { policy: 'DAYS_30', label: '30 days' },
  { policy: 'DAYS_60', label: '60 days' },
  { policy: 'DAYS_90', label: '90 days' },
  { policy: 'DAYS_180', label: '180 days' },
  { policy: 'YEARS_1', label: '1 year' },
  { policy: 'YEARS_2', label: '2 years' },
  { policy: 'YEARS_3', label: '3 years' },
  { policy: 'YEARS_5', label: '5 years' },
  { policy: 'YEARS_7', label: '7 years' },
] as const satisfies ReadonlyArray<{
  policy: RecordingRetentionPolicy;
  label: string;
}>;

/** How each policy reads in a sentence about what the sweep will do. */
export function retentionPolicyLabel(policy: RecordingRetentionPolicy): string {
  return (
    RECORDING_RETENTION_OPTIONS.find((option) => option.policy === policy)
      ?.label ?? policy
  );
}

/**
 * Voicemails and call recordings are kept for their own periods: a voicemail is
 * a message somebody still has to act on, a call recording is evidence of a
 * call that already happened, and every comparable system settles them
 * separately.
 */
export const RecordingRetentionSchema = z.object({
  voicemail: RecordingRetentionPolicySchema,
  callRecordings: RecordingRetentionPolicySchema,
});
export type RecordingRetention = z.infer<typeof RecordingRetentionSchema>;

/** Both policies are sent together, so a partial update cannot half-apply. */
export const UpdateRecordingRetentionSchema = RecordingRetentionSchema;
export type UpdateRecordingRetention = z.infer<
  typeof UpdateRecordingRetentionSchema
>;

export const SystemSettingsResponseSchema = z.object({
  recordingRetention: RecordingRetentionSchema,
  /** When the settings were last written; null while they are still the defaults. */
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type SystemSettingsResponse = z.infer<
  typeof SystemSettingsResponseSchema
>;
