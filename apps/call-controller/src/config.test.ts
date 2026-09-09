import { describe, expect, test } from 'vitest';
import { ControllerConfigError, loadControllerConfig } from './config.js';

const requiredEnv = {
  BETTER_AUTH_SECRET: 'a-fictional-secret-that-is-long-enough',
  INTERNAL_API_TOKEN: 'a-fictional-internal-token-value',
};

const twilioEnv = {
  WEBHOOK_BASE_URL: 'https://calls.example.com/',
  TWILIO_ACCOUNT_SID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  TWILIO_AUTH_TOKEN: 'not-a-real-twilio-token',
  TWILIO_API_KEY: 'SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  TWILIO_API_SECRET: 'not-a-real-api-secret',
  TWILIO_TWIML_APP_SID: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  TWILIO_PHONE_NUMBER: '+15555550100',
};

describe('loadControllerConfig', () => {
  test('applies defaults and normalizes urls', () => {
    const config = loadControllerConfig(requiredEnv);

    expect(config).toEqual({
      nodeEnv: 'production',
      logLevel: 'info',
      listen: { host: '0.0.0.0', port: 3002 },
      redisUrl: 'redis://localhost:6379',
      authSecret: requiredEnv.BETTER_AUTH_SECRET,
      corsOrigins: ['http://localhost:3000'],
      internalApi: {
        url: 'http://localhost:3001',
        token: requiredEnv.INTERNAL_API_TOKEN,
      },
      twilio: null,
    });
  });

  test('reads every optional value', () => {
    const config = loadControllerConfig({
      ...requiredEnv,
      ...twilioEnv,
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      CALL_CONTROLLER_PORT: '4002',
      CALL_CONTROLLER_HOST: '127.0.0.1',
      REDIS_URL: 'redis://cache.example.com:6379',
      CORS_ORIGIN: 'https://app.example.com, https://admin.example.com',
      INTERNAL_API_URL: 'https://api.internal.example.com/',
      TWILIO_HOLD_AUDIO_URL: 'https://media.example.com/hold.mp3',
    });

    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('debug');
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 4002 });
    expect(config.redisUrl).toBe('redis://cache.example.com:6379');
    expect(config.corsOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    expect(config.internalApi.url).toBe('https://api.internal.example.com');
    expect(config.twilio).toEqual({
      accountSid: twilioEnv.TWILIO_ACCOUNT_SID,
      authToken: twilioEnv.TWILIO_AUTH_TOKEN,
      apiKeySid: twilioEnv.TWILIO_API_KEY,
      apiKeySecret: twilioEnv.TWILIO_API_SECRET,
      twimlAppSid: twilioEnv.TWILIO_TWIML_APP_SID,
      webhookBaseUrl: 'https://calls.example.com',
      defaultFromNumber: '+15555550100',
      holdAudioUrl: 'https://media.example.com/hold.mp3',
    });
  });

  test('falls back to hold music hosted by Twilio', () => {
    const config = loadControllerConfig({ ...requiredEnv, ...twilioEnv });

    expect(config.twilio?.holdAudioUrl).toMatch(/^http:\/\/com\.twilio\.music/);
  });

  test('treats blank values as unset', () => {
    const config = loadControllerConfig({
      ...requiredEnv,
      LOG_LEVEL: '',
      WEBHOOK_BASE_URL: '   ',
      TWILIO_ACCOUNT_SID: '',
    });

    expect(config.logLevel).toBe('info');
    expect(config.twilio).toBeNull();
  });

  test('lists every missing or invalid variable at once', () => {
    expect(() =>
      loadControllerConfig({
        CALL_CONTROLLER_PORT: '70000',
        INTERNAL_API_URL: 'not a url',
      }),
    ).toThrowError(
      new ControllerConfigError([
        'CALL_CONTROLLER_PORT: Too big: expected number to be <=65535',
        'BETTER_AUTH_SECRET: Invalid input: expected string, received undefined',
        'INTERNAL_API_URL: Invalid URL',
        'INTERNAL_API_TOKEN: Invalid input: expected string, received undefined',
      ]),
    );
  });

  test('rejects a weak auth secret', () => {
    expect(() =>
      loadControllerConfig({ ...requiredEnv, BETTER_AUTH_SECRET: 'short' }),
    ).toThrowError(/BETTER_AUTH_SECRET: must be at least 16 characters/);
  });

  test('rejects half-configured Twilio voice settings', () => {
    expect(() =>
      loadControllerConfig({
        ...requiredEnv,
        ...twilioEnv,
        TWILIO_TWIML_APP_SID: '',
        TWILIO_PHONE_NUMBER: '',
      }),
    ).toThrowError(
      /Twilio voice is half-configured; also set TWILIO_TWIML_APP_SID, TWILIO_PHONE_NUMBER/,
    );
  });

  test('rejects a caller id that is not E.164', () => {
    expect(() =>
      loadControllerConfig({
        ...requiredEnv,
        ...twilioEnv,
        TWILIO_PHONE_NUMBER: '555-0100',
      }),
    ).toThrowError(/TWILIO_PHONE_NUMBER/);
  });
});
