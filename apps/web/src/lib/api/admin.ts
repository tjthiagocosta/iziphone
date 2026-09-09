import type {
  AddAgent,
  AdminStatsResponse,
  AssignDepartment,
  AssignPhoneNumber,
  AvailableNumbersResponse,
  BusinessHoursItem,
  CreateDepartment,
  CreateHoliday,
  CreateUser,
  DepartmentListQuery,
  DepartmentListResponse,
  DepartmentResponse,
  PhoneNumberListQuery,
  PhoneNumberListResponse,
  PhoneNumberResponse,
  PurchasePhoneNumber,
  SearchAvailableNumbers,
  UpdateAgentOrder,
  UpdateDepartment,
  UpdateDepartmentSettings,
  UpdateHoliday,
  UpdatePhoneNumber,
  UpdateUser,
  UserListQuery,
  UserListResponse,
  UserResponse,
} from '@repo/dto';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const headers = new Headers(options?.headers);

  // Only set Content-Type for requests with a body
  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  // Handle 204 No Content responses
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// ============================================
// Stats
// ============================================

export async function getAdminStats(): Promise<AdminStatsResponse> {
  return fetchApi('/api/admin/stats');
}

// ============================================
// Users
// ============================================

export async function getUsers(
  query: Partial<UserListQuery> = {},
): Promise<UserListResponse> {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.search) params.set('search', query.search);
  if (query.role) params.set('role', query.role);
  if (query.includeDeleted) params.set('includeDeleted', 'true');
  if (query.deletedOnly) params.set('deletedOnly', 'true');

  return fetchApi(`/api/admin/users?${params.toString()}`);
}

export async function getUser(id: string): Promise<UserResponse> {
  return fetchApi(`/api/admin/users/${id}`);
}

