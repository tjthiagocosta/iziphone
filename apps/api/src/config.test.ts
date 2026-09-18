import { describe, expect, test } from 'vitest';
import { ApiConfigError, loadApiConfig } from './config.js';

const requiredEnv = {
  DATABASE_URL:
    'postgresql://iziphone:not-a-real-password@db.example.com:5432/iziphone',
  BETTER_AUTH_SECRET: 'a-fictional-secret-that-is-long-enough',
  BETTER_AUTH_URL: 'https://api.example.com/',
  INTERNAL_API_TOKEN: 'a-fictional-internal-token-value',
  STORAGE_REGION: 'us-east-1',
  STORAGE_BUCKET: 'iziphone-media',
  STORAGE_ACCESS_KEY_ID: 'not-a-real-access-key',
  STORAGE_SECRET_ACCESS_KEY: 'not-a-real-secret-key',
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
      trustProxy: false,
      databaseUrl: requiredEnv.DATABASE_URL,
      redisUrl: 'redis://localhost:6379',
      authSecret: requiredEnv.BETTER_AUTH_SECRET,
      internalApiToken: requiredEnv.INTERNAL_API_TOKEN,
      routingCacheTtlSeconds: 86400,
      twilio: null,
      callControllerPublicUrl: null,
      storage: {
        endpoint: null,
        region: 'us-east-1',
        bucket: 'iziphone-media',
        accessKeyId: 'not-a-real-access-key',
        secretAccessKey: 'not-a-real-secret-key',
        forcePathStyle: false,
        keyPrefix: null,
      },
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
      STORAGE_ENDPOINT: 'https://storage.example.com',
      STORAGE_FORCE_PATH_STYLE: 'false',
      STORAGE_KEY_PREFIX: 'iziphone',
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
    expect(config.storage).toEqual({
      endpoint: 'https://storage.example.com',
      region: 'us-east-1',
      bucket: 'iziphone-media',
      accessKeyId: 'not-a-real-access-key',
      secretAccessKey: 'not-a-real-secret-key',
      forcePathStyle: false,
      keyPrefix: 'iziphone',
    });
  });

  test('reads the proxies to trust for the client address', () => {
    const trustProxyOf = (TRUST_PROXY: string) =>
      loadApiConfig({ ...requiredEnv, TRUST_PROXY }).trustProxy;

    expect(trustProxyOf('false')).toBe(false);
    expect(trustProxyOf('True')).toBe(true);
    expect(trustProxyOf('10.0.0.1, 192.168.0.0/16')).toEqual([
      '10.0.0.1',
      '192.168.0.0/16',
    ]);
    // proxy-addr looks its preset names up exactly, so they are stored lower case.
    expect(trustProxyOf('loopback')).toEqual(['loopback']);
    expect(trustProxyOf('Loopback, UniqueLocal')).toEqual([
      'loopback',
      'uniquelocal',
    ]);
    expect(trustProxyOf('2001:db8::1, fc00::/7')).toEqual([
      '2001:db8::1',
      'fc00::/7',
    ]);
  });

  test('trusts nothing about the client address by default', () => {
    expect(loadApiConfig(requiredEnv).trustProxy).toBe(false);
    expect(loadApiConfig({ ...requiredEnv, TRUST_PROXY: '' }).trustProxy).toBe(
      false,
    );
  });

  test('rejects a list of proxies that names none', () => {
    expect(() =>
      loadApiConfig({ ...requiredEnv, TRUST_PROXY: ' , , ' }),
    ).toThrowError(/TRUST_PROXY/);
  });

  // Fastify accepts a hop count and then trusts nothing, because a hop count
  // cannot check the immediate peer. Refusing it beats looking configured.
  test('rejects a hop count', () => {
    expect(() =>
      loadApiConfig({ ...requiredEnv, TRUST_PROXY: '2' }),
    ).toThrowError(/TRUST_PROXY: a hop count is not supported/);
  });

  test.each([
    '10.0.0.1typo',
    '10.0.0.1/33',
    '192.168.0.0/16/8',
    'fc00::/129',
    'nowhere.example.com',
    '10.0.0.1, bogus',
  ])('rejects %s as a proxy to trust', (TRUST_PROXY) => {
    expect(() => loadApiConfig({ ...requiredEnv, TRUST_PROXY })).toThrowError(
      /TRUST_PROXY: not an address/,
    );
  });

  test('defaults to path-style addressing when a storage endpoint is set', () => {
    const config = loadApiConfig({
      ...requiredEnv,
      STORAGE_ENDPOINT: 'http://localhost:9000',
    });

    expect(config.storage.forcePathStyle).toBe(true);
  });

  test('reads the path-style flag as a boolean', () => {
    const withEndpoint = {
      ...requiredEnv,
      STORAGE_ENDPOINT: 'http://localhost:9000',
    };

    expect(
      loadApiConfig({ ...withEndpoint, STORAGE_FORCE_PATH_STYLE: 'false' })
        .storage.forcePathStyle,
    ).toBe(false);
    expect(
      loadApiConfig({ ...requiredEnv, STORAGE_FORCE_PATH_STYLE: 'TRUE' })
        .storage.forcePathStyle,
    ).toBe(true);
    expect(() =>
      loadApiConfig({ ...requiredEnv, STORAGE_FORCE_PATH_STYLE: 'yes' }),
    ).toThrowError(/STORAGE_FORCE_PATH_STYLE: Invalid option/);
  });

  test('rejects a storage endpoint that is not a url', () => {
    expect(() =>
      loadApiConfig({
        ...requiredEnv,
        STORAGE_ENDPOINT: 'storage.example.com',
      }),
    ).toThrowError(/STORAGE_ENDPOINT: Invalid URL/);
  });

  test('lists every missing storage variable at once', () => {
    expect(() =>
      loadApiConfig({
        ...requiredEnv,
        STORAGE_REGION: '',
        STORAGE_BUCKET: undefined,
        STORAGE_ACCESS_KEY_ID: '',
        STORAGE_SECRET_ACCESS_KEY: '',
      }),
    ).toThrowError(
      new ApiConfigError([
        'STORAGE_REGION: Invalid input: expected string, received undefined',
        'STORAGE_BUCKET: Invalid input: expected string, received undefined',
        'STORAGE_ACCESS_KEY_ID: Invalid input: expected string, received undefined',
        'STORAGE_SECRET_ACCESS_KEY: Invalid input: expected string, received undefined',
      ]),
    );
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
        'STORAGE_REGION: Invalid input: expected string, received undefined',
        'STORAGE_BUCKET: Invalid input: expected string, received undefined',
        'STORAGE_ACCESS_KEY_ID: Invalid input: expected string, received undefined',
        'STORAGE_SECRET_ACCESS_KEY: Invalid input: expected string, received undefined',
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
