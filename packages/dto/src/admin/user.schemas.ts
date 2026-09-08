import { z } from 'zod';
import { RoleSchema } from '../common/domain.js';
import {
  PaginationMetaSchema,
  PaginationQuerySchema,
} from '../common/pagination.js';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  QueryBooleanSchema,
} from '../common/primitives.js';
import { PhoneNumberSummarySchema } from './department.schemas.js';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const EmailSchema = z.email('Invalid email address').max(254);
const NameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(100, 'Name must be 100 characters or less');
const PasswordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  )
  .max(
    PASSWORD_MAX_LENGTH,
    `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  );

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateUserSchema = z.object({
  email: EmailSchema,
  name: NameSchema,
  password: PasswordSchema,
  role: RoleSchema.default('AGENT'),
  departmentIds: z.array(EntityIdSchema).optional(),
  phoneNumberIds: z.array(EntityIdSchema).optional(),
});

export const UpdateUserSchema = z.object({
  email: EmailSchema.optional(),
  name: NameSchema.optional(),
  password: PasswordSchema.optional(),
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
  departments: z.array(UserDepartmentResponseSchema),
  phoneNumbers: z.array(UserPhoneNumberResponseSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
});

export const UserListResponseSchema = PaginationMetaSchema.extend({
  users: z.array(UserResponseSchema),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type UserListQuery = z.infer<typeof UserListQuerySchema>;
export type AssignDepartment = z.infer<typeof AssignDepartmentSchema>;
export type AssignPhoneNumber = z.infer<typeof AssignPhoneNumberSchema>;
export type UserDepartmentResponse = z.infer<
  typeof UserDepartmentResponseSchema
>;
export type UserPhoneNumberResponse = z.infer<
  typeof UserPhoneNumberResponseSchema
>;
export type UserResponse = z.infer<typeof UserResponseSchema>;
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
