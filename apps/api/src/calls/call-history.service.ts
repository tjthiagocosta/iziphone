import type { Prisma, PrismaClient } from '@repo/db';
import {
  type CallContact,
  type CallLine,
  type CallListQuery,
  type CallListResponse,
  type CallRecord,
  callCounterparty,
  callLine,
  type Role,
} from '@repo/dto';
import {
  callRecordInclude,
  type PersistedCall,
  toCallRecordDto,
} from './call-record.js';
import { buildCallListWhere } from './call-scope.js';

/**
 * Reads call history in the shape the API publishes. Every read takes the
 * caller's scope as a filter, so a call outside it is missing rather than
 * forbidden, and their role, which decides how much of a call they are told
 * about once they may see it.
 */
export class CallHistoryService {
  constructor(
    private readonly db: Pick<PrismaClient, 'call' | 'contact' | 'phoneNumber'>,
  ) {}

  async listForUser(
    scope: Prisma.CallWhereInput,
    query: CallListQuery,
    role: Role,
  ): Promise<CallListResponse> {
    const where = buildCallListWhere(scope, query);

    const [calls, total] = await Promise.all([
      this.db.call.findMany({
        where,
        take: query.limit,
        skip: query.offset,
        orderBy: { createdAt: 'desc' },
        include: callRecordInclude,
      }),
      this.db.call.count({ where }),
    ]);

    return {
      calls: await this.withParties(calls, role),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /** The call a conversation belongs to, or null when it is out of scope. */
  async findInScope(
    scope: Prisma.CallWhereInput,
    conversationUuid: string,
    role: Role,
  ): Promise<CallRecord | null> {
    const call = await this.db.call.findFirst({
      where: { conversationUuid, ...scope },
      include: callRecordInclude,
    });

    if (!call) {
      return null;
    }

    const [record] = await this.withParties([call], role);
    return record ?? null;
  }

  /**
   * Names both ends of each call. `Call` stores plain numbers and no
   * reference to either the contact or the phone number row, so each side is
   * read by number in one query for the whole page rather than once per row.
   *
   * The line is not filtered on `deletedAt`: a number we have since released
   * still names the line its old calls were on.
   */
  private async withParties(
    calls: readonly PersistedCall[],
    role: Role,
  ): Promise<CallRecord[]> {
    const contactNumbers = [...new Set(calls.map(callCounterparty))];
    const lineNumbers = [...new Set(calls.map(callLine))];

    const [contacts, lines] = await Promise.all([
      contactNumbers.length === 0
        ? []
        : this.db.contact.findMany({
            where: { phoneNumber: { in: contactNumbers } },
            select: { id: true, name: true, phoneNumber: true },
          }),
      lineNumbers.length === 0
        ? []
        : this.db.phoneNumber.findMany({
            where: { phoneNumber: { in: lineNumbers } },
            select: { id: true, phoneNumber: true, label: true },
          }),
    ]);

    const contactByNumber = new Map<string, CallContact>(
      contacts.map((contact) => [contact.phoneNumber, contact]),
    );
    const lineByNumber = new Map<string, CallLine>(
      lines.map((line) => [line.phoneNumber, line]),
    );

    return calls.map((call) =>
      toCallRecordDto(
        call,
        contactByNumber.get(callCounterparty(call)) ?? null,
        lineByNumber.get(callLine(call)) ?? null,
        role,
      ),
    );
  }
}
