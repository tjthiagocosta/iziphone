import {
  PhoneNumberListQuerySchema,
  PurchasePhoneNumberSchema,
  SearchAvailableNumbersSchema,
  UpdatePhoneNumberSchema,
} from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { AuditLogService } from '../admin/index.js';
import { authenticatedUser } from '../auth/index.js';
import { RoutingCacheService } from '../routing/index.js';
import { PhoneNumberService } from './phone-number.service.js';
import { TwilioNumberManagementService } from './twilio-numbers.js';

export const adminPhoneNumberRoutes: FastifyPluginAsync = async (fastify) => {
  const phoneNumberService = new PhoneNumberService(
    fastify.db,
    fastify.log,
    new AuditLogService(fastify.db),
    new RoutingCacheService(
      fastify.redis,
      fastify.db,
      fastify.config.routingCacheTtlSeconds,
      fastify.config.publicUrl,
      fastify.log,
    ),
    new TwilioNumberManagementService({
      credentials: fastify.config.twilio,
      publicUrl: fastify.config.publicUrl,
      callControllerPublicUrl: fastify.config.callControllerPublicUrl,
      log: fastify.log,
    }),
  );

  fastify.get('/', async (request, reply) => {
    const query = PhoneNumberListQuerySchema.parse(request.query);
    return reply.send(await phoneNumberService.list(query));
  });

  fastify.get('/available', async (request, reply) => {
    const query = SearchAvailableNumbersSchema.parse(request.query);

    return reply.send(await phoneNumberService.searchAvailable(query));
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const phoneNumber = await phoneNumberService.getById(request.params.id);

    if (!phoneNumber) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Phone number not found',
      });
    }

    return reply.send(phoneNumber);
  });

  fastify.post('/purchase', async (request, reply) => {
    const data = PurchasePhoneNumberSchema.parse(request.body);
    const actor = authenticatedUser(request);

    const phoneNumber = await phoneNumberService.purchase(
      data,
      actor.id,
      request.ip,
    );
    return reply.status(201).send(phoneNumber);
  });

  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const data = UpdatePhoneNumberSchema.parse(request.body);
    const actor = authenticatedUser(request);

    const phoneNumber = await phoneNumberService.update(
      request.params.id,
      data,
      actor.id,
      request.ip,
    );

    if (!phoneNumber) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Phone number not found',
      });
    }

    return reply.send(phoneNumber);
  });

  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const actor = authenticatedUser(request);

    const released = await phoneNumberService.release(
      request.params.id,
      actor.id,
      request.ip,
    );

    if (!released) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Phone number not found',
      });
    }

    return reply.status(204).send();
  });
};
