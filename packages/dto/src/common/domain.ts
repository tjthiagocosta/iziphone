import { z } from 'zod';

/*
 * Domain enumerations shared by the HTTP API, the call controller, the web app
 * and the Redis contracts. Each mirrors a Prisma enum of the same values; the
 * database package stays independent of this one, so keep them in sync by hand.
 */

export const RoleSchema = z.enum(['ADMIN', 'SUPERVISOR', 'AGENT']);
export type Role = z.infer<typeof RoleSchema>;
export const ROLES = RoleSchema.options;

export const PhoneNumberTypeSchema = z.enum(['LOCAL', 'TOLL_FREE']);
export type PhoneNumberType = z.infer<typeof PhoneNumberTypeSchema>;

export const PhoneNumberStatusSchema = z.enum([
  'ACTIVE',
  'RESERVED',
  'RELEASED',
]);
export type PhoneNumberStatus = z.infer<typeof PhoneNumberStatusSchema>;

/** `VONAGE` only remains for numbers imported from the previous provider. */
export const TelephonyProviderSchema = z.enum(['TWILIO', 'VONAGE']);
export type TelephonyProvider = z.infer<typeof TelephonyProviderSchema>;

/** Who owns a phone number or a conversation. */
export const OwnerTypeSchema = z.enum(['user', 'department']);
export type OwnerType = z.infer<typeof OwnerTypeSchema>;

/** Where an inbound call to a number is sent. */
export const RoutingTargetTypeSchema = z.enum(['DEPARTMENT', 'USER']);
export type RoutingTargetType = z.infer<typeof RoutingTargetTypeSchema>;

/** How a department rings its members during open hours. */
export const OpenHoursRoutingTypeSchema = z.enum([
  'SIMULTANEOUS',
  'FIXED_ORDER',
]);
export type OpenHoursRoutingType = z.infer<typeof OpenHoursRoutingTypeSchema>;

/** What happens to a call outside business hours or on a holiday. */
export const ClosedHoursRoutingTypeSchema = z.enum([
  'VOICEMAIL',
  'EXTERNAL_NUMBER',
]);
export type ClosedHoursRoutingType = z.infer<
  typeof ClosedHoursRoutingTypeSchema
>;

export const CallDirectionSchema = z.enum(['inbound', 'outbound']);
export type CallDirection = z.infer<typeof CallDirectionSchema>;

/** Final status of a call, using the provider's vocabulary. */
export const CallEndStatusSchema = z.enum([
  'completed',
  'busy',
  'canceled',
  'failed',
  'no-answer',
]);
export type CallEndStatus = z.infer<typeof CallEndStatusSchema>;

export const MessageDirectionSchema = z.enum(['INBOUND', 'OUTBOUND']);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageChannelSchema = z.enum(['SMS', 'MMS']);
export type MessageChannel = z.infer<typeof MessageChannelSchema>;

export const MessageStatusSchema = z.enum([
  'RECEIVED',
  'PENDING',
  'ACCEPTED',
  'DELIVERED',
  'FAILED',
  'REJECTED',
  'EXPIRED',
  'BUFFERED',
  'UNKNOWN',
]);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;
