import {
  AssignDepartmentSchema,
  AssignPhoneNumberSchema,
  CreateUserSchema,
  UpdateUserSchema,
  UserListQuerySchema,
} from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { AuditLogService } from '../admin/index.js';
import { authenticatedUser } from '../auth/index.js';
import { RoutingCacheService } from '../routing/index.js';
import { UserService } from './user.service.js';

export const adminUserRoutes: FastifyPluginAsync = async (fastify) => {
  const userService = new UserService(
    fastify.db,
    fastify.log,
    new AuditLogService(fastify.db),
    new RoutingCacheService(
      fastify.redis,
      fastify.db,
      fastify.config.routingCacheTtlSeconds,
      fastify.log,
    ),
  );

  fastify.get('/', async (request, reply) => {
    const query = UserListQuerySchema.parse(request.query);
    return reply.send(await userService.list(query));
  });

  fastify.get('/deleted', async (request, reply) => {
    const query = UserListQuerySchema.parse(request.query);
    return reply.send(await userService.list({ ...query, deletedOnly: true }));
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const user = await userService.getById(request.params.id);

    if (!user) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'User not found',
      });
    }

    return reply.send(user);
  });

  fastify.post('/', async (request, reply) => {
    const data = CreateUserSchema.parse(request.body);
    const actor = authenticatedUser(request);

    const user = await userService.create(data, actor.id, request.ip);
    return reply.status(201).send(user);
  });

  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const data = UpdateUserSchema.parse(request.body);
    const actor = authenticatedUser(request);

    const user = await userService.update(
      request.params.id,
      data,
      actor.id,
      request.ip,
    );

    if (!user) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'User not found',
      });
    }

    return reply.send(user);
  });

  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const actor = authenticatedUser(request);

    if (request.params.id === actor.id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Cannot delete your own account',
      });
    }

    const deleted = await userService.delete(
      request.params.id,
      actor.id,
      request.ip,
    );

    if (!deleted) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'User not found or already deleted',
      });
    }

    return reply.status(204).send();
  });

  fastify.post<{ Params: { id: string } }>(
    '/:id/restore',
    async (request, reply) => {
      const actor = authenticatedUser(request);
      const user = await userService.restore(
        request.params.id,
        actor.id,
        request.ip,
      );

      if (!user) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'User not found or not deleted',
        });
      }

      return reply.send(user);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/phone-numbers',
    async (request, reply) => {
      const data = AssignPhoneNumberSchema.parse(request.body);
      const actor = authenticatedUser(request);
      const assigned = await userService.assignPhoneNumber(
        request.params.id,
        data.phoneNumberId,
        actor.id,
        request.ip,
      );

      if (!assigned) {
        return reply.status(400).send({
          error: 'Bad Request',
          message:
            'Could not assign phone number. User may not exist or phone number may be unavailable.',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { id: string; phoneNumberId: string } }>(
    '/:id/phone-numbers/:phoneNumberId',
    async (request, reply) => {
      const actor = authenticatedUser(request);
      const removed = await userService.removePhoneNumber(
        request.params.id,
        request.params.phoneNumberId,
        actor.id,
        request.ip,
      );

      if (!removed) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Phone number not found or not assigned to this user',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/departments',
    async (request, reply) => {
      const data = AssignDepartmentSchema.parse(request.body);
      const actor = authenticatedUser(request);
      const assigned = await userService.assignDepartment(
        request.params.id,
        data.departmentId,
        data.order,
        actor.id,
        request.ip,
      );

      if (!assigned) {
        return reply.status(400).send({
          error: 'Bad Request',
          message:
            'Could not assign department. User/department may not exist or user is already assigned.',
        });
      }

      return reply.status(204).send();
    },
  );

  fastify.delete<{ Params: { id: string; departmentId: string } }>(
    '/:id/departments/:departmentId',
    async (request, reply) => {
      const actor = authenticatedUser(request);
      const removed = await userService.removeDepartment(
        request.params.id,
        request.params.departmentId,
        actor.id,
        request.ip,
      );

      if (!removed) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Department assignment not found',
        });
      }

      return reply.status(204).send();
    },
  );
};
