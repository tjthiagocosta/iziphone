import { UpdateRecordingRetentionSchema } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { AuditLogService } from './audit-log.js';
import { SystemSettingsService } from './system-settings.service.js';

/**
 * The deployment's settings, under `/api/admin/settings`. Recording retention
 * is the only group so far; each group is written whole, so a console that
 * shows one form saves one decision.
 */
export const adminSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  const settings = new SystemSettingsService(
    fastify.db,
    new AuditLogService(fastify.db),
  );

  fastify.get('/', async (_request, reply) => {
    return reply.send(await settings.read());
  });

  fastify.put('/recording-retention', async (request, reply) => {
    const data = UpdateRecordingRetentionSchema.parse(request.body);
    const actor = authenticatedUser(request);

    return reply.send(
      await settings.updateRecordingRetention(data, actor.id, request.ip),
    );
  });
};
