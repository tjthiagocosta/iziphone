import { isIP } from 'node:net';
import { resolveRoutingCacheTtl } from '@repo/events';
import { z } from 'zod';
import type { MailConfig } from './mail/index.js';
import type { MediaStoreConfig } from './media-store/index.js';

/*
 * Every environment variable the API reads is declared here and validated
 * once, before anything connects. The rest of the app receives an ApiConfig
 * and never touches process.env.
 */

const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: LogLevelSchema.default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  BETTER_AUTH_SECRET: z
    .string()
    .min(16, 'must be at least 16 characters (openssl rand -base64 32)'),
  BETTER_AUTH_URL: z.url(),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  TRUST_PROXY: z.string().optional(),
  INTERNAL_API_TOKEN: z
    .string()
    .min(16, 'must be at least 16 characters (openssl rand -base64 32)'),
  DEPARTMENT_CACHE_TTL_SECONDS: z.string().optional(),
  SMTP_URL: z
    .url()
    .refine(
      (value) => value.startsWith('smtp://') || value.startsWith('smtps://'),
      'must be an smtp:// or smtps:// URL',
    )
    .optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  WEBHOOK_BASE_URL: z.url().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: z
    .stringbool({ truthy: ['true'], falsy: ['false'] })
    .optional(),
  STORAGE_KEY_PREFIX: z.string().optional(),
});

export type NodeEnv = z.infer<typeof EnvSchema>['NODE_ENV'];
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/**
 * What Fastify may believe about `X-Forwarded-For` when it derives
 * `request.ip`: nothing (`false`), everything (`true`), or the addresses and
 * CIDR ranges of the proxies themselves (`@fastify/proxy-addr` also accepts
 * the names `loopback`, `linklocal` and `uniquelocal`).
 *
 * Fastify also takes a hop count, but a hop count cannot check who the
 * immediate peer is, so Fastify fails it closed and trusts nothing. It is not
 * offered here: it would look configured and do nothing.
 */
export type TrustProxySetting = boolean | string[];

export interface ApiConfig {
  nodeEnv: NodeEnv;
  logLevel: LogLevel;
  listen: { host: string; port: number };
  /**
   * Public base URL of this API, without a trailing slash. Better Auth
   * callbacks, Twilio messaging webhooks and media links are built on it.
   */
  publicUrl: string;
  corsOrigins: string[];
  /**
   * Whom to believe about the client's address. The rate limiter buckets by
   * `request.ip`, so this decides whether every client behind the proxy shares
   * one bucket (too strict) or can forge a new one per request (no limit).
   */
  trustProxy: TrustProxySetting;
  /**
   * Public base URL of the web app, without a trailing slash. It is the first
   * `CORS_ORIGIN` entry, which is the browser origin this API is there to
   * serve; invite and reset links are built on it. A second entry is another
   * origin allowed to call the API, not another home page.
   */
  webUrl: string;
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  /** Shared secret the call controller presents on `/internal` routes. */
  internalApiToken: string;
  routingCacheTtlSeconds: number;
  /** Null when the deployment has no Twilio credentials yet. */
  twilio: TwilioCredentials | null;
  /** Public base URL of the call controller; Twilio voice webhooks point at it. */
  callControllerPublicUrl: string | null;
  /**
   * Null when no SMTP server is configured. The API still issues invite and
   * reset links then; the admin console shows them to be passed on by hand.
   */
  mail: MailConfig | null;
  /** The S3-compatible bucket that holds media; only the API talks to it. */
  storage: MediaStoreConfig;
}

export class ApiConfigError extends Error {
  constructor(problems: string[]) {
    super(
      `Invalid API configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`,
    );
    this.name = 'ApiConfigError';
  }
}

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = EnvSchema.safeParse(withoutBlankValues(env));

  if (!parsed.success) {
    throw new ApiConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }

  const values = parsed.data;
  const twilio = resolveTwilio(values);
  const corsOrigins = values.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    nodeEnv: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    listen: { host: values.API_HOST, port: values.API_PORT },
    publicUrl: stripTrailingSlash(values.BETTER_AUTH_URL),
    corsOrigins,
    trustProxy: resolveTrustProxy(values.TRUST_PROXY),
    webUrl: resolveWebUrl(corsOrigins),
    databaseUrl: values.DATABASE_URL,
    redisUrl: values.REDIS_URL,
    authSecret: values.BETTER_AUTH_SECRET,
    internalApiToken: values.INTERNAL_API_TOKEN,
    routingCacheTtlSeconds: resolveRoutingCacheTtl(
      values.DEPARTMENT_CACHE_TTL_SECONDS,
    ),
    twilio,
    callControllerPublicUrl: values.WEBHOOK_BASE_URL
      ? stripTrailingSlash(values.WEBHOOK_BASE_URL)
      : null,
    mail: resolveMail(values),
    storage: {
      endpoint: values.STORAGE_ENDPOINT ?? null,
      region: values.STORAGE_REGION,
      bucket: values.STORAGE_BUCKET,
      accessKeyId: values.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: values.STORAGE_SECRET_ACCESS_KEY,
      // MinIO and several providers only answer path-style requests on a custom endpoint.
      forcePathStyle:
        values.STORAGE_FORCE_PATH_STYLE ??
        values.STORAGE_ENDPOINT !== undefined,
      keyPrefix: values.STORAGE_KEY_PREFIX ?? null,
    },
  };
}

