import {
  type AttachedApplication,
  type AvailableNumbersResponse,
  type Campaign,
  type MessagingServiceOption,
  type MonthlyPrice,
  type OwnedPhoneNumber,
  type PhoneNumberConnection,
  type PhoneNumberType,
  type ReconnectReason,
  type SearchAvailableNumbers,
  SUPPORTED_NUMBER_COUNTRY,
  type TextingNote,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import twilio from 'twilio';
import type { TwilioCredentials } from '../config.js';
import { HttpError } from '../infra/index.js';
import {
  type CampaignRead,
  campaignFrom,
  connectingUpdate,
  describeReconnect,
  describeTextingNote,
  detachableSmsApplication,
  keepsIncomingTexts,
  type MessagingServiceRef,
  type NumberSettings,
  nameOf,
  reconnectReasons,
  type TwilioCampaignFields,
  textingNote,
  type WebhookAddresses,
} from './number-connection.js';

type SupportedCountry = typeof SUPPORTED_NUMBER_COUNTRY;
type AppPhoneNumberType = 'LOCAL' | 'TOLL_FREE';
type ProviderPhoneNumberType = 'local' | 'toll-free' | 'mobile';
type AvailableNumberResponseItem = NonNullable<
  AvailableNumbersResponse['numbers']
>[number];
/** A search's numbers; what they cost is asked of the price list separately. */
export type AvailableNumbers = Pick<AvailableNumbersResponse, 'numbers'>;

/**
 * How many of the account's numbers one listing reads. Twilio pages 1000 at
 * a time, and a single-customer account holds far fewer.
 */
const ACCOUNT_NUMBER_LIMIT = 1000;

/**
 * How many messaging services the texting check reads the senders of, one
 * call each. An account has a handful; past this the answer is unknown
 * rather than a burst of calls.
 */
const MESSAGING_SERVICE_LIMIT = 20;

/** Twilio's cap on the senders of one messaging service, so one call reads them all. */
const SERVICE_SENDER_LIMIT = 400;

/** How Twilio's phone number price list names each of our number types. */
const PRICE_LIST_NUMBER_TYPE: Record<PhoneNumberType, string> = {
  LOCAL: 'local',
  TOLL_FREE: 'toll free',
};

/** Twilio's error when the number asked for was bought by someone else meanwhile. */
const NUMBER_NOT_AVAILABLE = 21422;

/** Twilio's error for a resource, such as an account's number, that is not there. */
const RESOURCE_NOT_FOUND = 20404;

/**
 * How long before a purchase started Twilio may date a number the account
 * holds for that number to count as bought by it, whether the account is
 * found holding it before the purchase, Twilio answers the purchase with it,
 * or the purchase failed and the account lists it afterwards. Twilio dates
 * the number by its own clock when it sells it, so a purchase whose answer
 * was lost, or another tab's purchase of the same number a moment earlier,
 * is dated within seconds of this one, give or take the skew between the two
 * clocks: well under a second on a synchronised host, minutes on a VM or
 * container that lost its time sync. Ten minutes covers both with room to
 * spare, while a number another system has used is days or months old. Only
 * a number bought in the Twilio Console within those minutes would be taken
 * for this purchase.
 */
const OWN_PURCHASE_WINDOW_MS = 10 * 60 * 1000;

/**
 * How long before a purchase started Twilio may date the number it answers
 * a successful purchase with. The account was read just before and did not
 * hold the number, so Twilio sold it now; an answer dated long before is a
 * number the account already held, which Twilio answers a purchase of with
 * success, and which that read missed. Telling months from minutes needs no
 * narrow window, and a narrow one would refuse a real, billed purchase on a
 * host whose clock runs fast; a day allows any skew a working host has.
 */
const PURCHASE_ANSWER_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * What giving a number back found: Twilio took it, the account no longer had
 * it, or the removal went unanswered and the account does not show the
 * number gone, so it may be gone or not.
 */
export type CancelOutcome = 'released' | 'not-in-account' | 'unconfirmed';

interface TwilioPhoneNumberCapabilities {
  voice?: boolean;
  sms?: boolean;
  mms?: boolean;
  fax?: boolean;
  // Twilio's examples write every key in lower case, but its available-number
  // answers have been reported with these two in capitals.
  SMS?: boolean;
  MMS?: boolean;
}

interface TwilioAvailablePhoneNumber {
  phoneNumber?: string | null;
  friendlyName?: string | null;
  locality?: string | null;
  region?: string | null;
  postalCode?: string | null;
  isoCountry?: string | null;
  capabilities?: TwilioPhoneNumberCapabilities | null;
}

interface TwilioIncomingPhoneNumber {
  sid?: string | null;
  phoneNumber?: string | null;
  friendlyName?: string | null;
  locality?: string | null;
  region?: string | null;
  isoCountry?: string | null;
  capabilities?: TwilioPhoneNumberCapabilities | null;
  voiceUrl?: string | null;
  voiceMethod?: string | null;
  voiceFallbackUrl?: string | null;
  voiceFallbackMethod?: string | null;
  smsUrl?: string | null;
  smsMethod?: string | null;
  statusCallback?: string | null;
  statusCallbackMethod?: string | null;
  /** A TwiML App that takes the number's calls instead of its voice URLs. */
  voiceApplicationSid?: string | null;
  /** An application, or the messaging service it is a sender of, that takes its texts. */
  smsApplicationSid?: string | null;
  /** A SIP trunk that takes the number's calls instead of its voice URLs and app. */
  trunkSid?: string | null;
  /** When the account got the number; the SDK parses it into a Date. */
  dateCreated?: Date | string | null;
  status?: string | null;
  type?: string | null;
}

interface TwilioMessagingService {
  sid?: string | null;
  friendlyName?: string | null;
  useInboundWebhookOnNumber?: boolean | null;
  inboundRequestUrl?: string | null;
  inboundMethod?: string | null;
}

interface TwilioMessagingServiceSender {
  phoneNumber?: string | null;
}

interface TwilioMessagingServiceContextLike {
  fetch(): Promise<TwilioMessagingService>;
  /** The service's senders. */
  phoneNumbers: {
    list(
      params: Record<string, unknown>,
    ): Promise<TwilioMessagingServiceSender[]>;
  };
  /** The service's A2P 10DLC campaign; Twilio allows one per service. */
  usAppToPerson: {
    list(params: Record<string, unknown>): Promise<TwilioCampaignFields[]>;
  };
}

interface TwilioApplication {
  sid?: string | null;
  friendlyName?: string | null;
}

type TwilioMessagingServicesLike = {
  (sid: string): TwilioMessagingServiceContextLike;
  list(params: Record<string, unknown>): Promise<TwilioMessagingService[]>;
};

interface TwilioIncomingPhoneNumberContextLike {
  update(params: Record<string, unknown>): Promise<TwilioIncomingPhoneNumber>;
  remove(): Promise<boolean>;
  fetch(): Promise<TwilioIncomingPhoneNumber>;
}

interface TwilioNumberPrice {
  numberType?: string | null;
  basePrice?: number | string | null;
  currentPrice?: number | string | null;
}

interface TwilioNumberPricing {
  priceUnit?: string | null;
  phoneNumberPrices?: TwilioNumberPrice[] | null;
}

type TwilioIncomingPhoneNumbersLike = {
  (sid: string): TwilioIncomingPhoneNumberContextLike;
  create(params: Record<string, unknown>): Promise<TwilioIncomingPhoneNumber>;
  list(params: Record<string, unknown>): Promise<TwilioIncomingPhoneNumber[]>;
};

/** The slice of the Twilio SDK this service uses; tests substitute a fake. */
export type TwilioClientLike = {
  availablePhoneNumbers(countryCode: string): {
    local: {
      list(
        params: Record<string, unknown>,
      ): Promise<TwilioAvailablePhoneNumber[]>;
    };
    tollFree: {
      list(
        params: Record<string, unknown>,
      ): Promise<TwilioAvailablePhoneNumber[]>;
    };
  };
  incomingPhoneNumbers: TwilioIncomingPhoneNumbersLike;
  applications: {
    list(params: Record<string, unknown>): Promise<TwilioApplication[]>;
  };
  messaging: { v1: { services: TwilioMessagingServicesLike } };
  pricing: {
    v1: {
      phoneNumbers: {
        countries(isoCountry: string): {
          fetch(): Promise<TwilioNumberPricing>;
        };
      };
    };
  };
};

export interface TwilioNumberManagementOptions {
  /** Null when the deployment has no Twilio account yet; every provider call then fails with 503. */
  credentials: TwilioCredentials | null;
  /** Public base URL of this API; messaging webhooks point here. */
  publicUrl: string;
  /** Public base URL of the call controller; voice webhooks point there. */
  callControllerPublicUrl: string | null;
  log: FastifyBaseLogger;
  /** Overrides the SDK client built from the credentials. */
  client?: TwilioClientLike;
  /** The clock a failed purchase is dated against; the system clock by default. */
  now?: () => Date;
}

interface OwnedNumberParams {
  country: string;
  phoneNumber: string;
}

export interface OwnedNumberMetadata {
  phoneNumber: string;
  friendlyName: string;
  type: AppPhoneNumberType;
  providerType: ProviderPhoneNumberType | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  voiceEnabled: boolean;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  faxEnabled: boolean;
}

/** A number the list holds, as far as the readiness check needs it. */
export interface TrackedNumber {
  phoneNumber: string;
  type: AppPhoneNumberType;
}

/** A number on the account as the import list shows it, before it is matched with the list. */
export type AccountNumber = Omit<OwnedPhoneNumber, 'releasedHere'>;

/** The number as the account holds it, read before it is imported. */
export interface NumberToImport {
  metadata: OwnedNumberMetadata;
  /** What importing it replaces, for the audit log. */
  settings: NumberSettings;
}

export interface TwilioReadinessReport {
  status: 'ok' | 'error';
  timestamp: string;
  messagingTransport: 'messages-api';
  /** What keeps calls or texts from reaching this deployment; any one makes the status an error. */
  issues: string[];
  /** What may keep texts from arriving, or what could not be checked; the status stays as it is. */
  warnings: string[];
  account: {
    sid: string | null;
    configured: boolean;
    /** Null until the account was actually contacted. */
    reachable: boolean | null;
  };
  webhooks: WebhookAddresses | null;
  numbers: {
    /** Listed numbers found on the account and checked. */
    checked: number;
    /** Listed numbers whose calls or texts do not reach this deployment; Reconnect fixes each. */
    misconfigured: string[];
    /** Why each misconfigured number needs Reconnect. */
    reasons: Record<string, ReconnectReason[]>;
    /** Listed numbers this Twilio account does not hold. */
    notInAccount: string[];
    /** Numbers on the account that are not in the list, which nothing here checks. */
    untracked: number;
    /** What may keep each listed number's texts from arriving. */
    texting: Record<string, TextingNote>;
  };
}

export class TwilioProviderError extends HttpError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode);
  }
}

