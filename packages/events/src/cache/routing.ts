import {
  ClosedHoursRoutingTypeSchema,
  IsoDateTimeSchema,
  OpenHoursRoutingTypeSchema,
  RoutingTargetTypeSchema,
  TimeOfDaySchema,
  TimeZoneSchema,
} from '@repo/dto';
import { z } from 'zod';

/*
 * Inbound call routing cache. The API writes it, the call controller reads it,
 * and the call controller never opens Postgres, so this is the only view of
 * departments and phone numbers it has.
 *
 *   routing:phone:{e164}   -> CachedRouting     how to route a called number
 *   department:id:{id}     -> CachedDepartment  who belongs to a department
 */

export const ROUTING_CACHE = {
  PHONE_KEY_PREFIX: 'routing:phone:',
  DEPARTMENT_ID_KEY_PREFIX: 'department:id:',
  DEFAULT_TTL_SECONDS: 24 * 60 * 60,
} as const;

/**
 * Turn the optional `DEPARTMENT_CACHE_TTL_SECONDS` setting into a TTL. Absent
 * or blank means the default; anything else must be a positive whole number
 * of seconds, and a typo fails loudly instead of caching forever or never.
 */
export function resolveRoutingCacheTtl(configured: string | undefined): number {
  const value = configured?.trim();
  if (!value) {
    return ROUTING_CACHE.DEFAULT_TTL_SECONDS;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `DEPARTMENT_CACHE_TTL_SECONDS must be a positive whole number of seconds, got "${configured}"`,
    );
  }
  return seconds;
}

export const OrderedUserSchema = z.object({
  userId: z.string(),
  order: z.number().int().nonnegative(),
});
export type OrderedUser = z.infer<typeof OrderedUserSchema>;

export const CachedBusinessHoursSchema = z.object({
  /** 0 is Sunday, 6 is Saturday. */
  dayOfWeek: z.number().int().min(0).max(6),
  isOpen: z.boolean(),
  openTime: TimeOfDaySchema.nullable(),
  closeTime: TimeOfDaySchema.nullable(),
});
export type CachedBusinessHours = z.infer<typeof CachedBusinessHoursSchema>;

export const CachedHolidaySchema = z.object({
  name: z.string(),
  date: IsoDateTimeSchema,
  isRecurring: z.boolean(),
  routingType: ClosedHoursRoutingTypeSchema,
  /** The external number when routingType is EXTERNAL_NUMBER. */
  routingValue: z.string().nullable(),
});
export type CachedHoliday = z.infer<typeof CachedHolidaySchema>;

export const CachedRoutingSettingsSchema = z.object({
  timezone: TimeZoneSchema,
  /** When true business hours and holidays are not consulted. */
  is24Hours: z.boolean(),
  openHoursRoutingType: OpenHoursRoutingTypeSchema,
  /** Seconds to ring each agent in FIXED_ORDER mode. */
  ringDuration: z.number().int().positive(),
  closedHoursRoutingType: ClosedHoursRoutingTypeSchema,
  closedHoursExternalNumber: z.string().nullable(),
  voicemailGreetingUrl: z.string().nullable(),
  businessHours: z.array(CachedBusinessHoursSchema),
  holidays: z.array(CachedHolidaySchema),
});
export type CachedRoutingSettings = z.infer<typeof CachedRoutingSettingsSchema>;

/**
 * How to route a called number. `DEPARTMENT` entries carry the department
 * fields and `USER` entries the user fields; `userIds` is filled either way so
 * the ring logic has one place to look.
 *
 * The same entry says who may place a call from the number: the people it
 * rings, as long as the number itself does voice.
 */
export const CachedRoutingSchema = z.object({
  type: RoutingTargetTypeSchema,
  userIds: z.array(z.string()),
  /**
   * The number places and receives voice calls. Entries written before the
   * flag existed do not say and are hits until their TTL ends, so only an
   * explicit `false` keeps an outbound call from leaving from the number.
   */
  voiceEnabled: z.boolean().optional(),
  orderedUsers: z.array(OrderedUserSchema).optional(),
  settings: CachedRoutingSettingsSchema.optional(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  cachedAt: IsoDateTimeSchema,
});
export type CachedRouting = z.infer<typeof CachedRoutingSchema>;

export const CachedDepartmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  userIds: z.array(z.string()),
  cachedAt: IsoDateTimeSchema,
});
export type CachedDepartment = z.infer<typeof CachedDepartmentSchema>;
