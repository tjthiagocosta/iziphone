import { z } from 'zod';

/*
 * The people a signed-in user can hand a call to: every active user but
 * themselves. It says nothing about who is online; the call controller
 * answers that when the transfer is attempted.
 */

export const TeammateSchema = z.object({
  id: z.string(),
  /** What to call them: their name, or their email when they have none. */
  name: z.string(),
  /** Names of the departments they belong to, to tell namesakes apart. */
  departments: z.array(z.string()),
});

export const TeammatesResponseSchema = z.object({
  teammates: z.array(TeammateSchema),
});

export type Teammate = z.infer<typeof TeammateSchema>;
export type TeammatesResponse = z.infer<typeof TeammatesResponseSchema>;