/** Twilio said no to giving up a number it had a moment before. */
export class ReleaseRefusedError extends TwilioProviderError {}

export class TwilioNumberManagementService {
  private readonly client: TwilioClientLike | null;
  private readonly credentials: TwilioCredentials | null;
  private readonly publicUrl: string;
  private readonly callControllerPublicUrl: string | null;
  private readonly log: FastifyBaseLogger;
  private readonly now: () => Date;

  constructor(options: TwilioNumberManagementOptions) {
    this.credentials = options.credentials;
    this.publicUrl = options.publicUrl;
    this.callControllerPublicUrl = options.callControllerPublicUrl;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.client =
      options.client ??
      (options.credentials
        ? (twilio(
            options.credentials.accountSid,
            options.credentials.authToken,
          ) as unknown as TwilioClientLike)
        : null);
  }

  /** True once an operator started wiring Twilio, so health can report on it. */
  hasAnyConfiguration(): boolean {
    return this.credentials !== null || this.callControllerPublicUrl !== null;
  }

  async searchAvailableNumbers(
    query: SearchAvailableNumbers,
  ): Promise<AvailableNumbers> {
    this.assertSupportedCountry(query.country);

    const params: Record<string, unknown> = {
      limit: query.limit,
      pageSize: query.limit,
      smsEnabled: true,
      voiceEnabled: true,
      // We never file an address with a purchase, so a number that needs
      // one, of any kind, would be refused at checkout.
      excludeAllAddressRequired: true,
      excludeLocalAddressRequired: true,
      excludeForeignAddressRequired: true,
    };

    if (query.contains) {
      // `$` anchors Twilio's pattern to the end of the number.
      params.contains =
        query.containsAt === 'end' ? `${query.contains}$` : query.contains;
    }

    if (query.type === 'LOCAL') {
      if (query.areaCode) {
        params.areaCode = Number.parseInt(query.areaCode, 10);
      }
      if (query.region) {
        params.inRegion = query.region;
      }
      if (query.locality) {
        params.inLocality = query.locality;
      }
    }

    try {
      const country = this.getClient().availablePhoneNumbers(query.country);
      const numbers =
        query.type === 'TOLL_FREE'
          ? await country.tollFree.list(params)
          : await country.local.list(params);

      return {
        numbers: numbers.map((number) =>
          this.mapAvailableNumber(number, query.type),
        ),
      };
    } catch (error) {
      throw this.wrapProviderError(
        error,
        'Failed to search available Twilio numbers',
      );
    }
  }

