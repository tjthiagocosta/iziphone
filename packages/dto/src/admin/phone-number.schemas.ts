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
} from '../common/primitives.js';
import { PhoneNumberSummarySchema } from './department.schemas.js';

/** Numbers can only be bought in this country for now. */
export const SUPPORTED_NUMBER_COUNTRY = 'US';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Who holds a number: one user or one department, never both. */
export const PhoneNumberOwnerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: EntityIdSchema }),
  z.object({ type: z.literal('department'), id: EntityIdSchema }),
]);

export const PurchasePhoneNumberSchema = z.object({
  phoneNumber: E164PhoneNumberSchema,
  country: z
    .literal(SUPPORTED_NUMBER_COUNTRY)
    .default(SUPPORTED_NUMBER_COUNTRY),
  type: PhoneNumberTypeSchema,
  label: z.string().trim().max(50).optional(),
  /** Left out, the number goes into the reserve. */
  owner: PhoneNumberOwnerSchema.optional(),
  /** Only means something for a department; its first number is primary anyway. */
  isPrimary: z.boolean().default(false),
});

/**
 * Brings a number the Twilio account already holds into the list. It names
 * the number the way every other request here does, and the way the list
 * keys it; the Twilio account is asked for the number when it is imported.
 */
export const ImportPhoneNumberSchema = z
  .object({
    phoneNumber: E164PhoneNumberSchema,
    label: z.string().trim().max(50).optional(),
    /** Left out, the number goes into the reserve. */
    owner: PhoneNumberOwnerSchema.optional(),
    /** Only for a department; its first number is primary anyway. */
    isPrimary: z.boolean().default(false),
  })
  .refine((value) => !value.isPrimary || value.owner?.type === 'department', {
    message: 'Only a number a department holds can be its primary number.',
    path: ['isPrimary'],
  });

export const UpdatePhoneNumberSchema = z.object({
  label: z.string().trim().max(50).nullable().optional(),
  /** A new holder; `null` puts the number in the reserve, leaving it out keeps the holder. */
  owner: PhoneNumberOwnerSchema.nullable().optional(),
  /**
   * The holder the admin saw when deciding (`null` for the reserve). A change
   * made after somebody else moved the number is refused instead of applied.
   */
  expectedOwner: PhoneNumberOwnerSchema.nullable().optional(),
  /** Only for a number a department holds once this change is applied. */
  isPrimary: z.boolean().optional(),
});

export const PhoneNumberListQuerySchema = PaginationQuerySchema.extend({
  status: PhoneNumberStatusSchema.optional(),
  type: PhoneNumberTypeSchema.optional(),
  /** Only numbers held by a user, by a department, or by nobody (the reserve). */
  assignedTo: z.enum(['user', 'department', 'nobody']).optional(),
  /** Matches the number, its label, or the name of whoever holds it. */
  search: z.string().trim().min(1).optional(),
});

/** Filters that narrow a search to a place; Twilio honours them for local numbers only. */
const LOCAL_ONLY_FILTERS = ['areaCode', 'region', 'locality'] as const;

/**
 * What an admin may ask a number to contain: digits, or letters that stand
 * for their keypad digits (`PIZZA` finds a vanity number). Twilio's own
 * wildcards stay out of it; where the digits sit is {@link ContainsAtSchema}.
 */
export const NUMBER_PATTERN = /^[0-9A-Za-z]{2,10}$/;

/** Where the digits asked for must appear in the number. */
export const ContainsAtSchema = z.enum(['anywhere', 'end']);

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
    /** Two-letter state or province code. */
    region: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'State must be a two-letter code')
      .optional(),
    /** City name. */
    locality: z
      .string()
      .trim()
      .min(2, 'City must be at least 2 characters')
      .max(60)
      .optional(),
    contains: z
      .string()
      .trim()
      .regex(NUMBER_PATTERN, 'Use 2 to 10 digits or letters')
      .optional(),
    /** Left out, the digits may appear anywhere. */
    containsAt: ContainsAtSchema.optional(),
    limit: z.coerce.number().int().min(1).max(30).default(10),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'LOCAL') {
      return;
    }

    for (const filter of LOCAL_ONLY_FILTERS) {
      if (value[filter] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Only local numbers can be searched by place',
          path: [filter],
        });
      }
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

export const PurchasedPhoneNumberSchema = PhoneNumberResponseSchema.extend({
  /**
   * Whether Twilio took the number's call and text settings. When it did
   * not, the number is still bought and listed, and Reconnect sets them.
   */
  connected: z.boolean(),
});

/**
 * What an import answers, as a purchase does: `connected` false means the
 * number is listed but Twilio did not take its settings, and Reconnect sets
 * them.
 */
export const ImportedPhoneNumberSchema = PurchasedPhoneNumberSchema;

/**
 * Why a number's calls or texts do not reach this deployment, each of which
 * Reconnect fixes: a webhook pointing elsewhere, or something attached to the
 * number that Twilio uses instead of its webhooks.
 */
