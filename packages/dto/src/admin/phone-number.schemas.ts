import { z } from 'zod';
import {
  OwnerTypeSchema,
  PhoneNumberStatusSchema,
  PhoneNumberTypeSchema,
  TelephonyProviderSchema,
} from '../common/domain.js';
import {
  PaginationMetaSchema,
  PaginationQuerySchema,
} from '../common/pagination.js';
import {
  E164PhoneNumberSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  QueryBooleanSchema,
} from '../common/primitives.js';
import { PhoneNumberSummarySchema } from './department.schemas.js';

/** Numbers can only be bought in this country for now. */
export const SUPPORTED_NUMBER_COUNTRY = 'US';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const PurchasePhoneNumberSchema = z.object({
  phoneNumber: E164PhoneNumberSchema,
  country: z
    .literal(SUPPORTED_NUMBER_COUNTRY)
    .default(SUPPORTED_NUMBER_COUNTRY),
  type: PhoneNumberTypeSchema,
  label: z.string().trim().max(50).optional(),
  /** Optional immediate assignment to a user or a department. */
  userId: EntityIdSchema.optional(),
  departmentId: EntityIdSchema.optional(),
  isPrimary: z.boolean().default(false),
});

export const UpdatePhoneNumberSchema = z.object({
  label: z.string().trim().max(50).nullable().optional(),
  userId: EntityIdSchema.nullable().optional(),
  departmentId: EntityIdSchema.nullable().optional(),
  isPrimary: z.boolean().optional(),
});

export const PhoneNumberListQuerySchema = PaginationQuerySchema.extend({
  status: PhoneNumberStatusSchema.optional(),
  type: PhoneNumberTypeSchema.optional(),
  /** Only numbers without a user or department. */
  unassigned: QueryBooleanSchema.optional(),
  /** Matches the number or its label. */
  search: z.string().trim().min(1).optional(),
});

export const SearchAvailableNumbersSchema = z
  .object({
    country: z
      .literal(SUPPORTED_NUMBER_COUNTRY)
      .default(SUPPORTED_NUMBER_COUNTRY),
    type: PhoneNumberTypeSchema,
    areaCode: z
      .string()
      .regex(/^\d{3}$/, 'Area code must be 3 digits')
      .optional(),
    /** Digit pattern the number must contain, as understood by the provider. */
    contains: z.string().trim().min(1).max(10).optional(),
    limit: z.coerce.number().int().min(1).max(30).default(10),
  })
  .superRefine((value, ctx) => {
    if (value.type !== 'LOCAL' && value.areaCode) {
      ctx.addIssue({
        code: 'custom',
        message: 'Area code search is only supported for LOCAL numbers',
        path: ['areaCode'],
      });
    }
  });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const PhoneNumberAssignmentSchema = z.object({
  type: OwnerTypeSchema,
  id: z.string(),
  name: z.string(),
});

export const PhoneNumberResponseSchema = PhoneNumberSummarySchema.extend({
  provider: TelephonyProviderSchema,
  status: PhoneNumberStatusSchema,
  assignedTo: PhoneNumberAssignmentSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const PhoneNumberListResponseSchema = PaginationMetaSchema.extend({
  phoneNumbers: z.array(PhoneNumberResponseSchema),
});

export const AvailablePhoneNumberSchema = z.object({
  phoneNumber: z.string(),
  friendlyName: z.string(),
  type: PhoneNumberTypeSchema,
  /** The provider's own classification of the number. */
  providerType: z.enum(['local', 'toll-free', 'mobile']),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  isoCountry: z.string(),
  capabilities: z.object({
    voice: z.boolean(),
    sms: z.boolean(),
    mms: z.boolean(),
  }),
});

export const AvailableNumbersResponseSchema = z.object({
  numbers: z.array(AvailablePhoneNumberSchema),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PurchasePhoneNumber = z.infer<typeof PurchasePhoneNumberSchema>;
export type UpdatePhoneNumber = z.infer<typeof UpdatePhoneNumberSchema>;
export type PhoneNumberListQuery = z.infer<typeof PhoneNumberListQuerySchema>;
export type SearchAvailableNumbers = z.infer<
  typeof SearchAvailableNumbersSchema
>;
export type PhoneNumberAssignment = z.infer<typeof PhoneNumberAssignmentSchema>;
export type PhoneNumberResponse = z.infer<typeof PhoneNumberResponseSchema>;
export type PhoneNumberListResponse = z.infer<
  typeof PhoneNumberListResponseSchema
>;
export type AvailablePhoneNumber = z.infer<typeof AvailablePhoneNumberSchema>;
export type AvailableNumbersResponse = z.infer<
  typeof AvailableNumbersResponseSchema
>;