  /**
   * What Twilio charges a month for a number of this type in this country,
   * or null when its price list has no entry for the type.
   */
  async getMonthlyPrice(
    country: string,
    type: PhoneNumberType,
  ): Promise<MonthlyPrice | null> {
    this.assertSupportedCountry(country);

    try {
      const pricing = await this.getClient()
        .pricing.v1.phoneNumbers.countries(country)
        .fetch();
      const wanted = PRICE_LIST_NUMBER_TYPE[type];
      const entry = pricing.phoneNumberPrices?.find(
        (price) => price.numberType?.trim().toLowerCase() === wanted,
      );
      const amount = entry?.currentPrice ?? entry?.basePrice;

      if (amount === null || amount === undefined || !pricing.priceUnit) {
        return null;
      }

      return {
        amount: String(amount),
        currency: pricing.priceUnit.toUpperCase(),
      };
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to read Twilio prices');
    }
  }

  async buyNumber(params: OwnedNumberParams): Promise<void> {
    this.assertSupportedCountry(params.country);
    const client = this.getClient();
    // A number bought here must be pointed at the call controller next;
    // without its address, refuse before anything is billed.
    this.getExpectedWebhookAddresses();
    const startedAt = this.now();

    // Twilio answers a purchase of a number the account already holds with
    // that number, as if it had just sold it, so the account is asked first
    // and Twilio's answer is checked as well. A number held a moment already
    // is an earlier purchase from here whose answer was lost, or another
    // tab's, and is billed to the account: it counts as bought.
    const heldAlready = await this.accountNumberBeforePurchase(
      params.phoneNumber,
    );

    if (heldAlready) {
      assertBoughtByThisPurchase(heldAlready, startedAt);
      return;
    }

    let bought: TwilioIncomingPhoneNumber;

    try {
      bought = await client.incomingPhoneNumbers.create({
        phoneNumber: params.phoneNumber,
      });
    } catch (error) {
      // A purchase whose answer was lost, or that failed on Twilio's side,
      // may still have happened, and a number the account then holds is
      // billed to it. An account that does not list it yet proves nothing,
      // so only a confirmed purchase is reported either way.
      if (!isRefusal(error)) {
        const after = await this.accountNumberAfterFailure(params.phoneNumber);

        if (after.state === 'held') {
          assertBoughtByThisPurchase(after.number, startedAt);
          return;
        }

        throw new TwilioProviderError(
          `Twilio did not confirm the purchase (${
            error instanceof Error ? error.message : 'no answer'
          }), and ${
            after.state === 'unchecked'
              ? 'the account could not be checked'
              : 'the account does not list the number yet'
          }.`,
          504,
        );
      }
      if (twilioErrorCode(error) === NUMBER_NOT_AVAILABLE) {
        // Taken may mean taken by this account: by an earlier purchase whose
        // answer was lost, or by one from another tab. Such a number is billed
        // to the account, so it counts as bought and gets recorded; whichever
        // purchase records it second is told it is on the list. A number the
        // account held before is refused instead: recording it would point
        // it here and detach what it serves without keeping what that was.
        const after = await this.accountNumberAfterFailure(params.phoneNumber);

        if (after.state === 'held') {
          assertBoughtByThisPurchase(after.number, startedAt);
          return;
        }
        if (after.state === 'unchecked') {
          throw new TwilioProviderError(
            'Twilio says the number is taken, and the account could not be checked for it: an earlier purchase from here may have it.',
            504,
          );
        }

        throw new TwilioProviderError(
          'That number is no longer available. Search again and pick another one.',
          409,
        );
      }
      throw this.wrapProviderError(error, 'Failed to buy Twilio number');
    }

    // An answer with no date leaves the read before the purchase standing.
    if (purchaseAge(bought, startedAt, PURCHASE_ANSWER_SKEW_MS) === 'earlier') {
      throw heldBeforeError(bought);
    }
  }

