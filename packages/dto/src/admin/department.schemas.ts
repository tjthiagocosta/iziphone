import { z } from 'zod';
import {
  ClosedHoursRoutingTypeSchema,
  OpenHoursRoutingTypeSchema,
  PhoneNumberTypeSchema,
} from '../common/domain.js';
import {
  PaginationMetaSchema,
  PaginationQuerySchema,
} from '../common/pagination.js';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PhoneNumberInputSchema,
  QueryBooleanSchema,
  TimeOfDaySchema,
  TimeZoneSchema,
} from '../common/primitives.js';

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

export const BusinessHoursItemSchema = z
  .object({
    /** 0 = Sunday … 6 = Saturday */
    dayOfWeek: z.number().int().min(0).max(6),
    isOpen: z.boolean(),
    openTime: TimeOfDaySchema.nullable(),
    closeTime: TimeOfDaySchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (!value.isOpen) return;
    if (value.openTime === null || value.closeTime === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Open days need both openTime and closeTime',
        path: [value.openTime === null ? 'openTime' : 'closeTime'],
      });
      return;
    }
    if (value.openTime >= value.closeTime) {
      ctx.addIssue({
        code: 'custom',
        message: 'closeTime must be after openTime',
        path: ['closeTime'],
      });
    }
  });

/** One entry per weekday, each day exactly once. */
export const UpdateBusinessHoursSchema = z
  .array(BusinessHoursItemSchema)
  .length(7, 'Provide exactly one entry per day of the week')
  .refine(
    (days) => new Set(days.map((day) => day.dayOfWeek)).size === 7,
    'Each day of the week must appear exactly once',
  );

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

function requireExternalNumber(
  value: {
    routingType?: string | undefined;
    routingValue?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.routingType === 'EXTERNAL_NUMBER' && !value.routingValue) {
    ctx.addIssue({
      code: 'custom',
      message: 'routingValue is required when routing to an external number',
      path: ['routingValue'],
    });
  }
}

export const CreateHolidaySchema = z
  .object({
    name: z.string().trim().min(1, 'Holiday name is required').max(100),
    /** ISO timestamp; the calendar day is evaluated in UTC. */
    date: IsoDateTimeSchema,
    isRecurring: z.boolean().default(false),
    routingType: ClosedHoursRoutingTypeSchema,
    /** Destination number when `routingType` is `EXTERNAL_NUMBER`. */
    routingValue: PhoneNumberInputSchema.optional(),
  })
  .superRefine(requireExternalNumber);

export const UpdateHolidaySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    date: IsoDateTimeSchema.optional(),
    isRecurring: z.boolean().optional(),
    routingType: ClosedHoursRoutingTypeSchema.optional(),
    routingValue: PhoneNumberInputSchema.optional(),
  })
  .superRefine(requireExternalNumber);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const RING_DURATION_MIN_SECONDS = 10;
export const RING_DURATION_MAX_SECONDS = 45;

export const UpdateDepartmentSettingsSchema = z.object({
  timezone: TimeZoneSchema.optional(),
  is24Hours: z.boolean().optional(),
  openHoursRoutingType: OpenHoursRoutingTypeSchema.optional(),
  closedHoursRoutingType: ClosedHoursRoutingTypeSchema.optional(),
  closedHoursExternalNumber: PhoneNumberInputSchema.nullable().optional(),
  /** Seconds to ring each member before moving on (FIXED_ORDER). */
  ringDuration: z
    .number()
    .int()
    .min(RING_DURATION_MIN_SECONDS)
    .max(RING_DURATION_MAX_SECONDS)
    .optional(),
  voicemailGreetingUrl: z
    .url({ protocol: /^https?$/ })
    .nullable()
    .optional(),
});

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export const CreateDepartmentSchema = z.object({
  name: z.string().trim().min(1, 'Department name is required').max(100),
  description: z.string().trim().max(500).optional(),
});

export const UpdateDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const DepartmentListQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().min(1).optional(),
  includeDeleted: QueryBooleanSchema.default(false),
  deletedOnly: QueryBooleanSchema.default(false),
});

// ---------------------------------------------------------------------------
// Membership and numbers
// ---------------------------------------------------------------------------

export const AddAgentSchema = z.object({
  userId: EntityIdSchema,
  order: z.number().int().min(0).default(0),
});

