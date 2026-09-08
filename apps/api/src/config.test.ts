import { describe, expect, test } from 'vitest';
import { ApiConfigError, loadApiConfig } from './config.js';

const requiredEnv = {
  DATABASE_URL:
    'postgresql://iziphone:not-a-real-password@db.example.com:5432/iziphone',
  BETTER_AUTH_SECRET: 'a-fictional-secret-that-is-long-enough',
  BETTER_AUTH_URL: 'https://api.example.com/',
  INTERNAL_API_TOKEN: 'a-fictional-internal-token-value',
};

describe('loadApiConfig', () => {
  test('applies defaults and normalizes urls', () => {
    const config = loadApiConfig(requiredEnv);

    expect(config).toEqual({
      nodeEnv: 'production',
      logLevel: 'info',
      listen: { host: '0.0.0.0', port: 3001 },
      publicUrl: 'https://api.example.com',
      corsOrigins: ['http://localhost:3000'],
      databaseUrl: requiredEnv.DATABASE_URL,
      redisUrl: 'redis://localhost:6379',
      authSecret: requiredEnv.BETTER_AUTH_SECRET,
      internalApiToken: requiredEnv.INTERNAL_API_TOKEN,
      routingCacheTtlSeconds: 86400,
      twilio: null,
      callControllerPublicUrl: null,
      messagingMediaStorageDir: '.data/messaging-media',
    });
  });

  test('reads every optional value', () => {
    const config = loadApiConfig({
      ...requiredEnv,
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      API_PORT: '4001',
      API_HOST: '127.0.0.1',
      REDIS_URL: 'redis://cache.example.com:6379',
      CORS_ORIGIN: 'https://app.example.com, https://admin.example.com',
      DEPARTMENT_CACHE_TTL_SECONDS: '600',
      WEBHOOK_BASE_URL: 'https://calls.example.com/',
      TWILIO_ACCOUNT_SID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      TWILIO_AUTH_TOKEN: 'not-a-real-token',
      MESSAGING_MEDIA_STORAGE_DIR: '/var/lib/iziphone/media',
    });

    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('debug');
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 4001 });
    expect(config.redisUrl).toBe('redis://cache.example.com:6379');
    expect(config.corsOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    expect(config.routingCacheTtlSeconds).toBe(600);
    expect(config.callControllerPublicUrl).toBe('https://calls.example.com');
    expect(config.twilio).toEqual({
      accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      authToken: 'not-a-real-token',
    });
    expect(config.messagingMediaStorageDir).toBe('/var/lib/iziphone/media');
  });

  test('treats blank values as unset', () => {
    const config = loadApiConfig({
      ...requiredEnv,
      WEBHOOK_BASE_URL: '   ',
      TWILIO_ACCOUNT_SID: '',
      LOG_LEVEL: '',
    });

    expect(config.callControllerPublicUrl).toBeNull();
    expect(config.twilio).toBeNull();
    expect(config.logLevel).toBe('info');
  });

  test('lists every missing or invalid variable at once', () => {
    expect(() =>
      loadApiConfig({ BETTER_AUTH_URL: 'not a url', API_PORT: '70000' }),
    ).toThrowError(
      new ApiConfigError([
        'API_PORT: Too big: expected number to be <=65535',
        'DATABASE_URL: Invalid input: expected string, received undefined',
        'BETTER_AUTH_SECRET: Invalid input: expected string, received undefined',
        'BETTER_AUTH_URL: Invalid URL',
        'INTERNAL_API_TOKEN: Invalid input: expected string, received undefined',
      ]),
    );
  });

  test('rejects a weak auth secret', () => {
    expect(() =>
      loadApiConfig({ ...requiredEnv, BETTER_AUTH_SECRET: 'short' }),
    ).toThrowError(/BETTER_AUTH_SECRET: must be at least 16 characters/);
  });

  test('rejects half-configured Twilio credentials', () => {
    expect(() =>
      loadApiConfig({ ...requiredEnv, TWILIO_ACCOUNT_SID: 'ACaaaa' }),
    ).toThrowError(
      /TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set together/,
    );
  });

  test('rejects an unusable routing cache ttl', () => {
    expect(() =>
      loadApiConfig({ ...requiredEnv, DEPARTMENT_CACHE_TTL_SECONDS: '0' }),
    ).toThrowError(/DEPARTMENT_CACHE_TTL_SECONDS/);
  });
});
