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

/** A Twilio messaging service, by its sid. */
export const MessagingServiceSidSchema = z
  .string()
  .regex(/^MG[0-9a-fA-F]{32}$/, 'Not a Twilio messaging service id');

/**
 * The messaging service a new local number joins, whose A2P 10DLC campaign
 * registers its texts. Left out, the deployment's default applies; `null`
 * joins none.
 */
const JoinMessagingServiceSchema = MessagingServiceSidSchema.nullable();

export const PurchasePhoneNumberSchema = z
  .object({
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
    messagingServiceSid: JoinMessagingServiceSchema.optional(),
  })
  .refine((value) => !value.messagingServiceSid || value.type === 'LOCAL', {
    // A toll-free number is verified on its own, not through a campaign.
    message: 'Only a local number joins a messaging service here.',
    path: ['messagingServiceSid'],
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
    /**
     * Joined only by a local number in no messaging service: one already in
     * a service stays in it.
     */
    messagingServiceSid: JoinMessagingServiceSchema.optional(),
  })
  .refine((value) => !value.isPrimary || value.owner?.type === 'department', {
    message: 'Only a number a department holds can be its primary number.',
    path: ['isPrimary'],
  });

/**
 * Puts a listed local number in a messaging service, or moves it there from
 * the one it is in.
 */
export const SetMessagingServiceSchema = z.object({
  messagingServiceSid: MessagingServiceSidSchema,
  /**
   * The service the admin saw the number in (`null` for none). The change is
   * refused once the number is in another one.
   */
  expectedMessagingServiceSid: MessagingServiceSidSchema.nullable(),
});

