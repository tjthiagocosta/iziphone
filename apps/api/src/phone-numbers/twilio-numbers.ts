import {
  type AvailableNumbersResponse,
  type SearchAvailableNumbers,
  SUPPORTED_NUMBER_COUNTRY,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import twilio from 'twilio';
import type { TwilioCredentials } from '../config.js';
import { HttpError } from '../infra/index.js';

type SupportedCountry = typeof SUPPORTED_NUMBER_COUNTRY;
type AppPhoneNumberType = 'LOCAL' | 'TOLL_FREE';
type ProviderPhoneNumberType = 'local' | 'toll-free' | 'mobile';
type AvailableNumberResponseItem = NonNullable<
  AvailableNumbersResponse['numbers']
>[number];

/** How many owned numbers the readiness check inspects per call. */
const READINESS_NUMBER_LIMIT = 50;

interface TwilioPhoneNumberCapabilities {
  voice?: boolean;
  sms?: boolean;
  mms?: boolean;
  fax?: boolean;
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
  voiceFallbackUrl?: string | null;
  smsUrl?: string | null;
  statusCallback?: string | null;
  status?: string | null;
  type?: string | null;
}

interface TwilioIncomingPhoneNumberContextLike {
  update(params: Record<string, unknown>): Promise<TwilioIncomingPhoneNumber>;
  remove(): Promise<boolean>;
  fetch(): Promise<TwilioIncomingPhoneNumber>;
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

export interface TwilioWebhookAddresses {
  messagesInbound: string;
  messagesStatus: string;
  voice: string;
  voiceFallback: string;
}

export interface TwilioReadinessReport {
  status: 'ok' | 'error';
  timestamp: string;
  messagingTransport: 'messages-api';
  issues: string[];
  account: {
    sid: string | null;
    configured: boolean;
    /** Null until the account was actually contacted. */
    reachable: boolean | null;
  };
  webhooks: TwilioWebhookAddresses | null;
  numbers: {
    checked: number;
    /** Owned numbers whose webhooks do not point at this deployment. */
    misconfigured: string[];
  };
}

export class TwilioProviderError extends HttpError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode);
  }
}

export class TwilioNumberManagementService {
  private readonly client: TwilioClientLike | null;
  private readonly credentials: TwilioCredentials | null;
  private readonly publicUrl: string;
  private readonly callControllerPublicUrl: string | null;
  private readonly log: FastifyBaseLogger;