export const ReconnectReasonSchema = z.enum([
  'voice-url',
  'voice-fallback-url',
  'status-callback',
  'sms-url',
  /** A TwiML App takes the number's calls. */
  'voice-application',
  /** An application takes the number's texts. */
  'sms-application',
  /** A SIP trunk takes the number's calls. */
  'sip-trunk',
]);

export const MessagingServiceNameSchema = z.object({
  sid: z.string(),
  friendlyName: z.string(),
});

/**
 * Why texts to or from a number may not arrive although its webhooks are
 * right, which Reconnect does not change: messaging services are managed in
 * the Twilio Console.
 */
export const TextingNoteSchema = z.discriminatedUnion('kind', [
  /** The service sends its senders' inbound texts to its own address, not the number's. */
  z.object({
    kind: z.literal('service-takes-texts'),
    service: MessagingServiceNameSchema,
  }),
  /** A local number in no messaging service: carriers block its unregistered texts (A2P 10DLC). */
  z.object({ kind: z.literal('unregistered') }),
  /** The account's messaging services could not be read. */
  z.object({ kind: z.literal('unknown') }),
]);

/** Whether a listed number's calls and texts reach this deployment, as Twilio has it now. */
export const PhoneNumberConnectionSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not-in-account') }),
  z.object({
    state: z.literal('checked'),
    /** Empty when Twilio sends the number's calls and texts here. */
    needsReconnect: z.array(ReconnectReasonSchema),
    texting: TextingNoteSchema.nullable(),
  }),
]);

/** Something attached to a number that Twilio uses instead of its webhooks. */
export const AttachedApplicationSchema = z.object({
  sid: z.string(),
  /** Null when the account's applications could not be read. */
  friendlyName: z.string().nullable(),
});

/** A number the Twilio account holds that is not in the list, offered for import. */
export const OwnedPhoneNumberSchema = z.object({
  phoneNumber: z.string(),
  friendlyName: z.string(),
  type: PhoneNumberTypeSchema,
  capabilities: z.object({
    voice: z.boolean(),
    sms: z.boolean(),
    mms: z.boolean(),
    fax: z.boolean(),
  }),
  /** Released here before: importing it brings its row and history back. */
  releasedHere: z.boolean(),
  /** What takes the number's calls and texts today; importing replaces all of it. */
  attached: z.object({
    voiceUrlHost: z.string().nullable(),
    smsUrlHost: z.string().nullable(),
    voiceApplication: AttachedApplicationSchema.nullable(),
    smsApplication: AttachedApplicationSchema.nullable(),
    sipTrunkSid: z.string().nullable(),
    /** The messaging service sending from it; Twilio allows one. Importing leaves it. */
    messagingService: MessagingServiceNameSchema.nullable(),
  }),
  /** What may keep its texts from arriving after the import as well. */
  texting: TextingNoteSchema.nullable(),
});

export const OwnedPhoneNumbersResponseSchema = z.object({
  numbers: z.array(OwnedPhoneNumberSchema),
  /** The account holds more numbers than were read, and the rest are not offered. */
  truncated: z.boolean(),
});

export const ReleasedPhoneNumberSchema = z.object({
  /**
   * False when Twilio's account did not have the number, so nothing was
   * cancelled there; it may still be billed on another account.
   */
  cancelledAtTwilio: z.boolean(),
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

/** A recurring charge as the provider quotes it: a decimal string and an ISO currency code. */
export const MonthlyPriceSchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const AvailableNumbersResponseSchema = z.object({
  numbers: z.array(AvailablePhoneNumberSchema),
  /** What each of these numbers costs a month; null when the price list could not be read. */
  monthlyPrice: MonthlyPriceSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PhoneNumberOwner = z.infer<typeof PhoneNumberOwnerSchema>;
export type PurchasePhoneNumber = z.infer<typeof PurchasePhoneNumberSchema>;
export type ImportPhoneNumber = z.infer<typeof ImportPhoneNumberSchema>;
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
export type PurchasedPhoneNumber = z.infer<typeof PurchasedPhoneNumberSchema>;
export type ImportedPhoneNumber = z.infer<typeof ImportedPhoneNumberSchema>;
export type ReconnectReason = z.infer<typeof ReconnectReasonSchema>;
export type MessagingServiceName = z.infer<typeof MessagingServiceNameSchema>;
export type TextingNote = z.infer<typeof TextingNoteSchema>;
export type PhoneNumberConnection = z.infer<typeof PhoneNumberConnectionSchema>;
export type AttachedApplication = z.infer<typeof AttachedApplicationSchema>;
export type OwnedPhoneNumber = z.infer<typeof OwnedPhoneNumberSchema>;
export type OwnedPhoneNumbersResponse = z.infer<
  typeof OwnedPhoneNumbersResponseSchema
>;
export type ReleasedPhoneNumber = z.infer<typeof ReleasedPhoneNumberSchema>;
export type AvailablePhoneNumber = z.infer<typeof AvailablePhoneNumberSchema>;
export type ContainsAt = z.infer<typeof ContainsAtSchema>;
export type MonthlyPrice = z.infer<typeof MonthlyPriceSchema>;
export type AvailableNumbersResponse = z.infer<
  typeof AvailableNumbersResponseSchema
>;