/** The service new local numbers join; `null` for none. */
export const UpdateDefaultMessagingServiceSchema = z.object({
  messagingServiceSid: MessagingServiceSidSchema.nullable(),
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

export const MessagingServiceNameSchema = z.object({
  sid: z.string(),
  friendlyName: z.string(),
});

/**
 * Where a messaging service's A2P 10DLC campaign stands: carriers accept
 * texts once it is approved, and block them while it is in review. Any other
 * state Twilio reports (failed, or one this app does not know) is not
 * approved.
 */
export const CampaignStatusSchema = z.enum([
  'approved',
  'in-review',
  'not-approved',
]);

/** The A2P 10DLC campaign registered for a messaging service. */
export const CampaignSchema = z.object({
  status: CampaignStatusSchema,
  /** The state as Twilio names it, such as `VERIFIED` or `FAILED`. */
  twilioStatus: z.string(),
  /** Twilio's use case code, such as `CUSTOMER_CARE` or `LOW_VOLUME`. */
  useCase: z.string(),
  description: z.string(),
});

/** A messaging service a number can text through, with its campaign. */
export const MessagingServiceOptionSchema = MessagingServiceNameSchema.extend({
  /** Null when the service has no A2P 10DLC campaign. */
  campaign: CampaignSchema.nullable(),
  /**
   * The service sends its senders' incoming texts to an address of its own
   * other than this deployment's, so they would not arrive here.
   */
  keepsIncomingTexts: z.boolean(),
});

export const MessagingServicesResponseSchema = z.object({
  /**
   * The account's messaging services, or null when they could not be read
   * or there are more than a check reads.
   */
  services: z.array(MessagingServiceOptionSchema).nullable(),
  /** The service new local numbers join, as the settings name it; null for none. */
  defaultSid: z.string().nullable(),
});

export const DefaultMessagingServiceResponseSchema = z.object({
  defaultSid: z.string().nullable(),
});

/** What happened to a number's messaging service when it was bought or added. */
export const MessagingServiceJoinSchema = z.discriminatedUnion('state', [
  /** It joined this service, whose campaign registers its texts. */
  z.object({ state: z.literal('joined'), service: MessagingServiceNameSchema }),
  /** It was a sender of this service already, and stays one. */
  z.object({ state: z.literal('kept'), service: MessagingServiceNameSchema }),
  /** It joined none: none was asked for, there is no default, or it cannot text through one. */
  z.object({ state: z.literal('none') }),
  /** It was to join a service and did not; its page can add it. */
  z.object({
    state: z.literal('failed'),
    service: MessagingServiceNameSchema.nullable(),
    message: z.string(),
  }),
]);

/** A number's move into a messaging service, from the one it was in. */
export const MessagingServiceChangeSchema = z.object({
  from: MessagingServiceNameSchema.nullable(),
  to: MessagingServiceNameSchema,
});

export const PurchasedPhoneNumberSchema = PhoneNumberResponseSchema.extend({
  /**
   * Whether Twilio took the number's call and text settings. When it did
   * not, the number is still bought and listed, and Reconnect sets them.
   */
  connected: z.boolean(),
  messagingService: MessagingServiceJoinSchema,
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

/**
 * Why texts to or from a number may not arrive although its webhooks are
 * right, which Reconnect does not change. A number's messaging service is
 * chosen on its page; the service's own settings and its campaign are
 * managed in the Twilio Console.
 */
export const TextingNoteSchema = z.discriminatedUnion('kind', [
  /** The service sends its senders' inbound texts to its own address, not the number's. */
  z.object({
    kind: z.literal('service-takes-texts'),
    service: MessagingServiceNameSchema,
  }),
  /** A local number in no messaging service: carriers block its unregistered texts (A2P 10DLC). */
  z.object({ kind: z.literal('unregistered') }),
  /** A local number in a service with no A2P 10DLC campaign: its texts are unregistered too. */
  z.object({
    kind: z.literal('no-campaign'),
    service: MessagingServiceNameSchema,
  }),
  /** A local number whose service's campaign carriers have not approved yet. */
  z.object({
    kind: z.literal('campaign-in-review'),
    service: MessagingServiceNameSchema,
  }),
  /** A local number whose service's campaign was not approved. */
  z.object({
    kind: z.literal('campaign-not-approved'),
    service: MessagingServiceNameSchema,
  }),
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
    /**
     * The messaging service the number texts through; null when it is in
     * none, or when the services could not be read (`texting` says which).
     */
    messagingService: MessagingServiceOptionSchema.nullable(),
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
export type MessagingServiceSid = z.infer<typeof MessagingServiceSidSchema>;
export type SetMessagingService = z.infer<typeof SetMessagingServiceSchema>;
export type UpdateDefaultMessagingService = z.infer<
  typeof UpdateDefaultMessagingServiceSchema
>;
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
export type MessagingServiceOption = z.infer<
  typeof MessagingServiceOptionSchema
>;
export type MessagingServicesResponse = z.infer<
  typeof MessagingServicesResponseSchema
>;
export type DefaultMessagingServiceResponse = z.infer<
  typeof DefaultMessagingServiceResponseSchema
>;
export type MessagingServiceJoin = z.infer<typeof MessagingServiceJoinSchema>;
export type MessagingServiceChange = z.infer<
  typeof MessagingServiceChangeSchema
>;

// ---------------------------------------------------------------------------
// Which messaging service a local number may text through
// ---------------------------------------------------------------------------

/**
 * Why a local number may not join a messaging service. A service without a
 * campaign, or whose campaign was not approved, registers nothing, so a number
 * in it texts no better than one in none. A campaign still in review is
 * allowed: the number is registered once carriers approve it.
 */
export type JoinRefusal = 'no-campaign' | 'campaign-not-approved';

/**
 * Why a service may not be the one every new local number joins: what keeps
 * any number from joining it, and a service that keeps its senders' incoming
 * texts, which would leave each new number unable to receive any. One number
 * may still be put in such a service on purpose.
 */
export type DefaultRefusal = JoinRefusal | 'keeps-incoming-texts';

/** Why a local number may not join `service`, or null when it may. */
export function joinRefusal(
  service: Pick<MessagingServiceOption, 'campaign'>,
): JoinRefusal | null {
  if (!service.campaign) {
    return 'no-campaign';
  }

  return service.campaign.status === 'not-approved'
    ? 'campaign-not-approved'
    : null;
}

/** Why `service` may not be the default for new local numbers, or null when it may. */
export function defaultRefusal(
  service: Pick<MessagingServiceOption, 'campaign' | 'keepsIncomingTexts'>,
): DefaultRefusal | null {
  return (
    joinRefusal(service) ??
    (service.keepsIncomingTexts ? 'keeps-incoming-texts' : null)
  );
}

/** Each refusal in one sentence, for the console and for the API's answer. */
export const REFUSAL_TEXT: Record<DefaultRefusal, string> = {
  'no-campaign':
    'This messaging service has no A2P 10DLC campaign, so it registers no texts.',
  'campaign-not-approved':
    "This messaging service's A2P 10DLC campaign was not approved, so carriers block its texts.",
  'keeps-incoming-texts':
    "This messaging service sends its numbers' incoming texts to an address of its own, so they would not reach iziphone. In the Twilio Console, set its incoming messages to “Defer to sender's webhook” first.",
};
