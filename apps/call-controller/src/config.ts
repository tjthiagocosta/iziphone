import { E164PhoneNumberSchema } from '@repo/dto';
import { z } from 'zod';

/*
 * Every environment variable the call controller reads is declared here and
 * validated once, before anything connects. The rest of the service receives
 * a ControllerConfig and never touches process.env.
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

const SECRET_HINT = 'must be at least 16 characters (openssl rand -base64 32)';

const DEFAULT_HOLD_AUDIO_URL =
  'http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: LogLevelSchema.default('info'),
  CALL_CONTROLLER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  CALL_CONTROLLER_HOST: z.string().default('0.0.0.0'),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  BETTER_AUTH_SECRET: z.string().min(16, SECRET_HINT),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  INTERNAL_API_URL: z.url().default('http://localhost:3001'),
  INTERNAL_API_TOKEN: z.string().min(16, SECRET_HINT),
  WEBHOOK_BASE_URL: z.url().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY: z.string().optional(),
  TWILIO_API_SECRET: z.string().optional(),
  TWILIO_TWIML_APP_SID: z.string().optional(),
  TWILIO_PHONE_NUMBER: E164PhoneNumberSchema.optional(),
  TWILIO_HOLD_AUDIO_URL: z.url().optional(),
});

type EnvValues = z.infer<typeof EnvSchema>;

/** Voice needs all of these; a partial set is a deployment mistake, not a feature flag. */
const TWILIO_VOICE_KEYS = [
  'WEBHOOK_BASE_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_PHONE_NUMBER',
] as const;

export type NodeEnv = EnvValues['NODE_ENV'];
export type LogLevel = z.infer<typeof LogLevelSchema>;

export interface TwilioVoiceConfig {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  /**
   * Public HTTPS base URL of this service, without a trailing slash. Every
   * webhook URL handed to Twilio is built on it, and signatures are checked
   * against it.
   */
  webhookBaseUrl: string;
  /** E.164 caller id used when a call has no number of its own. */
  defaultFromNumber: string;
  /** Played to a participant who is on hold or waiting for the other side. */
  holdAudioUrl: string;
}

export interface ControllerConfig {
  nodeEnv: NodeEnv;
  logLevel: LogLevel;
  listen: { host: string; port: number };
  redisUrl: string;
  /** Shared with the API, which signs the realtime JWT this service verifies. */
  authSecret: string;
  corsOrigins: string[];
  /** Where the API's `/internal` routes are and the bearer token they expect. */
  internalApi: { url: string; token: string };
  /** Null until the deployment has Twilio credentials; voice then reports itself unconfigured. */
  twilio: TwilioVoiceConfig | null;
}

export class ControllerConfigError extends Error {
  constructor(problems: string[]) {
    super(
      `Invalid call controller configuration:\n${problems
        .map((problem) => `  ${problem}`)
        .join('\n')}`,
    );
    this.name = 'ControllerConfigError';
  }
}

export function loadControllerConfig(env: NodeJS.ProcessEnv): ControllerConfig {
  const parsed = EnvSchema.safeParse(withoutBlankValues(env));

  if (!parsed.success) {
    throw new ControllerConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }

  const values = parsed.data;

  return {
    nodeEnv: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    listen: {
      host: values.CALL_CONTROLLER_HOST,
      port: values.CALL_CONTROLLER_PORT,
    },
    redisUrl: values.REDIS_URL,
    authSecret: values.BETTER_AUTH_SECRET,
    corsOrigins: values.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    internalApi: {
      url: stripTrailingSlash(values.INTERNAL_API_URL),
      token: values.INTERNAL_API_TOKEN,
    },
    twilio: resolveTwilio(values),
  };
}

function resolveTwilio(values: EnvValues): TwilioVoiceConfig | null {
  const missing = TWILIO_VOICE_KEYS.filter((key) => values[key] === undefined);

  if (missing.length === TWILIO_VOICE_KEYS.length) {
    return null;
  }

  const {
    WEBHOOK_BASE_URL: webhookBaseUrl,
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_API_KEY: apiKeySid,
    TWILIO_API_SECRET: apiKeySecret,
    TWILIO_TWIML_APP_SID: twimlAppSid,
    TWILIO_PHONE_NUMBER: defaultFromNumber,
  } = values;

  if (
    !webhookBaseUrl ||
    !accountSid ||
    !authToken ||
    !apiKeySid ||
    !apiKeySecret ||
    !twimlAppSid ||
    !defaultFromNumber
  ) {
    throw new ControllerConfigError([
      `Twilio voice is half-configured; also set ${missing.join(', ')}`,
    ]);
  }

  return {
    accountSid,
    authToken,
    apiKeySid,
    apiKeySecret,
    twimlAppSid,
    webhookBaseUrl: stripTrailingSlash(webhookBaseUrl),
    defaultFromNumber,
    holdAudioUrl: values.TWILIO_HOLD_AUDIO_URL ?? DEFAULT_HOLD_AUDIO_URL,
  };
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
