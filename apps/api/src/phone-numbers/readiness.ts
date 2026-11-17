import type { PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import type {
  TrackedNumber,
  TwilioNumberManagementService,
  TwilioReadinessReport,
} from './twilio-numbers.js';

export interface ReadinessSources {
  db: Pick<PrismaClient, 'phoneNumber'>;
  twilio: Pick<TwilioNumberManagementService, 'getReadinessReport'>;
  log: FastifyBaseLogger;
}

/**
 * Whether Twilio sends the listed numbers' calls and texts here. A number
 * whose release did not finish is left out: Twilio may no longer hold it, and
 * nothing may reconnect it.
 */
export async function checkTwilioReadiness({
  db,
  twilio,
  log,
}: ReadinessSources): Promise<TwilioReadinessReport> {
  let tracked: TrackedNumber[];

  try {
    tracked = await db.phoneNumber.findMany({
      where: { deletedAt: null, status: { not: 'RELEASED' } },
      select: { phoneNumber: true, type: true },
    });
  } catch (error) {
    log.error({ error }, 'Could not read the numbers to check with Twilio');
    // The account can still be checked; only the list's numbers cannot.
    const report = await twilio.getReadinessReport([]);
    return {
      ...report,
      status: 'error',
      issues: [
        ...report.issues,
        'The list of numbers could not be read, so no number was checked.',
      ],
    };
  }

  return twilio.getReadinessReport(tracked);
}