/**
 * Unset means trust nothing, which is right for a directly exposed service:
 * an unrecognised value stops the boot rather than leaving the address a
 * client claims to be the one the limiter and the audit log record.
 */
function resolveTrustProxy(raw: string | undefined): TrustProxySetting {
  if (raw === undefined || raw.toLowerCase() === 'false') {
    return false;
  }

  if (raw.toLowerCase() === 'true') {
    return true;
  }

  const proxies = raw
    .split(',')
    .map((proxy) => proxy.trim())
    .filter((proxy) => proxy.length > 0);

  if (proxies.length === 0) {
    throw new ApiConfigError([
      'TRUST_PROXY: names no proxy; use true, false, or a comma-separated list of proxy addresses or CIDR ranges',
    ]);
  }

  if (proxies.some((proxy) => /^\d+$/.test(proxy))) {
    throw new ApiConfigError([
      'TRUST_PROXY: a hop count is not supported, because Fastify accepts one and then trusts nothing; name the proxies instead',
    ]);
  }

  const trusted: string[] = [];
  const unrecognized: string[] = [];

  for (const proxy of proxies) {
    const normalized = normalizeProxyAddress(proxy);

    if (normalized === null) {
      unrecognized.push(proxy);
    } else {
      trusted.push(normalized);
    }
  }

  if (unrecognized.length > 0) {
    throw new ApiConfigError([
      `TRUST_PROXY: not an address, a CIDR range, or one of ${[...PROXY_ADDRESS_PRESETS].join(', ')}: ${unrecognized.join(', ')}`,
    ]);
  }

  return trusted;
}

/** The named ranges `@fastify/proxy-addr` understands besides addresses. */
const PROXY_ADDRESS_PRESETS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * The value `@fastify/proxy-addr` will accept for this entry, or null when it
 * would refuse it. Checked here so a typo is an ApiConfigError at startup
 * rather than the raw TypeError proxy-addr throws when Fastify compiles the
 * list. A preset name is matched whatever its case and stored in lower case,
 * because proxy-addr looks the presets up exactly.
 */
function normalizeProxyAddress(value: string): string | null {
  const preset = value.toLowerCase();

  if (PROXY_ADDRESS_PRESETS.has(preset)) {
    return preset;
  }

  const [address, prefixLength, ...extra] = value.split('/');

  if (address === undefined || extra.length > 0) {
    return null;
  }

  const version = isIP(address);

  if (version === 0) {
    return null;
  }

  if (prefixLength === undefined) {
    return value;
  }

  const withinRange =
    /^\d+$/.test(prefixLength) &&
    Number(prefixLength) <= (version === 4 ? 32 : 128);

  return withinRange ? value : null;
}

function resolveTwilio(values: {
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
}): TwilioCredentials | null {
  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken } =
    values;

  if (!accountSid && !authToken) {
    return null;
  }

  if (!accountSid || !authToken) {
    throw new ApiConfigError([
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set together',
    ]);
  }

  return { accountSid, authToken };
}

function resolveMail(values: {
  SMTP_URL?: string | undefined;
  EMAIL_FROM?: string | undefined;
}): MailConfig | null {
  const { SMTP_URL: smtpUrl, EMAIL_FROM: from } = values;

  if (!smtpUrl && !from) {
    return null;
  }

  if (!smtpUrl || !from) {
    throw new ApiConfigError(['SMTP_URL and EMAIL_FROM must be set together']);
  }

  return { smtpUrl, from };
}

/**
 * Where the browser reaches the web app. There is no separate setting for it:
 * the origin the API answers a browser from is the origin its links point at,
 * so the two cannot drift apart.
 */
function resolveWebUrl(corsOrigins: readonly string[]): string {
  const first = corsOrigins[0];

  if (!first || !z.url().safeParse(first).success) {
    throw new ApiConfigError([
      'CORS_ORIGIN: the first entry must be the web app URL, e.g. https://app.example.com',
    ]);
  }

  return stripTrailingSlash(first);
}

/** `.env` files leave placeholders like `TWILIO_HOLD_AUDIO_URL=`; treat them as unset. */
function withoutBlankValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const present: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed) {
      present[key] = trimmed;
    }
  }

  return present;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
