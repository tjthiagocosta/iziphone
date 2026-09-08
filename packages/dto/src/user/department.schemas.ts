import { z } from 'zod';

/** A department number as shown to its members. */
export const UserDepartmentPhoneNumberSchema = z.object({
  number: z.string(),
  isDefault: z.boolean(),
});

export const UserDepartmentItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Deterministic colour class derived from the department id. */
  color: z.string(),
  phoneNumbers: z.array(UserDepartmentPhoneNumberSchema),
});

export const UserDepartmentsResponseSchema = z.object({
  departments: z.array(UserDepartmentItemSchema),
});

export type UserDepartmentPhoneNumber = z.infer<
  typeof UserDepartmentPhoneNumberSchema
>;
export type UserDepartmentItem = z.infer<typeof UserDepartmentItemSchema>;
export type UserDepartmentsResponse = z.infer<
  typeof UserDepartmentsResponseSchema
>;