  /**
   * Points the number's webhooks at this deployment and takes off the TwiML
   * App, SMS application or SIP trunk that Twilio would use instead. Any
   * number the account holds, whatever its country, so whatever the readiness
   * check flags can be repaired. Answers what the number carried before, and
   * fails unless Twilio's answer shows the number pointed here.
   *
   * `beforeChange` gets what the number carries once it is read and before
   * Twilio is asked to change it, so a caller can write it down first: a
   * change that fails half-way, or whose answer is lost, may already have
   * detached an app or a trunk. When it fails, nothing is changed.
   */
  async configureNumber(
    phoneNumber: string,
    beforeChange?: (previously: NumberSettings) => Promise<void>,
  ): Promise<NumberSettings> {
    const { ownedNumber, expected } = await this.readForChange(phoneNumber);
    const before = settingsOf(ownedNumber);

    await beforeChange?.(before);

    try {
      const after = await this.getClient()
        .incomingPhoneNumbers(ownedNumber.sid)
        .update(connectingUpdate(before, expected));
      const remaining = reconnectReasons(settingsOf(after), expected);

      if (remaining.length > 0) {
        throw new TwilioProviderError(
          `Twilio took the change, but ${describeReconnect(
            normalizePhoneNumber(ownedNumber.phoneNumber),
            remaining,
          )}.`,
        );
      }

      return before;
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to configure Twilio number');
    }
  }

  private async readForChange(phoneNumber: string): Promise<{
    ownedNumber: TwilioIncomingPhoneNumber & { sid: string };
    expected: WebhookAddresses;
  }> {
    try {
      return {
        ownedNumber: await this.requireOwnedNumber(phoneNumber),
        expected: this.getExpectedWebhookAddresses(),
      };
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to configure Twilio number');
    }
  }

  /**
   * The number as the account holds it, to be imported. Refuses, before
   * anything is recorded, a deployment that could not point the number here
   * and a number the account does not hold.
   */
  async readNumberForImport(phoneNumber: string): Promise<NumberToImport> {
    this.getClient();
    this.getExpectedWebhookAddresses();

    try {
      const ownedNumber = await this.requireOwnedNumber(phoneNumber);

      return {
        metadata: this.mapOwnedNumber(ownedNumber, 'LOCAL'),
        settings: settingsOf(ownedNumber),
      };
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to read the Twilio number');
    }
  }

  /**
   * Every number the account holds, with what takes its calls and texts
   * today, for an administrator choosing one to import.
   */
  async listAccountNumbers(): Promise<{
    numbers: AccountNumber[];
    truncated: boolean;
  }> {
    try {
      const { numbers, truncated } = await this.readAccountNumbers();
      const [services, applications] = await Promise.all([
        numbers.some(textCapable)
          ? this.messagingServicesBySender()
          : new Map<string, MessagingServiceRef>(),
        numbers.some(
          (number) =>
            number.voiceApplicationSid ||
            detachableSmsApplication(number.smsApplicationSid || null),
        )
          ? this.applicationNames()
          : new Map<string, string>(),
      ]);
      const campaigns = await this.campaignsOfLocalSenders(
        numbers.map((number) => this.mapOwnedNumber(number, 'LOCAL')),
        services,
      );

      return {
        truncated,
        numbers: numbers.map((number) =>
          this.describeAccountNumber(number, services, campaigns, applications),
        ),
      };
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to list the Twilio numbers');
    }
  }

  /** Whether a listed number's calls and texts reach this deployment now. */
  async checkConnection(
    phoneNumber: string,
    type: AppPhoneNumberType,
  ): Promise<PhoneNumberConnection> {
    this.getClient();
    const expected = this.getExpectedWebhookAddresses();

    try {
      const ownedNumber = await this.getOwnedNumber(phoneNumber);

      if (!ownedNumber) {
        return { state: 'not-in-account' };
      }

      const metadata = this.mapOwnedNumber(ownedNumber, type);
      const services = metadata.smsEnabled
        ? await this.messagingServicesBySender()
        : new Map<string, MessagingServiceRef>();
      const service =
        services === 'unknown'
          ? null
          : (services.get(metadata.phoneNumber) ?? null);
      const campaigns = service
        ? await this.campaignsOrUnknown([service.sid])
        : new Map<string, Campaign | null>();

      return {
        state: 'checked',
        needsReconnect: reconnectReasons(settingsOf(ownedNumber), expected),
        texting: textingNoteFor(
          metadata,
          services,
          campaigns,
          expected.messagesInbound,
        ),
      };
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to check the Twilio number');
    }
  }

  /**
   * Gives the number back to Twilio. A number the account no longer has
   * (released in the Twilio console, ported out, or never bought here) is
   * reported rather than refused, so the caller can stop listing it.
   */
  async cancelNumber(phoneNumber: string): Promise<CancelOutcome> {
    try {
      const ownedNumber = await this.getOwnedNumber(phoneNumber);

      if (!ownedNumber?.sid) {
        return 'not-in-account';
      }

      try {
        await this.getClient().incomingPhoneNumbers(ownedNumber.sid).remove();
      } catch (error) {
        // The number listed a moment ago is gone: another release took it,
        // whatever a listing taken now still shows.
        if (twilioErrorCode(error) === RESOURCE_NOT_FOUND) {
          return 'released';
        }

        const after = await this.accountNumberAfterFailure(phoneNumber);

        if (after.state === 'absent') {
          return 'released';
        }
        // A listing taken right after a removal whose answer was lost may
        // still show the number, so only its absence settles that removal.
        if (!isRefusal(error)) {
          this.log.warn({ error }, 'Twilio did not confirm a release');
          return 'unconfirmed';
        }

        throw new ReleaseRefusedError(
          error instanceof Error
            ? error.message
            : 'Twilio refused to release the number',
        );
      }

      return 'released';
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to release Twilio number');
    }
  }

  /**
   * The account's messaging services, each with its A2P 10DLC campaign, for
   * an administrator choosing the one a number texts through: one listing,
   * and one call per service for its campaign. Unknown when they cannot be
   * read, or when there are more of them than a check reads.
   */
  async listMessagingServices(): Promise<MessagingServiceOption[] | 'unknown'> {
    this.getClient();

    try {
      const services = await this.readMessagingServices();

      if (services === 'unknown') {
        return 'unknown';
      }

      const campaigns = await this.campaignsOf(
        services.map((service) => service.sid),
      );

      return services.map((service) =>
        this.optionOf(service, campaigns.get(service.sid) ?? null),
      );
    } catch (error) {
      // The pickers then say the services could not be read; nothing is
      // chosen blind.
      this.log.warn({ error }, 'Could not list the messaging services');
      return 'unknown';
    }
  }

