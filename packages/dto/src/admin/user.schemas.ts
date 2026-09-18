import { z } from 'zod';
import { AccessLinkResponseSchema } from '../common/access-link.schemas.js';
import { InviteStatusSchema, RoleSchema } from '../common/domain.js';
import {
  PaginationMetaSchema,
  PaginationQuerySchema,
} from '../common/pagination.js';
import {
  EmailSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  QueryBooleanSchema,
} from '../common/primitives.js';
import { PhoneNumberSummarySchema } from './department.schemas.js';

const NameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(100, 'Name must be 100 characters or less');

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Creating a user is inviting them: nobody but its owner ever chooses an
 * account's password, so there is no password field here or in the update.
 */
export const CreateUserSchema = z.object({
  email: EmailSchema,
  name: NameSchema,
  role: RoleSchema.default('AGENT'),
  departmentIds: z.array(EntityIdSchema).optional(),
  phoneNumberIds: z.array(EntityIdSchema).optional(),
});

export const UpdateUserSchema = z.object({
  email: EmailSchema.optional(),
  name: NameSchema.optional(),
  role: RoleSchema.optional(),
});

export const UserListQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().min(1).optional(),
  role: RoleSchema.optional(),
  includeDeleted: QueryBooleanSchema.default(false),
  deletedOnly: QueryBooleanSchema.default(false),
});

export const AssignDepartmentSchema = z.object({
  departmentId: EntityIdSchema,
  order: z.number().int().min(0).default(0),
});

export const AssignPhoneNumberSchema = z.object({
  phoneNumberId: EntityIdSchema,
});

/** Links a user to their identity in the telephony provider; called by the call controller. */
export const SyncTelephonyUserSchema = z.object({
  telephonyUserId: z.string().trim().min(1, 'telephonyUserId is required'),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const UserDepartmentResponseSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  departmentName: z.string(),
  order: z.number().int(),
});

export const UserPhoneNumberResponseSchema = PhoneNumberSummarySchema;

export const UserResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: RoleSchema,
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  /** Whether they can sign in yet, and whether their invite is still live. */
  inviteStatus: InviteStatusSchema,
  departments: z.array(UserDepartmentResponseSchema),
  phoneNumbers: z.array(UserPhoneNumberResponseSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
});

export const UserListResponseSchema = PaginationMetaSchema.extend({
  users: z.array(UserResponseSchema),
});

/** What creating a user answers: the user, and the link that lets them in. */
export const InvitedUserResponseSchema = z.object({
  user: UserResponseSchema,
  invite: AccessLinkResponseSchema,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type UserListQuery = z.infer<typeof UserListQuerySchema>;
export type AssignDepartment = z.infer<typeof AssignDepartmentSchema>;
export type AssignPhoneNumber = z.infer<typeof AssignPhoneNumberSchema>;
export type SyncTelephonyUser = z.infer<typeof SyncTelephonyUserSchema>;
export type UserDepartmentResponse = z.infer<
  typeof UserDepartmentResponseSchema
>;
export type UserPhoneNumberResponse = z.infer<
  typeof UserPhoneNumberResponseSchema
>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
export type InvitedUserResponse = z.infer<typeof InvitedUserResponseSchema>;
