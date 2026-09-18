import {
  type AccessLinkResponse,
  AccessLinkResponseSchema,
  type AddAgent,
  type AdminStatsResponse,
  AdminStatsResponseSchema,
  type AssignDepartment,
  type AssignPhoneNumber,
  type AvailableNumbersResponse,
  AvailableNumbersResponseSchema,
  type BusinessHoursItem,
  type CreateDepartment,
  type CreateHoliday,
  type CreateUser,
  type DepartmentGreetingResponse,
  DepartmentGreetingResponseSchema,
  type DepartmentListQuery,
  type DepartmentListResponse,
  DepartmentListResponseSchema,
  type DepartmentResponse,
  DepartmentResponseSchema,
  type HolidayCreatedResponse,
  HolidayCreatedResponseSchema,
  type InvitedUserResponse,
  InvitedUserResponseSchema,
  type PhoneNumberListQuery,
  type PhoneNumberListResponse,
  PhoneNumberListResponseSchema,
  type PhoneNumberResponse,
  PhoneNumberResponseSchema,
  type PurchasePhoneNumber,
  type SearchAvailableNumbers,
  type SystemSettingsResponse,
  SystemSettingsResponseSchema,
  type UpdateAgentOrder,
  type UpdateDepartment,
  type UpdateDepartmentSettings,
  type UpdateHoliday,
  type UpdatePhoneNumber,
  type UpdateRecordingRetention,
  type UpdateUser,
  type UserListQuery,
  type UserListResponse,
  UserListResponseSchema,
  type UserResponse,
  UserResponseSchema,
} from '@repo/dto';
import { requestApi, withQuery } from './client';

/* Routes under `/api/admin`; the API rejects anyone but an ADMIN. */

const id = encodeURIComponent;

// Stats

export function getAdminStats(): Promise<AdminStatsResponse> {
  return requestApi('/api/admin/stats', { schema: AdminStatsResponseSchema });
}

// Settings

export function getSystemSettings(): Promise<SystemSettingsResponse> {
  return requestApi('/api/admin/settings', {
    schema: SystemSettingsResponseSchema,
  });
}

/** Both retention policies are sent together, as one decision. */
export function updateRecordingRetention(
  data: UpdateRecordingRetention,
): Promise<SystemSettingsResponse> {
  return requestApi('/api/admin/settings/recording-retention', {
    method: 'PUT',
    body: data,
    schema: SystemSettingsResponseSchema,
  });
}

// Users

export function getUsers(
  query: Partial<UserListQuery> = {},
): Promise<UserListResponse> {
  return requestApi(withQuery('/api/admin/users', query), {
    schema: UserListResponseSchema,
  });
}

export function getUser(userId: string): Promise<UserResponse> {
  return requestApi(`/api/admin/users/${id(userId)}`, {
    schema: UserResponseSchema,
  });
}

/**
 * Creating a user invites them: there is no password to set here, and the
 * answer carries the link so the admin can pass it on when mail is slow or is
 * not configured at all.
 */
export function inviteUser(data: CreateUser): Promise<InvitedUserResponse> {
  return requestApi('/api/admin/users', {
    method: 'POST',
    body: data,
    schema: InvitedUserResponseSchema,
  });
}

/** Sends a fresh invite, which retires whatever link they had. */
export function resendUserInvite(userId: string): Promise<AccessLinkResponse> {
  return requestApi(`/api/admin/users/${id(userId)}/invite`, {
    method: 'POST',
    schema: AccessLinkResponseSchema,
  });
}

/** A reset link for a user who is locked out. No admin ever sets a password. */
export function sendUserPasswordReset(
  userId: string,
): Promise<AccessLinkResponse> {
  return requestApi(`/api/admin/users/${id(userId)}/password-reset`, {
    method: 'POST',
    schema: AccessLinkResponseSchema,
  });
}

export function updateUser(
  userId: string,
  data: UpdateUser,
): Promise<UserResponse> {
  return requestApi(`/api/admin/users/${id(userId)}`, {
    method: 'PATCH',
    body: data,
    schema: UserResponseSchema,
  });
}