export async function createUser(data: CreateUser): Promise<UserResponse> {
  return fetchApi('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateUser(
  id: string,
  data: UpdateUser,
): Promise<UserResponse> {
  return fetchApi(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteUser(id: string): Promise<void> {
  await fetchApi(`/api/admin/users/${id}`, { method: 'DELETE' });
}

export async function restoreUser(id: string): Promise<UserResponse> {
  return fetchApi(`/api/admin/users/${id}/restore`, { method: 'POST' });
}

export async function assignUserPhoneNumber(
  userId: string,
  data: AssignPhoneNumber,
): Promise<void> {
  await fetchApi(`/api/admin/users/${userId}/phone-numbers`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeUserPhoneNumber(
  userId: string,
  phoneNumberId: string,
): Promise<void> {
  await fetchApi(`/api/admin/users/${userId}/phone-numbers/${phoneNumberId}`, {
    method: 'DELETE',
  });
}

export async function assignUserDepartment(
  userId: string,
  data: AssignDepartment,
): Promise<void> {
  await fetchApi(`/api/admin/users/${userId}/departments`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeUserDepartment(
  userId: string,
  departmentId: string,
): Promise<void> {
  await fetchApi(`/api/admin/users/${userId}/departments/${departmentId}`, {
    method: 'DELETE',
  });
}

// ============================================
// Departments
// ============================================

export async function getDepartments(
  query: Partial<DepartmentListQuery> = {},
): Promise<DepartmentListResponse> {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.search) params.set('search', query.search);
  if (query.includeDeleted) params.set('includeDeleted', 'true');
  if (query.deletedOnly) params.set('deletedOnly', 'true');

  return fetchApi(`/api/admin/departments?${params.toString()}`);
}

export async function getDepartment(id: string): Promise<DepartmentResponse> {
  return fetchApi(`/api/admin/departments/${id}`);
}

export async function createDepartment(
  data: CreateDepartment,
): Promise<DepartmentResponse> {
  return fetchApi('/api/admin/departments', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateDepartment(
  id: string,
  data: UpdateDepartment,
): Promise<DepartmentResponse> {
  return fetchApi(`/api/admin/departments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteDepartment(id: string): Promise<void> {
  await fetchApi(`/api/admin/departments/${id}`, { method: 'DELETE' });
}

export async function restoreDepartment(
  id: string,
): Promise<DepartmentResponse> {
  return fetchApi(`/api/admin/departments/${id}/restore`, { method: 'POST' });
}

export async function updateDepartmentSettings(
  id: string,
  data: UpdateDepartmentSettings,
): Promise<void> {
  await fetchApi(`/api/admin/departments/${id}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function updateBusinessHours(
  departmentId: string,
  hours: BusinessHoursItem[],
): Promise<void> {
  await fetchApi(`/api/admin/departments/${departmentId}/business-hours`, {
    method: 'PUT',
    body: JSON.stringify({ hours }),
  });
}

export async function addHoliday(
  departmentId: string,
  data: CreateHoliday,
): Promise<{ id: string }> {
  return fetchApi(`/api/admin/departments/${departmentId}/holidays`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateHoliday(
  departmentId: string,
  holidayId: string,
  data: UpdateHoliday,
): Promise<void> {
  await fetchApi(
    `/api/admin/departments/${departmentId}/holidays/${holidayId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    },
  );
}

export async function deleteHoliday(
  departmentId: string,
  holidayId: string,
): Promise<void> {
  await fetchApi(
    `/api/admin/departments/${departmentId}/holidays/${holidayId}`,
    { method: 'DELETE' },
  );
}

export async function addDepartmentAgent(
  departmentId: string,
  data: AddAgent,
): Promise<void> {
  await fetchApi(`/api/admin/departments/${departmentId}/agents`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateAgentOrder(
  departmentId: string,
  data: UpdateAgentOrder,
): Promise<void> {
  await fetchApi(`/api/admin/departments/${departmentId}/agents/order`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function removeDepartmentAgent(
  departmentId: string,
  userId: string,
): Promise<void> {
  await fetchApi(`/api/admin/departments/${departmentId}/agents/${userId}`, {
    method: 'DELETE',
  });
}

export async function assignDepartmentPhoneNumber(
  departmentId: string,
  phoneNumberId: string,
  isPrimary: boolean,
): Promise<void> {
  await fetchApi(`/api/admin/departments/${departmentId}/phone-numbers`, {
    method: 'POST',
    body: JSON.stringify({ phoneNumberId, isPrimary }),
  });
}

export async function removeDepartmentPhoneNumber(
  departmentId: string,
  phoneNumberId: string,
): Promise<void> {
  await fetchApi(
    `/api/admin/departments/${departmentId}/phone-numbers/${phoneNumberId}`,
    { method: 'DELETE' },
  );
}

// ============================================
// Phone Numbers
// ============================================

export async function getPhoneNumbers(
  query: Partial<PhoneNumberListQuery> = {},
): Promise<PhoneNumberListResponse> {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.limit) params.set('limit', String(query.limit));
  if (query.status) params.set('status', query.status);
  if (query.type) params.set('type', query.type);
  if (query.unassigned) params.set('unassigned', 'true');
  if (query.search) params.set('search', query.search);

  return fetchApi(`/api/admin/phone-numbers?${params.toString()}`);
}

export async function getPhoneNumber(id: string): Promise<PhoneNumberResponse> {
  return fetchApi(`/api/admin/phone-numbers/${id}`);
}

export async function searchAvailableNumbers(
  query: SearchAvailableNumbers,
): Promise<AvailableNumbersResponse> {
  const params = new URLSearchParams();
  params.set('type', query.type);
  if (query.areaCode) params.set('areaCode', query.areaCode);
  if (query.contains) params.set('contains', query.contains);
  if (query.limit) params.set('limit', String(query.limit));

  return fetchApi(`/api/admin/phone-numbers/available?${params.toString()}`);
}

export async function purchasePhoneNumber(
  data: PurchasePhoneNumber,
): Promise<PhoneNumberResponse> {
  return fetchApi('/api/admin/phone-numbers/purchase', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updatePhoneNumber(
  id: string,
  data: UpdatePhoneNumber,
): Promise<PhoneNumberResponse> {
  return fetchApi(`/api/admin/phone-numbers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function releasePhoneNumber(id: string): Promise<void> {
  await fetchApi(`/api/admin/phone-numbers/${id}`, { method: 'DELETE' });
}