  /** One messaging service with its campaign, or null when the account has none by that sid. */
  async readMessagingService(
    sid: string,
  ): Promise<MessagingServiceOption | null> {
    const messaging = this.getClient().messaging.v1.services;

    try {
      const service = await messaging(sid).fetch();
      const campaigns = await this.campaignsOf([sid]);

      return this.optionOf(
        serviceRefOf(service, service.sid || sid),
        campaigns.get(sid) ?? null,
      );
    } catch (error) {
      if (twilioErrorCode(error) === RESOURCE_NOT_FOUND) {
        return null;
      }
      throw this.wrapProviderError(
        error,
        'Failed to read the messaging service',
      );
    }
  }

  /**
   * The number as the account holds it before a purchase, or null. When the
   * account cannot be asked, nothing is bought: buying anyway could take
   * over a number another system uses.
   */
  private async accountNumberBeforePurchase(
    phoneNumber: string,
  ): Promise<TwilioIncomingPhoneNumber | null> {
    try {
      return await this.getOwnedNumber(phoneNumber);
    } catch (error) {
      this.log.warn(
        { error },
        'Could not check the account for a number before buying it',
      );
      throw new TwilioProviderError(
        'Twilio could not be asked whether your account already has this number, so nothing was bought. Try again in a moment.',
        503,
      );
    }
  }

  /**
   * The number as the account holds it after a purchase or a removal
   * failed, since one whose answer was lost (a timeout, a dropped connection,
   * a second release that got there first) may still have happened.
   * `unchecked` when the account cannot be asked either, and the first
   * failure stands.
   */
  private async accountNumberAfterFailure(
    phoneNumber: string,
  ): Promise<AccountAfterFailure> {
    try {
      const number = await this.getOwnedNumber(phoneNumber);

      return number ? { state: 'held', number } : { state: 'absent' };
    } catch (error) {
      this.log.warn(
        { error },
        'Could not check the account after a failed number change',
      );
      return { state: 'unchecked' };
    }
  }

  /**
   * The number as the account holds it, hosted numbers included: one left
   * out would be reported gone while Twilio kept billing for it, and could
   * not be reconnected.
   */
  async getOwnedNumber(
    phoneNumber: string,
  ): Promise<TwilioIncomingPhoneNumber | null> {
    const response = await this.getClient().incomingPhoneNumbers.list({
      phoneNumber,
      limit: 20,
      pageSize: 20,
    });
    const target = normalizePhoneNumber(phoneNumber);

    return (
      response.find(
        (candidate) => normalizePhoneNumber(candidate.phoneNumber) === target,
      ) ?? null
    );
  }

  async getOwnedNumberMetadata(
    phoneNumber: string,
    fallbackType: AppPhoneNumberType,
  ): Promise<OwnedNumberMetadata | null> {
    const ownedNumber = await this.getOwnedNumber(phoneNumber);

    return ownedNumber ? this.mapOwnedNumber(ownedNumber, fallbackType) : null;
  }

  /** Where texts land; it needs no call controller, unlike the voice webhooks. */
  private messagesInboundUrl(): string {
    return `${this.publicUrl}/webhooks/twilio/messages/inbound`;
  }

  /**
   * Webhook targets every owned number must carry. Messaging lands on this
   * API; voice lands on the call controller.
   */
  getExpectedWebhookAddresses(): WebhookAddresses {
    if (!this.callControllerPublicUrl) {
      throw new TwilioProviderError(
        'Call controller public URL is not configured; voice webhooks cannot be set',
        503,
      );
    }

    return {
      messagesInbound: this.messagesInboundUrl(),
      voice: `${this.callControllerPublicUrl}/webhooks/twilio/voice/inbound`,
      voiceFallback: `${this.callControllerPublicUrl}/webhooks/twilio/voice/fallback`,
      voiceStatus: `${this.callControllerPublicUrl}/webhooks/twilio/voice/status`,
    };
  }