  constructor(options: TwilioNumberManagementOptions) {
    this.credentials = options.credentials;
    this.publicUrl = options.publicUrl;
    this.callControllerPublicUrl = options.callControllerPublicUrl;
    this.log = options.log;
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
  ): Promise<AvailableNumbersResponse> {
    this.assertSupportedCountry(query.country);

    const params: Record<string, unknown> = {
      limit: query.limit,
      pageSize: query.limit,
      smsEnabled: true,
      voiceEnabled: true,
    };

    if (query.contains?.trim()) {
      params.contains = query.contains.trim();
    }

    if (query.type === 'LOCAL' && query.areaCode) {
      params.areaCode = Number.parseInt(query.areaCode, 10);
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

  async buyNumber(params: OwnedNumberParams): Promise<void> {
    this.assertSupportedCountry(params.country);

    try {
      await this.getClient().incomingPhoneNumbers.create({
        phoneNumber: params.phoneNumber,
      });
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to buy Twilio number');
    }
  }

  /** Points the number's webhooks at this deployment. */
  async configureNumber(params: OwnedNumberParams): Promise<void> {
    this.assertSupportedCountry(params.country);

    try {
      const ownedNumber = await this.requireOwnedNumber(params.phoneNumber);
      const expected = this.getExpectedWebhookAddresses();

      await this.getClient().incomingPhoneNumbers(ownedNumber.sid).update({
        smsUrl: expected.messagesInbound,
        smsMethod: 'POST',
        statusCallback: expected.messagesStatus,
        statusCallbackMethod: 'POST',
        voiceUrl: expected.voice,
        voiceMethod: 'POST',
        voiceFallbackUrl: expected.voiceFallback,
        voiceFallbackMethod: 'POST',
      });
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to configure Twilio number');
    }
  }

  async cancelNumber(params: OwnedNumberParams): Promise<void> {
    this.assertSupportedCountry(params.country);

    try {
      const ownedNumber = await this.requireOwnedNumber(params.phoneNumber);
      await this.getClient().incomingPhoneNumbers(ownedNumber.sid).remove();
    } catch (error) {
      throw this.wrapProviderError(error, 'Failed to release Twilio number');
    }
  }

  async getOwnedNumber(
    phoneNumber: string,
  ): Promise<TwilioIncomingPhoneNumber | null> {
    const response = await this.getClient().incomingPhoneNumbers.list({
      phoneNumber,
      origin: 'twilio',
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

  /**
   * Webhook targets every owned number must carry. Messaging lands on this
   * API; voice lands on the call controller.
   */
  getExpectedWebhookAddresses(): TwilioWebhookAddresses {
    if (!this.callControllerPublicUrl) {
      throw new TwilioProviderError(
        'Call controller public URL is not configured; voice webhooks cannot be set',
        503,
      );
    }

    return {
      messagesInbound: `${this.publicUrl}/webhooks/twilio/messages/inbound`,
      messagesStatus: `${this.publicUrl}/webhooks/twilio/messages/status`,
      voice: `${this.callControllerPublicUrl}/webhooks/twilio/voice/inbound`,
      voiceFallback: `${this.callControllerPublicUrl}/webhooks/twilio/voice/fallback`,
    };
  }

  async getReadinessReport(): Promise<TwilioReadinessReport> {
    const report: TwilioReadinessReport = {
      status: 'error',
      timestamp: new Date().toISOString(),
      messagingTransport: 'messages-api',
      issues: [],
      account: {
        sid: this.credentials?.accountSid ?? null,
        configured: this.credentials !== null,
        reachable: null,
      },
      webhooks: null,
      numbers: { checked: 0, misconfigured: [] },
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
      const owned = await this.getClient().incomingPhoneNumbers.list({
        limit: READINESS_NUMBER_LIMIT,
        pageSize: READINESS_NUMBER_LIMIT,
      });
      report.account.reachable = true;
      report.numbers.checked = owned.length;
      report.numbers.misconfigured = owned
        .filter((number) => !webhooksMatch(number, expected))
        .map((number) => normalizePhoneNumber(number.phoneNumber));

      if (report.numbers.misconfigured.length > 0) {
        report.issues.push(
          `${report.numbers.misconfigured.length} owned number(s) have webhooks that do not point at this deployment`,
        );
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
        sms: Boolean(number.capabilities?.sms),
        mms: Boolean(number.capabilities?.mms),
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
      smsEnabled: Boolean(number.capabilities?.sms),
      mmsEnabled: Boolean(number.capabilities?.mms),
      faxEnabled: Boolean(number.capabilities?.fax),
    };
  }

  private async requireOwnedNumber(
    phoneNumber: string,
  ): Promise<TwilioIncomingPhoneNumber & { sid: string }> {
    const ownedNumber = await this.getOwnedNumber(phoneNumber);

    if (!ownedNumber?.sid) {
      throw new TwilioProviderError(
        'Twilio number was not found in the account',
        404,
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

function webhooksMatch(
  number: TwilioIncomingPhoneNumber,
  expected: TwilioWebhookAddresses,
): boolean {
  return (
    normalizeUrl(number.smsUrl) === expected.messagesInbound &&
    normalizeUrl(number.statusCallback) === expected.messagesStatus &&
    normalizeUrl(number.voiceUrl) === expected.voice &&
    normalizeUrl(number.voiceFallbackUrl) === expected.voiceFallback
  );
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

function normalizeUrl(value: string | null | undefined): string | null {
  return (value || '').trim().replace(/\/+$/, '') || null;
}
