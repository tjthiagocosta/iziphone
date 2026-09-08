import { z } from 'zod';
import {
  CallEndStatusSchema,
  RoutingTargetTypeSchema,
} from '../common/domain.js';
import { EntityIdSchema, IsoDateTimeSchema } from '../common/primitives.js';

/*
 * Payloads exchanged over Socket.IO between the call controller and the
 * browser. Redis pub/sub contracts between services live in @repo/events.
 */

// Server → client

export const IncomingCallSchema = z.object({
  conversationUuid: z.string(),
  from: z.string(),
  to: z.string(),
  callerId: z.string().optional(),
  routingType: RoutingTargetTypeSchema.optional(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CallEndedSchema = z.object({
  conversationUuid: z.string(),
  status: CallEndStatusSchema,
  /** Seconds, when the call was answered. */
  duration: z.number().int().nonnegative().optional(),
  endedAt: IsoDateTimeSchema,
});

export const AuthRefreshedSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const SocketErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

// Client → server

/**
 * Sent once after connecting. The user is taken from the authenticated
 * socket, never from the payload.
 */
export const UserSocketRegistrationSchema = z.object({
  deviceInfo: z
    .object({
      userAgent: z.string().max(512).optional(),
      platform: z.string().max(64).optional(),
    })
    .optional(),
});

export const CallAcceptedSchema = z.object({
  conversationUuid: z.string(),
  userId: EntityIdSchema,
  acceptedAt: IsoDateTimeSchema,
});

export const CallRejectedSchema = z.object({
  conversationUuid: z.string(),
});

export const AuthRefreshSchema = z.object({
  token: z.string().min(1),
});

export type IncomingCall = z.infer<typeof IncomingCallSchema>;
export type CallEnded = z.infer<typeof CallEndedSchema>;
export type AuthRefreshed = z.infer<typeof AuthRefreshedSchema>;
export type SocketError = z.infer<typeof SocketErrorSchema>;
export type UserSocketRegistration = z.infer<
  typeof UserSocketRegistrationSchema
>;
export type CallAccepted = z.infer<typeof CallAcceptedSchema>;
export type CallRejected = z.infer<typeof CallRejectedSchema>;
export type AuthRefresh = z.infer<typeof AuthRefreshSchema>;