  /**
   * Whether Twilio sends the calls and texts of the numbers in the list here.
   * Only listed numbers are checked: the account may hold numbers that serve
   * something else, and those are counted, not judged.
   */
  async getReadinessReport(
    tracked: readonly TrackedNumber[],
  ): Promise<TwilioReadinessReport> {
    const report: TwilioReadinessReport = {
      status: 'error',
      timestamp: new Date().toISOString(),
      messagingTransport: 'messages-api',
      issues: [],
      warnings: [],
      account: {
        sid: this.credentials?.accountSid ?? null,
        configured: this.credentials !== null,
        reachable: null,
      },
      webhooks: null,
      numbers: {
        checked: 0,
        misconfigured: [],
        reasons: {},
        notInAccount: [],
        untracked: 0,
        texting: {},
      },
    };

    if (!this.credentials) {
      report.issues.push('Twilio credentials are not configured');
    }

    if (!this.callControllerPublicUrl) {
      report.issues.push(
        'Call controller public URL is not configured; voice webhooks cannot be set',
      );
    }

    if (report.issues.length > 0) {
      return report;
    }

    const expected = this.getExpectedWebhookAddresses();
    report.webhooks = expected;

    try {
      const account = await this.readAccountNumbers();
      report.account.reachable = true;

      const onAccount = new Map(
        account.numbers.map((number) => [
          normalizePhoneNumber(number.phoneNumber),
          number,
        ]),
      );
      const trackedNumbers = new Set(
        tracked.map((number) => number.phoneNumber),
      );
      const found = tracked.flatMap((number) => {
        const ownedNumber = onAccount.get(number.phoneNumber);
        return ownedNumber
          ? [
              {
                ownedNumber,
                metadata: this.mapOwnedNumber(ownedNumber, number.type),
              },
            ]
          : [];
      });

      report.numbers.checked = found.length;
      report.numbers.untracked = [...onAccount.keys()].filter(
        (phoneNumber) => !trackedNumbers.has(phoneNumber),
      ).length;

      for (const { ownedNumber, metadata } of found) {
        const reasons = reconnectReasons(settingsOf(ownedNumber), expected);

        if (reasons.length > 0) {
          report.numbers.misconfigured.push(metadata.phoneNumber);
          report.numbers.reasons[metadata.phoneNumber] = reasons;
          report.issues.push(describeReconnect(metadata.phoneNumber, reasons));
        }
      }

      if (account.truncated) {
        // A listed number past the page read may well be on the account.
        report.warnings.push(
          `The account holds more than ${ACCOUNT_NUMBER_LIMIT} numbers; only the first ${ACCOUNT_NUMBER_LIMIT} were checked.`,
        );
      } else {
        report.numbers.notInAccount = tracked
          .map((number) => number.phoneNumber)
          .filter((phoneNumber) => !onAccount.has(phoneNumber));

        if (report.numbers.notInAccount.length > 0) {
          report.warnings.push(
            `${report.numbers.notInAccount.length} listed number(s) are not on this Twilio account, so their calls and texts do not come through it: ${report.numbers.notInAccount.join(', ')}`,
          );
        }
      }

      const texting = found.filter(({ metadata }) => metadata.smsEnabled);
      const services =
        texting.length > 0
          ? await this.messagingServicesBySender()
          : new Map<string, MessagingServiceRef>();
      const campaigns = await this.campaignsOfLocalSenders(
        texting.map(({ metadata }) => metadata),
        services,
      );

      if (services === 'unknown') {
        report.warnings.push(
          "The account's messaging services could not be read, so whether texts reach the listed numbers was not checked.",
        );
      } else {
        for (const { metadata } of texting) {
          const note = textingNoteFor(
            metadata,
            services,
            campaigns,
            this.messagesInboundUrl(),
          );

          if (note) {
            report.numbers.texting[metadata.phoneNumber] = note;
            report.warnings.push(
              describeTextingNote(metadata.phoneNumber, note),
            );
          }
        }
      }
    } catch (error) {
      this.log.error({ error }, 'Failed to validate Twilio readiness');
      report.account.reachable = false;
      report.issues.push(
        error instanceof Error
          ? error.message
          : 'Unable to validate Twilio readiness',
      );
    }

    report.status = report.issues.length === 0 ? 'ok' : 'error';

    return report;
  }

  /** The account's numbers, and whether it holds more than one listing reads. */
  private async readAccountNumbers(): Promise<{
    numbers: TwilioIncomingPhoneNumber[];
    truncated: boolean;
  }> {
    const numbers = await this.getClient().incomingPhoneNumbers.list({
      limit: ACCOUNT_NUMBER_LIMIT + 1,
      pageSize: ACCOUNT_NUMBER_LIMIT,
    });

    return {
      numbers: numbers.slice(0, ACCOUNT_NUMBER_LIMIT),
      truncated: numbers.length > ACCOUNT_NUMBER_LIMIT,
    };
  }

  /**
   * The messaging service sending from each of the account's numbers, by
   * number. Nothing on a number names its service (its `smsApplicationSid`
   * stays empty when it joins one), and Twilio answers who the senders are
   * only one service at a time, so this lists the services once and then
   * each one's senders: 1 + S calls for every number at once. Asking each
   * service about one number instead would cost S calls per number. Unknown
   * when the services cannot be read, or when there are more of them than a
   * check should call for; a check then says so rather than guess.
   */
  private async messagingServicesBySender(): Promise<
    ReadonlyMap<string, MessagingServiceRef> | 'unknown'
  > {
    try {
      const services = await this.readMessagingServices();

      if (services === 'unknown') {
        return 'unknown';
      }

      const messaging = this.getClient().messaging.v1.services;
      const senders = await Promise.all(
        services.map(async (ref) => {
          const numbers = await messaging(ref.sid).phoneNumbers.list({
            limit: SERVICE_SENDER_LIMIT,
            pageSize: SERVICE_SENDER_LIMIT,
          });

          return numbers.map(
            (sender) =>
              [normalizePhoneNumber(sender.phoneNumber), ref] as const,
          );
        }),
      );

      return new Map(senders.flat());
    } catch (error) {
      // Texting is a warning, never a reason the number cannot be used, so a
      // failure here leaves the check saying it could not tell.
      this.log.warn({ error }, 'Could not read the messaging services');
      return 'unknown';
    }
  }

  /** The account's messaging services, or unknown past the number a check reads. */
  private async readMessagingServices(): Promise<
    MessagingServiceRef[] | 'unknown'
  > {
    const services = await this.getClient().messaging.v1.services.list({
      limit: MESSAGING_SERVICE_LIMIT + 1,
      pageSize: MESSAGING_SERVICE_LIMIT + 1,
    });

    if (services.length > MESSAGING_SERVICE_LIMIT) {
      this.log.warn(
        { services: services.length },
        'Too many messaging services to check which one sends from each number',
      );
      return 'unknown';
    }

    return services.flatMap((service) =>
      service.sid ? [serviceRefOf(service, service.sid)] : [],
    );
  }

  /**
   * Each service's A2P 10DLC campaign, null for a service with none, one
   * call per service. Twilio allows one campaign per messaging service.
   */
  private async campaignsOf(
    serviceSids: readonly string[],
  ): Promise<ReadonlyMap<string, Campaign | null>> {
    const messaging = this.getClient().messaging.v1.services;
    const read = await Promise.all(
      [...new Set(serviceSids)].map(async (sid) => {
        const [campaign] = await messaging(sid).usAppToPerson.list({
          limit: 1,
          pageSize: 1,
        });

        return [sid, campaign ? campaignFrom(campaign) : null] as const;
      }),
    );

    return new Map(read);
  }

  /** The campaigns, or unknown: like the services, a campaign only informs a warning. */
  private async campaignsOrUnknown(
    serviceSids: readonly string[],
  ): Promise<ReadonlyMap<string, Campaign | null> | 'unknown'> {
    if (serviceSids.length === 0) {
      return new Map();
    }

    try {
      return await this.campaignsOf(serviceSids);
    } catch (error) {
      this.log.warn({ error }, 'Could not read the messaging campaigns');
      return 'unknown';
    }
  }

