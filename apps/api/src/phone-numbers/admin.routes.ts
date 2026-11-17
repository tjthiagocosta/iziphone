import {
  ImportPhoneNumberSchema,
  PhoneNumberListQuerySchema,
  PurchasePhoneNumberSchema,
  SearchAvailableNumbersSchema,
  SetMessagingServiceSchema,
  UpdateDefaultMessagingServiceSchema,
  UpdatePhoneNumberSchema,
} from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { AuditLogService, SystemSettingsService } from '../admin/index.js';
import { authenticatedUser } from '../auth/index.js';
import { RoutingCacheService } from '../routing/index.js';
import { PhoneNumberService } from './phone-number.service.js';
import { TwilioNumberManagementService } from './twilio-numbers.js';

export const adminPhoneNumberRoutes: FastifyPluginAsync = async (fastify) => {
  const auditLog = new AuditLogService(fastify.db);
  const phoneNumberService = new PhoneNumberService(
    fastify.db,
    fastify.log,
    auditLog,
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
    new SystemSettingsService(fastify.db, auditLog),
  );

  fastify.get('/', async (request, reply) => {
    const query = PhoneNumberListQuerySchema.parse(request.query);
    return reply.send(await phoneNumberService.list(query));
  });

  fastify.get('/available', async (request, reply) => {
    const query = SearchAvailableNumbersSchema.parse(request.query);

    return reply.send(await phoneNumberService.searchAvailable(query));
  });

  // A static path wins over `/:id` in Fastify's router, whatever the order.
  fastify.get('/owned', async (_request, reply) => {
    return reply.send(await phoneNumberService.listOwned());
  });

  fastify.get('/messaging-services', async (_request, reply) => {
    return reply.send(await phoneNumberService.messagingServices());
  });

  fastify.put('/messaging-services/default', async (request, reply) => {
    const { messagingServiceSid } = UpdateDefaultMessagingServiceSchema.parse(
      request.body,
    );
    const actor = authenticatedUser(request);

    return reply.send(
      await phoneNumberService.setDefaultMessagingService(
        messagingServiceSid,
        actor.id,
        request.ip,
      ),
    );
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

  fastify.post('/import', async (request, reply) => {
    const data = ImportPhoneNumberSchema.parse(request.body);
    const actor = authenticatedUser(request);

    const phoneNumber = await phoneNumberService.importOwned(
      data,
      actor.id,
      request.ip,
    );
    return reply.status(201).send(phoneNumber);
  });

  fastify.get<{ Params: { id: string } }>(
    '/:id/connection',
    async (request, reply) => {
      const connection = await phoneNumberService.connection(request.params.id);

      if (!connection) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Phone number not found',
        });
      }

      return reply.send(connection);
    },
  );

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

  fastify.post<{ Params: { id: string } }>(
    '/:id/reconnect',
    async (request, reply) => {
      const actor = authenticatedUser(request);

      const phoneNumber = await phoneNumberService.reconnect(
        request.params.id,
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
    },
  );

  fastify.put<{ Params: { id: string } }>(
    '/:id/messaging-service',
    async (request, reply) => {
      const data = SetMessagingServiceSchema.parse(request.body);
      const actor = authenticatedUser(request);

      const change = await phoneNumberService.setMessagingService(
        request.params.id,
        data,
        actor.id,
        request.ip,
      );

      if (!change) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Phone number not found',
        });
      }

      return reply.send(change);
    },
  );

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

    return reply.send(released);
  });
};
