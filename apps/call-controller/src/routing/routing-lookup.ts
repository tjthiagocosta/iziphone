import {
  type CachedRouting,
  CachedRoutingSchema,
  ROUTING_CACHE,
} from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';

/*
 * Where an inbound call to a number should go. The API keeps the answer in
 * Redis under `routing:phone:{e164}`; this service reads it and, when the
 * key is gone (cold cache, Redis restart), asks the API directly. The API
 * answer refills the cache, so the fallback is rare and short-lived.
 *
 * The fallback must never take longer than Twilio's webhook timeout, hence
 * the short fetch timeout and a circuit breaker that fails fast while the
 * API is down instead of stalling every call.
 */

const FETCH_TIMEOUT_MS = 3000;
const CIRCUIT_OPEN_AFTER_FAILURES = 5;
const CIRCUIT_RESET_MS = 30_000;

export interface RoutingLookupDependencies {
  redis: Pick<Redis, 'get'>;
  internalApi: { url: string; token: string };
  log: FastifyBaseLogger;
}

export class RoutingLookupService {
  private failures = 0;
  private lastFailureAt = 0;

  constructor(private readonly deps: RoutingLookupDependencies) {}

  /** Routing for a called number, or null when nothing is assigned to it. */
  async lookupByPhone(phoneNumber: string): Promise<CachedRouting | null> {
    const cached = await this.readCache(phoneNumber);
    if (cached) {
      return cached;
    }

    if (this.isCircuitOpen()) {
      this.deps.log.warn(
        { phoneNumberLast4: maskPhoneNumber(phoneNumber) },
        'Routing cache miss while the API circuit breaker is open',
      );
      return null;
    }

    return this.fetchFromApi(phoneNumber);
  }

  private async readCache(phoneNumber: string): Promise<CachedRouting | null> {
    const raw = await this.deps.redis.get(
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${phoneNumber}`,
    );
    if (!raw) {
      return null;
    }

    return this.parseRouting(raw, phoneNumber, 'cache');
  }

  private async fetchFromApi(
    phoneNumber: string,
  ): Promise<CachedRouting | null> {
    const url = `${this.deps.internalApi.url}/internal/routing/by-phone/${encodeURIComponent(phoneNumber)}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.deps.internalApi.token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 404) {
        this.recordSuccess();
        return null;
      }

      if (!response.ok) {
        throw new Error(`API answered ${response.status}`);
      }

      const body = await response.text();
      this.recordSuccess();
      return this.parseRouting(body, phoneNumber, 'api');
    } catch (error) {
      this.recordFailure();
      this.deps.log.error(
        {
          err: error,
          phoneNumberLast4: maskPhoneNumber(phoneNumber),
          failures: this.failures,
        },
        'Routing lookup through the API failed',
      );
      return null;
    }
  }

  /**
   * Both sources are trusted peers, but a schema change on one side must
   * surface as a log line and a miss rather than as a crash mid-call.
   */
  private parseRouting(
    raw: string,
    phoneNumber: string,
    source: 'cache' | 'api',
  ): CachedRouting | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.deps.log.warn(
        { source, phoneNumberLast4: maskPhoneNumber(phoneNumber) },
        'Routing entry is not valid JSON',
      );
      return null;
    }

    const parsed = CachedRoutingSchema.safeParse(json);
    if (!parsed.success) {
      this.deps.log.warn(
        {
          source,
          phoneNumberLast4: maskPhoneNumber(phoneNumber),
          issues: parsed.error.issues,
        },
        'Routing entry does not match the routing schema',
      );
      return null;
    }

    return parsed.data;
  }

  private isCircuitOpen(): boolean {
    if (this.failures < CIRCUIT_OPEN_AFTER_FAILURES) {
      return false;
    }

    if (Date.now() - this.lastFailureAt > CIRCUIT_RESET_MS) {
      this.failures = 0;
      return false;
    }

    return true;
  }

  private recordFailure(): void {
    this.failures += 1;
    this.lastFailureAt = Date.now();
  }

  private recordSuccess(): void {
    this.failures = 0;
  }
}

/** The last four digits, enough to correlate log lines without logging a number. */
export function maskPhoneNumber(phoneNumber: string): string {
  return phoneNumber.slice(-4);
}