  /**
   * The campaigns of the services that local, text-capable numbers among
   * `numbers` send for: only theirs decide whether texts are registered.
   */
  private async campaignsOfLocalSenders(
    numbers: readonly OwnedNumberMetadata[],
    services: ReadonlyMap<string, MessagingServiceRef> | 'unknown',
  ): Promise<ReadonlyMap<string, Campaign | null> | 'unknown'> {
    if (services === 'unknown') {
      return new Map();
    }

    return this.campaignsOrUnknown(
      numbers.flatMap((number) => {
        const service =
          number.type === 'LOCAL' && number.smsEnabled
            ? services.get(number.phoneNumber)
            : undefined;

        return service ? [service.sid] : [];
      }),
    );
  }

  /** A service as an administrator chooses between them. */
  private optionOf(
    service: MessagingServiceRef,
    campaign: Campaign | null,
  ): MessagingServiceOption {
    return {
      ...nameOf(service),
      campaign,
      keepsIncomingTexts: keepsIncomingTexts(
        service,
        this.messagesInboundUrl(),
      ),
    };
  }

  /** The account's applications' names, by sid; empty when they cannot be read. */
  private async applicationNames(): Promise<ReadonlyMap<string, string>> {
    try {
      const applications = await this.getClient().applications.list({
        limit: ACCOUNT_NUMBER_LIMIT,
        pageSize: ACCOUNT_NUMBER_LIMIT,
      });

      return new Map(
        applications.flatMap((application) =>
          application.sid && application.friendlyName
            ? [[application.sid, application.friendlyName] as const]
            : [],
        ),
      );
    } catch (error) {
      // A name only helps an administrator recognise the app; its sid is shown either way.
      this.log.warn({ error }, 'Could not read the TwiML App names');
      return new Map();
    }
  }

  private describeAccountNumber(
    number: TwilioIncomingPhoneNumber,
    services: ReadonlyMap<string, MessagingServiceRef> | 'unknown',
    campaigns: ReadonlyMap<string, Campaign | null> | 'unknown',
    applications: ReadonlyMap<string, string>,
  ): AccountNumber {
    const metadata = this.mapOwnedNumber(number, 'LOCAL');
    const service =
      services === 'unknown'
        ? null
        : (services.get(metadata.phoneNumber) ?? null);
    const application = (sid: string | null): AttachedApplication | null =>
      sid ? { sid, friendlyName: applications.get(sid) ?? null } : null;

    return {
      phoneNumber: metadata.phoneNumber,
      friendlyName: metadata.friendlyName,
      type: metadata.type,
      capabilities: {
        voice: metadata.voiceEnabled,
        sms: metadata.smsEnabled,
        mms: metadata.mmsEnabled,
        fax: metadata.faxEnabled,
      },
      attached: {
        voiceUrlHost: hostOf(number.voiceUrl),
        smsUrlHost: hostOf(number.smsUrl),
        voiceApplication: application(number.voiceApplicationSid || null),
        smsApplication: application(
          detachableSmsApplication(number.smsApplicationSid || null),
        ),
        sipTrunkSid: number.trunkSid || null,
        messagingService: service
          ? { sid: service.sid, friendlyName: service.friendlyName }
          : null,
      },
      texting: textingNoteFor(
        metadata,
        services,
        campaigns,
        this.messagesInboundUrl(),
      ),
    };
  }

  private mapAvailableNumber(
    number: TwilioAvailablePhoneNumber,
    fallbackType: AppPhoneNumberType,
  ): AvailableNumberResponseItem {
    const phoneNumber = normalizePhoneNumber(number.phoneNumber);

    return {
      phoneNumber,
      friendlyName: number.friendlyName || phoneNumber,
      type: fallbackType,
      providerType: fallbackType === 'TOLL_FREE' ? 'toll-free' : 'local',
      locality: number.locality ?? null,
      region: number.region ?? null,
      postalCode: number.postalCode ?? null,
      isoCountry: number.isoCountry ?? SUPPORTED_NUMBER_COUNTRY,
      capabilities: {
        voice: Boolean(number.capabilities?.voice),
        sms: Boolean(number.capabilities?.sms || number.capabilities?.SMS),
        mms: Boolean(number.capabilities?.mms || number.capabilities?.MMS),
      },
    };
  }

  private mapOwnedNumber(
    number: TwilioIncomingPhoneNumber,
    fallbackType: AppPhoneNumberType,
  ): OwnedNumberMetadata {
    const phoneNumber = normalizePhoneNumber(number.phoneNumber);
    const providerType = normalizeProviderType(number.type);

    return {
      phoneNumber,
      friendlyName: number.friendlyName || phoneNumber,
      type: mapProviderTypeToInternal(providerType) ?? fallbackType,
      providerType,
      locality: number.locality ?? null,
      region: number.region ?? null,
      country: number.isoCountry ?? SUPPORTED_NUMBER_COUNTRY,
      voiceEnabled: Boolean(number.capabilities?.voice),
      smsEnabled: Boolean(number.capabilities?.sms || number.capabilities?.SMS),
      mmsEnabled: Boolean(number.capabilities?.mms || number.capabilities?.MMS),
      faxEnabled: Boolean(number.capabilities?.fax),
    };
  }

  private async requireOwnedNumber(
    phoneNumber: string,
  ): Promise<TwilioIncomingPhoneNumber & { sid: string }> {
    const ownedNumber = await this.getOwnedNumber(phoneNumber);

    // The number is listed here, so its absence at Twilio is a conflict
    // between the two, not a missing resource.
    if (!ownedNumber?.sid) {
      throw new TwilioProviderError(
        'This Twilio account does not have the number, so its calls and texts cannot be pointed here.',
        409,
      );
    }

    return { ...ownedNumber, sid: ownedNumber.sid };
  }

  private assertSupportedCountry(
    country: string,
  ): asserts country is SupportedCountry {
    if (country !== SUPPORTED_NUMBER_COUNTRY) {
      throw new TwilioProviderError(
        `Twilio number management only supports ${SUPPORTED_NUMBER_COUNTRY}`,
        400,
      );
    }
  }

