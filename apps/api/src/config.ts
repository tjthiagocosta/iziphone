import { resolveRoutingCacheTtl } from '@repo/events';
import { z } from 'zod';
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
  INTERNAL_API_TOKEN: z
    .string()
    .min(16, 'must be at least 16 characters (openssl rand -base64 32)'),
  DEPARTMENT_CACHE_TTL_SECONDS: z.string().optional(),
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

  return {
    nodeEnv: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    listen: { host: values.API_HOST, port: values.API_PORT },
    publicUrl: stripTrailingSlash(values.BETTER_AUTH_URL),
    corsOrigins: values.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
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