export const UpdateAgentOrderSchema = z.object({
  agentOrder: z
    .array(
      z.object({
        userId: EntityIdSchema,
        order: z.number().int().min(0),
      }),
    )
    .min(1)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.userId)).size === entries.length,
      'Each user may appear only once',
    ),
});

export const AssignPhoneNumberToDepartmentSchema = z.object({
  phoneNumberId: EntityIdSchema,
  isPrimary: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const DepartmentSettingsResponseSchema = z.object({
  id: z.string(),
  timezone: z.string(),
  is24Hours: z.boolean(),
  openHoursRoutingType: OpenHoursRoutingTypeSchema,
  closedHoursRoutingType: ClosedHoursRoutingTypeSchema,
  closedHoursExternalNumber: z.string().nullable(),
  ringDuration: z.number().int(),
  voicemailGreetingUrl: z.string().nullable(),
});

export const BusinessHoursResponseSchema = z.object({
  id: z.string(),
  dayOfWeek: z.number().int(),
  isOpen: z.boolean(),
  openTime: z.string().nullable(),
  closeTime: z.string().nullable(),
});

export const HolidayResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  date: IsoDateTimeSchema,
  isRecurring: z.boolean(),
  routingType: ClosedHoursRoutingTypeSchema,
  routingValue: z.string().nullable(),
});

export const DepartmentAgentResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string().nullable(),
  userEmail: z.string(),
  order: z.number().int(),
});

/** Capabilities and location of a number, shared by every response that embeds one. */
export const PhoneNumberSummarySchema = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  friendlyName: z.string().nullable(),
  type: PhoneNumberTypeSchema,
  label: z.string().nullable(),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  voiceEnabled: z.boolean(),
  smsEnabled: z.boolean(),
  mmsEnabled: z.boolean(),
  faxEnabled: z.boolean(),
  isPrimary: z.boolean(),
});

export const DepartmentPhoneNumberResponseSchema = PhoneNumberSummarySchema;

export const DepartmentResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  settings: DepartmentSettingsResponseSchema.nullable(),
  businessHours: z.array(BusinessHoursResponseSchema),
  holidays: z.array(HolidayResponseSchema),
  agents: z.array(DepartmentAgentResponseSchema),
  phoneNumbers: z.array(DepartmentPhoneNumberResponseSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
});

export const DepartmentListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  timezone: z.string().nullable(),
  primaryPhoneNumber: z.string().nullable(),
  agentCount: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
});

export const DepartmentListResponseSchema = PaginationMetaSchema.extend({
  departments: z.array(DepartmentListItemSchema),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BusinessHoursItem = z.infer<typeof BusinessHoursItemSchema>;
export type UpdateBusinessHours = z.infer<typeof UpdateBusinessHoursSchema>;
export type CreateHoliday = z.infer<typeof CreateHolidaySchema>;
export type UpdateHoliday = z.infer<typeof UpdateHolidaySchema>;
export type UpdateDepartmentSettings = z.infer<
  typeof UpdateDepartmentSettingsSchema
>;
export type CreateDepartment = z.infer<typeof CreateDepartmentSchema>;
export type UpdateDepartment = z.infer<typeof UpdateDepartmentSchema>;
export type DepartmentListQuery = z.infer<typeof DepartmentListQuerySchema>;
export type AddAgent = z.infer<typeof AddAgentSchema>;
export type UpdateAgentOrder = z.infer<typeof UpdateAgentOrderSchema>;
export type AssignPhoneNumberToDepartment = z.infer<
  typeof AssignPhoneNumberToDepartmentSchema
>;
export type DepartmentSettingsResponse = z.infer<
  typeof DepartmentSettingsResponseSchema
>;
export type BusinessHoursResponse = z.infer<typeof BusinessHoursResponseSchema>;
export type HolidayResponse = z.infer<typeof HolidayResponseSchema>;
export type DepartmentAgentResponse = z.infer<
  typeof DepartmentAgentResponseSchema
>;
export type PhoneNumberSummary = z.infer<typeof PhoneNumberSummarySchema>;
export type DepartmentPhoneNumberResponse = z.infer<
  typeof DepartmentPhoneNumberResponseSchema
>;
export type DepartmentResponse = z.infer<typeof DepartmentResponseSchema>;
export type DepartmentListItem = z.infer<typeof DepartmentListItemSchema>;
export type DepartmentListResponse = z.infer<
  typeof DepartmentListResponseSchema
>;