  private getClient(): TwilioClientLike {
    if (!this.client) {
      throw new TwilioProviderError(
        'Twilio number management is not configured',
        503,
      );
    }

    return this.client;
  }

  private wrapProviderError(
    error: unknown,
    fallbackMessage: string,
  ): TwilioProviderError {
    if (error instanceof TwilioProviderError) {
      return error;
    }

    return new TwilioProviderError(
      error instanceof Error ? error.message : fallbackMessage,
    );
  }
}

type AccountAfterFailure =
  | { state: 'held'; number: TwilioIncomingPhoneNumber }
  | { state: 'absent' }
  | { state: 'unchecked' };

/**
 * Refuses to count as bought a number the account held before this purchase
 * started, or whose date Twilio does not give. Nothing has been written or
 * changed at Twilio by then, so the admin can add it as a number they own,
 * which records how it is set up today.
 */
function assertBoughtByThisPurchase(
  number: TwilioIncomingPhoneNumber,
  startedAt: Date,
): void {
  if (purchaseAge(number, startedAt) !== 'recent') {
    throw heldBeforeError(number);
  }
}

/** Whether Twilio dates the number within `window` before the purchase started, earlier, or not at all. */
function purchaseAge(
  number: TwilioIncomingPhoneNumber,
  startedAt: Date,
  window = OWN_PURCHASE_WINDOW_MS,
): 'recent' | 'earlier' | 'undated' {
  const dateCreated = dateOf(number.dateCreated);

  if (!dateCreated) {
    return 'undated';
  }

  return dateCreated.getTime() >= startedAt.getTime() - window
    ? 'recent'
    : 'earlier';
}

function heldBeforeError(
  number: TwilioIncomingPhoneNumber,
): TwilioProviderError {
  const dateCreated = dateOf(number.dateCreated);
  const since = dateCreated
    ? ` since ${dateCreated.toISOString().slice(0, 10)}`
    : '';

  return new TwilioProviderError(
    `Your Twilio account has had this number${since}, so it was not bought again and nothing was changed. To bring it into this list, use Add a number you own, which keeps a record of how it is set up today.`,
    409,
  );
}

function dateOf(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Twilio answered and said no, as opposed to an answer that never arrived or
 * a failure on Twilio's side.
 */
function isRefusal(error: unknown): boolean {
  if (twilioErrorCode(error) === null) {
    return false;
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? error.status
      : undefined;

  return typeof status !== 'number' || status < 500;
}

/** The numeric Twilio error code a REST failure carries, if any. */
function twilioErrorCode(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'number' ? code : null;
  }

  return null;
}

/** Every field of a Twilio number that decides where its calls and texts go. */
function settingsOf(number: TwilioIncomingPhoneNumber): NumberSettings {
  return {
    voiceUrl: number.voiceUrl || null,
    voiceMethod: number.voiceMethod || null,
    voiceFallbackUrl: number.voiceFallbackUrl || null,
    voiceFallbackMethod: number.voiceFallbackMethod || null,
    statusCallback: number.statusCallback || null,
    statusCallbackMethod: number.statusCallbackMethod || null,
    smsUrl: number.smsUrl || null,
    smsMethod: number.smsMethod || null,
    voiceApplicationSid: number.voiceApplicationSid || null,
    smsApplicationSid: number.smsApplicationSid || null,
    trunkSid: number.trunkSid || null,
  };
}

function textCapable(number: TwilioIncomingPhoneNumber): boolean {
  return Boolean(number.capabilities?.sms || number.capabilities?.SMS);
}

function textingNoteFor(
  metadata: OwnedNumberMetadata,
  services: ReadonlyMap<string, MessagingServiceRef> | 'unknown',
  campaigns: ReadonlyMap<string, Campaign | null> | 'unknown',
  messagesInbound: string,
): TextingNote | null {
  const service =
    services === 'unknown'
      ? 'unknown'
      : (services.get(metadata.phoneNumber) ?? null);

  return textingNote(
    { local: metadata.type === 'LOCAL', texts: metadata.smsEnabled },
    service,
    service === 'unknown' ? 'unknown' : campaignIn(campaigns, service),
    messagesInbound,
  );
}

/** The campaign of `service` among those read; unknown when it was not read. */
function campaignIn(
  campaigns: ReadonlyMap<string, Campaign | null> | 'unknown',
  service: MessagingServiceRef | null,
): CampaignRead {
  if (!service) {
    return null;
  }
  if (campaigns === 'unknown') {
    return 'unknown';
  }

  const campaign = campaigns.get(service.sid);

  return campaign === undefined ? 'unknown' : campaign;
}

function serviceRefOf(
  service: TwilioMessagingService,
  sid: string,
): MessagingServiceRef {
  return {
    sid,
    friendlyName: service.friendlyName || sid,
    useInboundWebhookOnNumber: Boolean(service.useInboundWebhookOnNumber),
    inboundRequestUrl: service.inboundRequestUrl || null,
    inboundMethod: service.inboundMethod || null,
  };
}

/** The host a webhook points at, which is what tells an administrator what it serves. */
function hostOf(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).host || null;
  } catch {
    // Not a URL Twilio could call either; show it as it is.
    return url;
  }
}

function mapProviderTypeToInternal(
  providerType: ProviderPhoneNumberType | null,
): AppPhoneNumberType | null {
  if (providerType === 'toll-free') {
    return 'TOLL_FREE';
  }

  if (providerType === 'local' || providerType === 'mobile') {
    return 'LOCAL';
  }

  return null;
}

function normalizeProviderType(
  type: string | null | undefined,
): ProviderPhoneNumberType | null {
  const normalized = (type || '').trim().toLowerCase();

  if (normalized === 'local' || normalized === 'mobile') {
    return normalized;
  }

  if (normalized === 'toll-free' || normalized === 'toll_free') {
    return 'toll-free';
  }

  return null;
}

function normalizePhoneNumber(value: string | null | undefined): string {
  return (value || '').trim();
}
