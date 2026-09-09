import { Prisma } from '@repo/db';
import { HttpError } from '../infra/index.js';

type AdminErrorStatus = 400 | 404 | 409 | 500;

/** A rule the admin services enforce, carrying the HTTP status routes reply with. */
export class AdminServiceError extends HttpError {
  constructor(message: string, statusCode: AdminErrorStatus = 400) {
    super(message, statusCode);
  }
}

/**
 * Unique constraints are the source of truth for duplicate names and emails;
 * a pre-check would still race with a concurrent insert.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
