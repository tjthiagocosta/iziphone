import formbody from '@fastify/formbody';
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyPluginOptions,
  type FastifyRegisterOptions,
} from 'fastify';
import type { Redis } from 'ioredis';
import { type ControllerConfig, loadControllerConfig } from '../config.js';

/** A complete, fictional configuration for route tests. */
export const testControllerConfig: ControllerConfig = loadControllerConfig({
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'a-fictional-secret-that-is-long-enough',
  INTERNAL_API_TOKEN: 'a-fictional-internal-token-value',
  WEBHOOK_BASE_URL: 'https://calls.example.com',
  TWILIO_ACCOUNT_SID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  TWILIO_AUTH_TOKEN: 'not-a-real-twilio-token',
  TWILIO_API_KEY: 'SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  TWILIO_API_SECRET: 'not-a-real-api-secret',
  TWILIO_TWIML_APP_SID: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
});

interface CreateControllerRouteAppOptions<Options> {
  config?: Partial<ControllerConfig>;
  redis?: Partial<Redis>;
  registerOptions?: Options;
}

/**
 * A Fastify app with the decorators route plugins expect and nothing else:
 * no Redis, no Twilio, no sockets. Twilio posts forms, so formbody is on.
 */
export async function createControllerRouteApp<
  Options extends FastifyPluginOptions,
>(
  plugin: FastifyPluginAsync<Options>,
  options: CreateControllerRouteAppOptions<Options> = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate('config', { ...testControllerConfig, ...options.config });
  app.decorate('redis', (options.redis ?? {}) as Redis);
  await app.register(formbody);

  await app.register(
    plugin,
    options.registerOptions as FastifyRegisterOptions<Options>,
  );
  await app.ready();

  return app;
}