export function deleteUser(userId: string): Promise<void> {
  return requestApi(`/api/admin/users/${id(userId)}`, { method: 'DELETE' });
}

/** Restoring invites them again, so the answer carries a fresh link. */
export function restoreUser(userId: string): Promise<InvitedUserResponse> {
  return requestApi(`/api/admin/users/${id(userId)}/restore`, {
    method: 'POST',
    schema: InvitedUserResponseSchema,
  });
}

export function assignUserPhoneNumber(
  userId: string,
  data: AssignPhoneNumber,
): Promise<void> {
  return requestApi(`/api/admin/users/${id(userId)}/phone-numbers`, {
    method: 'POST',
    body: data,
  });
}

export function removeUserPhoneNumber(
  userId: string,
  phoneNumberId: string,
): Promise<void> {
  return requestApi(
    `/api/admin/users/${id(userId)}/phone-numbers/${id(phoneNumberId)}`,
    { method: 'DELETE' },
  );
}

export function assignUserDepartment(
  userId: string,
  data: AssignDepartment,
): Promise<void> {
  return requestApi(`/api/admin/users/${id(userId)}/departments`, {
    method: 'POST',
    body: data,
  });
}

export function removeUserDepartment(
  userId: string,
  departmentId: string,
): Promise<void> {
  return requestApi(
    `/api/admin/users/${id(userId)}/departments/${id(departmentId)}`,
    { method: 'DELETE' },
  );
}

// Departments

export function getDepartments(
  query: Partial<DepartmentListQuery> = {},
): Promise<DepartmentListResponse> {
  return requestApi(withQuery('/api/admin/departments', query), {
    schema: DepartmentListResponseSchema,
  });
}

export function getDepartment(
  departmentId: string,
): Promise<DepartmentResponse> {
  return requestApi(`/api/admin/departments/${id(departmentId)}`, {
    schema: DepartmentResponseSchema,
  });
}

export function createDepartment(
  data: CreateDepartment,
): Promise<DepartmentResponse> {
  return requestApi('/api/admin/departments', {
    method: 'POST',
    body: data,
    schema: DepartmentResponseSchema,
  });
}

export function updateDepartment(
  departmentId: string,
  data: UpdateDepartment,
): Promise<DepartmentResponse> {
  return requestApi(`/api/admin/departments/${id(departmentId)}`, {
    method: 'PATCH',
    body: data,
    schema: DepartmentResponseSchema,
  });
}

export function deleteDepartment(departmentId: string): Promise<void> {
  return requestApi(`/api/admin/departments/${id(departmentId)}`, {
    method: 'DELETE',
  });
}

export function restoreDepartment(
  departmentId: string,
): Promise<DepartmentResponse> {
  return requestApi(`/api/admin/departments/${id(departmentId)}/restore`, {
    method: 'POST',
    schema: DepartmentResponseSchema,
  });
}

export function updateDepartmentSettings(
  departmentId: string,
  data: UpdateDepartmentSettings,
): Promise<void> {
  return requestApi(`/api/admin/departments/${id(departmentId)}/settings`, {
    method: 'PATCH',
    body: data,
  });
}

/** Makes the file the department's voicemail greeting; it goes as its own type. */
export function uploadDepartmentGreeting(
  departmentId: string,
  file: Blob,
): Promise<DepartmentGreetingResponse> {
  return requestApi(`/api/admin/departments/${id(departmentId)}/greeting`, {
    method: 'PUT',
    body: file,
    schema: DepartmentGreetingResponseSchema,
  });
}

export function removeDepartmentGreeting(departmentId: string): Promise<void> {
  return requestApi(`/api/admin/departments/${id(departmentId)}/greeting`, {
    method: 'DELETE',
  });
}

export function updateBusinessHours(
  departmentId: string,
  hours: BusinessHoursItem[],
): Promise<void> {
  return requestApi(
    `/api/admin/departments/${id(departmentId)}/business-hours`,
    { method: 'PUT', body: { hours } },
  );
}

