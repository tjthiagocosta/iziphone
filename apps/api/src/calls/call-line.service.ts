import type { Prisma, PrismaClient } from '@repo/db';
import type { OutboundCallLine } from '@repo/dto';

/*
 * The numbers a user may place calls from: their own and those of the
 * departments they belong to, as long as the number is in service and does
 * voice. Membership is the rule the routing cache applies to a number, and
 * the call controller lets an agent call out from a line only when its
 * routing entry names them, so a line is listed here exactly when a call from
 * it is accepted. Messaging picks its senders by the same membership.
 */

const outboundLineSelect = {
  id: true,
  phoneNumber: true,
  label: true,
  isPrimary: true,
  user: { select: { id: true, name: true, email: true } },
  department: { select: { id: true, name: true, deletedAt: true } },
} as const satisfies Prisma.PhoneNumberSelect;

type OutboundLineRow = Prisma.PhoneNumberGetPayload<{
  select: typeof outboundLineSelect;
}>;

export class CallLineService {
  constructor(private readonly db: PrismaClient) {}

  /** The user's own lines first, then department lines with the primary ones ahead. */
  async listOutboundLines(userId: string): Promise<OutboundCallLine[]> {
    const rows = await this.db.phoneNumber.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        voiceEnabled: true,
        OR: [
          { userId },
          { department: { deletedAt: null, users: { some: { userId } } } },
        ],
      },
      select: outboundLineSelect,
    });

    return rows
      .map(toOutboundLine)
      .filter((line) => line !== null)
      .sort(byPreference);
  }
}

/** A live department's number is the department's, the way routing reads it. */
function toOutboundLine(row: OutboundLineRow): OutboundCallLine | null {
  const line = {
    id: row.id,
    phoneNumber: row.phoneNumber,
    label: row.label,
    isPrimary: row.isPrimary,
  };

  if (row.department && !row.department.deletedAt) {
    return {
      ...line,
      ownerType: 'department',
      ownerId: row.department.id,
      ownerName: row.department.name,
    };
  }

  if (row.user) {
    return {
      ...line,
      ownerType: 'user',
      ownerId: row.user.id,
      ownerName: row.user.name || row.user.email,
    };
  }

  return null;
}

function byPreference(left: OutboundCallLine, right: OutboundCallLine): number {
  if (left.ownerType !== right.ownerType) {
    return left.ownerType === 'user' ? -1 : 1;
  }
  if (left.isPrimary !== right.isPrimary) {
    return left.isPrimary ? -1 : 1;
  }
  return (
    left.ownerName.localeCompare(right.ownerName) ||
    left.phoneNumber.localeCompare(right.phoneNumber)
  );
}
