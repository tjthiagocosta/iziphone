import {
  AddAgentSchema,
  AssignPhoneNumberToDepartmentSchema,
  CreateDepartmentSchema,
  CreateHolidaySchema,
  DepartmentGreetingResponseSchema,
  DepartmentListQuerySchema,
  UpdateAgentOrderSchema,
  UpdateBusinessHoursSchema,
  UpdateDepartmentSchema,
  UpdateDepartmentSettingsSchema,
  UpdateHolidaySchema,
  VOICEMAIL_GREETING_MAX_SIZE_BYTES,
  VOICEMAIL_GREETING_MIME_TYPES,
  VOICEMAIL_GREETING_UNKNOWN_MIME_TYPE,
} from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { AuditLogService } from '../admin/index.js';
import { authenticatedUser } from '../auth/index.js';
import { RoutingCacheService } from '../routing/index.js';
import { DepartmentService } from './department.service.js';
import { DepartmentGreetingService } from './greeting.service.js';

export const adminDepartmentRoutes: FastifyPluginAsync = async (fastify) => {
  /* A greeting arrives as raw audio bytes; Fastify only parses JSON by default. */
  for (const mimeType of [
    ...VOICEMAIL_GREETING_MIME_TYPES,
    VOICEMAIL_GREETING_UNKNOWN_MIME_TYPE,
  ]) {
    if (!fastify.hasContentTypeParser(mimeType)) {
      fastify.addContentTypeParser(
        mimeType,
        { parseAs: 'buffer' },
        (_request, body, done) => done(null, body),
      );
    }
  }

  const auditLog = new AuditLogService(fastify.db);
  const routingCache = new RoutingCacheService(
    fastify.redis,
    fastify.db,
    fastify.config.routingCacheTtlSeconds,
    fastify.config.publicUrl,
    fastify.log,
  );
  const departmentService = new DepartmentService(
    fastify.db,
    fastify.log,
    auditLog,
    routingCache,
    fastify.config.publicUrl,
    fastify.mediaStore,
  );
  const greetingService = new DepartmentGreetingService({
    db: fastify.db,
    mediaStore: fastify.mediaStore,
    publicUrl: fastify.config.publicUrl,
    auditLog,
    routingCache,
    log: fastify.log,
  });

  fastify.get('/', async (request, reply) => {
    const query = DepartmentListQuerySchema.parse(request.query);
    const result = await departmentService.list(query);
    return reply.send(result);
  });

  fastify.get('/deleted', async (request, reply) => {
    const baseQuery = DepartmentListQuerySchema.parse(request.query);
    const result = await departmentService.list({
      ...baseQuery,
      deletedOnly: true,
    });
    return reply.send(result);
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const department = await departmentService.getById(request.params.id);

    if (!department) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Department not found',
      });
    }

    return reply.send(department);
  });

  fastify.post('/', async (request, reply) => {
    const data = CreateDepartmentSchema.parse(request.body);
    const actorId = authenticatedUser(request).id;

    const department = await departmentService.create(
      data,
      actorId,
      request.ip,
    );
    return reply.status(201).send(department);
  });

  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const data = UpdateDepartmentSchema.parse(request.body);
    const actorId = authenticatedUser(request).id;

    const department = await departmentService.update(
      request.params.id,
      data,
      actorId,
      request.ip,
    );

    if (!department) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Department not found',
      });
    }

    return reply.send(department);
  });

  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const actorId = authenticatedUser(request).id;

    const deleted = await departmentService.delete(
      request.params.id,
      actorId,
      request.ip,
    );

    if (!deleted) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Department not found or already deleted',
      });
    }

    return reply.status(204).send();
  });

  fastify.post<{ Params: { id: string } }>(
    '/:id/restore',
    async (request, reply) => {
      const actorId = authenticatedUser(request).id;

      const department = await departmentService.restore(
        request.params.id,
        actorId,
        request.ip,
      );

      if (!department) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department not found or not deleted',
        });
      }

      return reply.send(department);
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/:id/settings',
    async (request, reply) => {
      const data = UpdateDepartmentSettingsSchema.parse(request.body);
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.updateSettings(
        request.params.id,
        data,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department not found',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.put<{ Params: { id: string } }>(
    '/:id/greeting',
    { bodyLimit: VOICEMAIL_GREETING_MAX_SIZE_BYTES },
    async (request, reply) => {
      const voicemailGreetingUrl = await greetingService.upload(
        request.params.id,
        {
          contentType: request.headers['content-type'],
          bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        },
        authenticatedUser(request).id,
        request.ip,
      );

      if (!voicemailGreetingUrl) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department not found',
        });
      }

      return reply.send(
        DepartmentGreetingResponseSchema.parse({ voicemailGreetingUrl }),
      );
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/:id/greeting',
    async (request, reply) => {
      const found = await greetingService.remove(
        request.params.id,
        authenticatedUser(request).id,
        request.ip,
      );

      if (!found) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department not found',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.put<{ Params: { id: string } }>(
    '/:id/business-hours',
    async (request, reply) => {
      const hours = UpdateBusinessHoursSchema.parse(request.body);
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.updateBusinessHours(
        request.params.id,
        hours,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department not found',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/holidays',
    async (request, reply) => {
      const data = CreateHolidaySchema.parse(request.body);
      const actorId = authenticatedUser(request).id;

      const holidayId = await departmentService.addHoliday(
        request.params.id,
        data,
        actorId,
        request.ip,
      );

      if (!holidayId) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department not found',
        });
      }

      return reply.status(201).send({ id: holidayId });
    },
  );

  fastify.patch<{ Params: { id: string; holidayId: string } }>(
    '/:id/holidays/:holidayId',
    async (request, reply) => {
      const data = UpdateHolidaySchema.parse(request.body);
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.updateHoliday(
        request.params.id,
        request.params.holidayId,
        data,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Holiday not found',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { id: string; holidayId: string } }>(
    '/:id/holidays/:holidayId',
    async (request, reply) => {
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.deleteHoliday(
        request.params.id,
        request.params.holidayId,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Holiday not found',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/agents',
    async (request, reply) => {
      const data = AddAgentSchema.parse(request.body);
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.addAgent(
        request.params.id,
        data,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message:
            'Could not add agent. Department/user may not exist or agent is already assigned.',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/:id/agents/order',
    async (request, reply) => {
      const data = UpdateAgentOrderSchema.parse(request.body);
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.updateAgentOrder(
        request.params.id,
        data,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department not found',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/:id/agents/:userId',
    async (request, reply) => {
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.removeAgent(
        request.params.id,
        request.params.userId,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent assignment not found',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/phone-numbers',
    async (request, reply) => {
      const data = AssignPhoneNumberToDepartmentSchema.parse(request.body);
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.assignPhoneNumber(
        request.params.id,
        data.phoneNumberId,
        data.isPrimary,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message:
            'Could not assign phone number. Department may not exist or phone number may be unavailable.',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { id: string; phoneNumberId: string } }>(
    '/:id/phone-numbers/:phoneNumberId',
    async (request, reply) => {
      const actorId = authenticatedUser(request).id;

      const success = await departmentService.removePhoneNumber(
        request.params.id,
        request.params.phoneNumberId,
        actorId,
        request.ip,
      );

      if (!success) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Phone number not found or not assigned to this department',
        });
      }

      return reply.status(204).send();
    },
  );
};