export function addHoliday(
  departmentId: string,
  data: CreateHoliday,
): Promise<HolidayCreatedResponse> {
  return requestApi(`/api/admin/departments/${id(departmentId)}/holidays`, {
    method: 'POST',
    body: data,
    schema: HolidayCreatedResponseSchema,
  });
}

export function updateHoliday(
  departmentId: string,
  holidayId: string,
  data: UpdateHoliday,
): Promise<void> {
  return requestApi(
    `/api/admin/departments/${id(departmentId)}/holidays/${id(holidayId)}`,
    { method: 'PATCH', body: data },
  );
}

export function deleteHoliday(
  departmentId: string,
  holidayId: string,
): Promise<void> {
  return requestApi(
    `/api/admin/departments/${id(departmentId)}/holidays/${id(holidayId)}`,
    { method: 'DELETE' },
  );
}

export function addDepartmentAgent(
  departmentId: string,
  data: AddAgent,
): Promise<void> {
  return requestApi(`/api/admin/departments/${id(departmentId)}/agents`, {
    method: 'POST',
    body: data,
  });
}

export function updateAgentOrder(
  departmentId: string,
  data: UpdateAgentOrder,
): Promise<void> {
  return requestApi(`/api/admin/departments/${id(departmentId)}/agents/order`, {
    method: 'PATCH',
    body: data,
  });
}

export function removeDepartmentAgent(
  departmentId: string,
  userId: string,
): Promise<void> {
  return requestApi(
    `/api/admin/departments/${id(departmentId)}/agents/${id(userId)}`,
    { method: 'DELETE' },
  );
}

export function assignDepartmentPhoneNumber(
  departmentId: string,
  phoneNumberId: string,
  isPrimary: boolean,
): Promise<void> {
  return requestApi(
    `/api/admin/departments/${id(departmentId)}/phone-numbers`,
    { method: 'POST', body: { phoneNumberId, isPrimary } },
  );
}

export function removeDepartmentPhoneNumber(
  departmentId: string,
  phoneNumberId: string,
): Promise<void> {
  return requestApi(
    `/api/admin/departments/${id(departmentId)}/phone-numbers/${id(phoneNumberId)}`,
    { method: 'DELETE' },
  );
}

// Phone numbers

export function getPhoneNumbers(
  query: Partial<PhoneNumberListQuery> = {},
): Promise<PhoneNumberListResponse> {
  return requestApi(withQuery('/api/admin/phone-numbers', query), {
    schema: PhoneNumberListResponseSchema,
  });
}

export function getPhoneNumber(
  phoneNumberId: string,
): Promise<PhoneNumberResponse> {
  return requestApi(`/api/admin/phone-numbers/${id(phoneNumberId)}`, {
    schema: PhoneNumberResponseSchema,
  });
}

export function searchAvailableNumbers(
  query: SearchAvailableNumbers,
): Promise<AvailableNumbersResponse> {
  return requestApi(withQuery('/api/admin/phone-numbers/available', query), {
    schema: AvailableNumbersResponseSchema,
  });
}

export function purchasePhoneNumber(
  data: PurchasePhoneNumber,
): Promise<PhoneNumberResponse> {
  return requestApi('/api/admin/phone-numbers/purchase', {
    method: 'POST',
    body: data,
    schema: PhoneNumberResponseSchema,
  });
}

export function updatePhoneNumber(
  phoneNumberId: string,
  data: UpdatePhoneNumber,
): Promise<PhoneNumberResponse> {
  return requestApi(`/api/admin/phone-numbers/${id(phoneNumberId)}`, {
    method: 'PATCH',
    body: data,
    schema: PhoneNumberResponseSchema,
  });
}

export function releasePhoneNumber(phoneNumberId: string): Promise<void> {
  return requestApi(`/api/admin/phone-numbers/${id(phoneNumberId)}`, {
    method: 'DELETE',
  });
}
