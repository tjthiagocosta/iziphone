import { z } from 'zod';

const Count = z.number().int().nonnegative();

export const AdminStatsResponseSchema = z.object({
  users: z.object({
    total: Count,
    active: Count,
    deleted: Count,
    byRole: z.object({
      admin: Count,
      supervisor: Count,
      agent: Count,
    }),
  }),
  departments: z.object({
    total: Count,
    active: Count,
    deleted: Count,
  }),
  phoneNumbers: z.object({
    total: Count,
    active: Count,
    reserved: Count,
    released: Count,
    byType: z.object({
      local: Count,
      tollFree: Count,
    }),
  }),
});

export type AdminStatsResponse = z.infer<typeof AdminStatsResponseSchema>;
