import {
  CallRecordingParamsSchema,
  type RecordingDeletedResponse,
} from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { AuditLogService } from '../admin/index.js';
import { authenticatedUser } from '../auth/index.js';
import { HttpError } from '../infra/index.js';
import { canListenToRecording, loadCallScope } from './call-scope.js';
import { CallRecordingService } from './recording.service.js';

/**
 * The audio of a call's recordings, and their deletion.
 *
 * Playback is for anyone who may see the call (see call-scope), with the
 * recording of the conversation itself reserved for the roles that hold
 * `recordings:listen`. Deleting is an admin's: it cannot be undone, and it
 * removes evidence of a call from the only place that still has it.
 */
export const recordingRoutes: FastifyPluginAsync = async (fastify) => {
  const recordings = new CallRecordingService(
    fastify.db,
    fastify.mediaStore,
    fastify.config.twilio,
    fastify.log,
  );
  const auditLog = new AuditLogService(fastify.db);

  fastify.get(
    '/api/calls/:conversationUuid/recordings/:recordingId',
    {
      preHandler: [fastify.requireAuth],
      // A HEAD would read the whole recording to answer nothing.
      exposeHeadRoute: false,
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const { conversationUuid, recordingId } = CallRecordingParamsSchema.parse(
        request.params,
      );

      const recording = await recordings.findInScope(
        await loadCallScope(fastify.db, user),
        conversationUuid,
        recordingId,
      );

      if (!canListenToRecording(user.role, recording.context)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Call recordings are for supervisors and admins',
        });
      }

      const media = await recordings.open(recording, conversationUuid);

      reply.header('content-type', media.contentType);
      if (media.contentLength !== null) {
        reply.header('content-length', media.contentLength);
      }

      return (
        reply
          // Who may hear it can change, so every play is authorized afresh.
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .send(media.body)
      );
    },
  );

  fastify.delete(
    '/api/calls/:conversationUuid/recordings/:recordingId',
    { preHandler: [fastify.requireRole(['ADMIN'])] },
    async (request) => {
      const actor = authenticatedUser(request);
      const { conversationUuid, recordingId } = CallRecordingParamsSchema.parse(
        request.params,
      );

      const recording = await recordings.findInScope(
        await loadCallScope(fastify.db, actor),
        conversationUuid,
        recordingId,
      );

      const deletion = await recordings.deleteAudio(
        recording,
        conversationUuid,
        'MANUAL',
      );

      if (deletion.outcome === 'failed') {
        throw new HttpError('The recording could not be deleted', 502);
      }

      // Written after the fact: the audio is already gone, and an entry that
      // could not be written must not read as a deletion that did not happen.
      if (deletion.outcome === 'deleted') {
        await auditLog.create({
          action: 'recording.deleted',
          entityType: 'CallRecording',
          entityId: recording.id,
          userId: actor.id,
          changes: { context: recording.context, reason: 'MANUAL' },
          metadata: { conversationUuid, recordingSid: recording.recordingSid },
          ipAddress: request.ip,
        });
      }

      if (deletion.deletion === null) {
        // The row itself is gone, so there is nothing to report as deleted.
        throw new HttpError('Recording not found', 404);
      }

      const response: RecordingDeletedResponse = {
        id: recording.id,
        deletion: deletion.deletion,
      };

      return response;
    },
  );
};
