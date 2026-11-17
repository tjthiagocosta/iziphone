import type { Prisma, PrismaClient } from '@repo/db';
import type {
  AvailableNumbersResponse,
  ImportedPhoneNumber,
  ImportPhoneNumber,
  MonthlyPrice,
  OwnedPhoneNumbersResponse,
  PhoneNumberConnection,
  PhoneNumberListQuery,
  PhoneNumberListResponse,
  PhoneNumberOwner,
  PhoneNumberResponse,
  PhoneNumberType,
  PurchasedPhoneNumber,
  PurchasePhoneNumber,
  ReleasedPhoneNumber,
  SearchAvailableNumbers,
  UpdatePhoneNumber,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditLogParams, AuditLogService } from '../admin/index.js';
import {
  AdminServiceError,
  isUniqueConstraintViolation,
} from '../admin/index.js';
import type { RoutingCacheService } from '../routing/index.js';
import {
  holderOf,
  isPrimaryAfter,
  type NumberHolder,
  ownerOf,
  RESERVE,
  requestedHolder,
  sameHolder,
  statusFor,
} from './number-holder.js';
import {
  type CancelOutcome,
  type OwnedNumberMetadata,
  ReleaseRefusedError,
  type TwilioNumberManagementService,
  TwilioProviderError,
} from './twilio-numbers.js';

const phoneNumberInclude = {
  user: { select: { id: true, name: true, email: true } },
  department: { select: { id: true, name: true } },
} as const satisfies Prisma.PhoneNumberInclude;

type PhoneNumberRow = Prisma.PhoneNumberGetPayload<{
  include: typeof phoneNumberInclude;
}>;

/** The provider calls the service makes; tests substitute a fake. */
export type NumberProvider = Pick<
  TwilioNumberManagementService,
  | 'searchAvailableNumbers'
  | 'getMonthlyPrice'
  | 'buyNumber'
  | 'configureNumber'
  | 'getOwnedNumberMetadata'
  | 'cancelNumber'
  | 'readNumberForImport'
  | 'listAccountNumbers'
  | 'checkConnection'
>;

/** A number the account holds, about to be written to the list with its holder. */
interface HeldNumberRecord {
  phoneNumber: string;
  /** The row the number left behind when it was released here, to revive. */
  releasedRow: { id: string } | null;
  holder: NumberHolder;
  /** The form's primary switch, which defaults to off; off means "not asked". */
  isPrimary: boolean;
  label: string | undefined;
  metadata: OwnedNumberMetadata;
  actorId: string;
  /** What the request that finds the number recorded already is told. */
  conflict: () => AdminServiceError;
  /** The audit entry, written in the same transaction as the row. */
  audit: (row: PhoneNumberRow) => AuditLogParams;
}

export class PhoneNumberService {
  constructor(
    private readonly db: PrismaClient,
    private readonly log: FastifyBaseLogger,
    private readonly auditLog: AuditLogService,
    private readonly routingCache: RoutingCacheService,
    private readonly provider: NumberProvider,
  ) {}

  async list(query: PhoneNumberListQuery): Promise<PhoneNumberListResponse> {
    const { page, limit, status, type, assignedTo, search } = query;
    const where: Prisma.PhoneNumberWhereInput = { deletedAt: null };

    if (status) {
      where.status = status;
    }

    if (type) {
      where.type = type;
    }

    if (assignedTo === 'user') {
      where.userId = { not: null };
    } else if (assignedTo === 'department') {
      where.departmentId = { not: null };
    } else if (assignedTo === 'nobody') {
      where.userId = null;
      where.departmentId = null;
      // A number whose release did not finish is on its way out, and cannot
      // be given to anyone.
      where.status ??= { not: 'RELEASED' };
    }

    if (search) {
      const text = { contains: search, mode: 'insensitive' } as const;

      where.OR = [
        { phoneNumber: { contains: numberSearchText(search) } },
        { label: text },
        { user: { name: text } },
        { user: { email: text } },
        { department: { name: text } },
      ];
    }

    const [phoneNumbers, total] = await Promise.all([
      this.db.phoneNumber.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: phoneNumberInclude,
      }),
      this.db.phoneNumber.count({ where }),
    ]);

    return {
      phoneNumbers: phoneNumbers.map(toPhoneNumberResponse),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async searchAvailable(
    query: SearchAvailableNumbers,
  ): Promise<AvailableNumbersResponse> {
    const [found, monthlyPrice] = await Promise.all([
      this.provider.searchAvailableNumbers(query),
      this.monthlyPriceOrNull(query.country, query.type),
    ]);

    return { ...found, monthlyPrice };
  }

  async getById(id: string): Promise<PhoneNumberResponse | null> {
    const phoneNumber = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
      include: phoneNumberInclude,
    });

    return phoneNumber ? toPhoneNumberResponse(phoneNumber) : null;
  }

  /**
   * Buys the number, records it, then points its webhooks here. The row is
   * written before configuration so a webhook failure leaves a visible number
   * to reconnect instead of an orphan in the Twilio account; that failure is
   * answered as a purchase that is not `connected`, since the number is
   * bought either way.
   *
   * A number released here earlier keeps its row, so buying it back revives
   * that row rather than inserting a second one: its conversations and calls
   * stay attached to the line and to the owners they were written under.
   *
   * @throws AdminServiceError 400 on an unknown owner, 409 when the number is
   *   already on the account; both before anything is bought.
   */
  async purchase(
    data: PurchasePhoneNumber,
    actorId: string,
    ipAddress?: string,
  ): Promise<PurchasedPhoneNumber> {
    if (data.owner) {
      await this.assertOwnerExists(data.owner);
    }

    const previous = await this.db.phoneNumber.findUnique({
      where: { phoneNumber: data.phoneNumber },
      select: { id: true, deletedAt: true, status: true },
    });

    if (previous && !previous.deletedAt && previous.status === 'RELEASED') {
      throw new AdminServiceError(
        'The last release of this number did not finish. Choose Finish release on it in the list before buying it again.',
        409,
      );
    }

    if (previous && !previous.deletedAt) {
      throw alreadyOnAccount();
    }

    await this.provider.buyNumber({
      country: data.country,
      phoneNumber: data.phoneNumber,
    });

    const holder = holderOf(data.owner ?? null);
    let recorded: PhoneNumberRow;

    try {
      recorded = await this.recordHeld({
        phoneNumber: data.phoneNumber,
        releasedRow: previous,
        holder,
        isPrimary: data.isPrimary,
        label: data.label,
        metadata: fallbackMetadata(data),
        actorId,
        conflict: alreadyOnAccount,
        audit: (row) => ({
          action: 'phone_number.purchased',
          entityType: 'PhoneNumber',
          entityId: row.id,
          userId: actorId,
          changes: {
            phoneNumber: row.phoneNumber,
            type: row.type,
            label: data.label,
            country: data.country,
            owner: ownerOf(holder),
            ...(previous ? { boughtBack: true } : {}),
          },
          ipAddress,
        }),
      });
    } catch (error) {
      // Another purchase of the same number, from a second tab or one that
      // met Twilio's "taken" on this account, recorded it first.
      if (error instanceof AdminServiceError) {
        throw error;
      }
      if (isUniqueConstraintViolation(error)) {
        throw alreadyOnAccount();
      }

      this.log.error(
        { error, actorId },
        'Twilio number was bought but could not be recorded locally',
      );
      throw new AdminServiceError(
        'Twilio number was purchased but local persistence failed. Manual reconciliation is required.',
        500,
      );
    }

    let connected = true;

    try {
      await this.provider.configureNumber(data.phoneNumber);
    } catch (error) {
      // The number is bought and recorded either way. Failing the request
      // would read as a failed purchase and invite a second one; instead the
      // admin is told, and Reconnect on the number's page finishes the job.
      connected = false;
      this.log.error(
        { error, phoneNumberId: recorded.id, actorId },
        'Bought number could not be pointed at this deployment',
      );
    }

    const described = connected
      ? await this.applyOwnedMetadata(recorded, data.type)
      : recorded;

    // Routing follows the holder whether or not Twilio took the settings, so
    // the line is ready the moment Reconnect succeeds.
    await this.refreshRoutingAfterward(described, actorId);
    this.log.info(
      {
        phoneNumberId: described.id,
        actorId,
        boughtBack: Boolean(previous),
        connected,
      },
      'Phone number purchased',
    );

    return { ...toPhoneNumberResponse(described), connected };
  }

  /**
   * The numbers the Twilio account holds that the list does not: those never
   * added here and those released here before, each with what takes its
   * calls and texts today. A number whose release did not finish is still in
   * the list, so it is not offered.
   */
  async listOwned(): Promise<OwnedPhoneNumbersResponse> {
    const account = await this.provider.listAccountNumbers();
    const rows = await this.db.phoneNumber.findMany({
      where: {
        phoneNumber: {
          in: account.numbers.map((number) => number.phoneNumber),
        },
      },
      select: { phoneNumber: true, deletedAt: true },
    });
    const listed = new Set(
      rows.filter((row) => !row.deletedAt).map((row) => row.phoneNumber),
    );
    const released = new Set(
      rows.filter((row) => row.deletedAt).map((row) => row.phoneNumber),
    );

    return {
      truncated: account.truncated,
      numbers: account.numbers
        .filter(
          (number) =>
            isUsNumber(number.phoneNumber) && !listed.has(number.phoneNumber),
        )
        .map((number) => ({
          ...number,
          releasedHere: released.has(number.phoneNumber),
        })),
    };
  }

  /**
   * Brings a number the Twilio account already holds into the list with its
   * holder, then points it here and takes off the TwiML App, SMS application
   * or SIP trunk that would win over its webhooks. The row, and an audit
   * entry recording everything the number carried so an operator can put it
   * back by hand, are written before Twilio is touched: a failure there
   * changes nothing at Twilio, and a failure at Twilio afterwards leaves a
   * listed number to reconnect, answered as not `connected`. A number
   * released here earlier revives its row, as a purchase does.
   *
   * @throws AdminServiceError 400 on a number outside the US or an unknown
   *   owner, 409 when the number is in the list already or its release did
   *   not finish.
   * @throws TwilioProviderError 409 when the account does not hold the
   *   number, 503 when this deployment could not point it here; both before
   *   anything is recorded.
   */
  async importOwned(
    data: ImportPhoneNumber,
    actorId: string,
    ipAddress?: string,
  ): Promise<ImportedPhoneNumber> {
    if (!isUsNumber(data.phoneNumber)) {
      throw new AdminServiceError('Only US numbers can be added.');
    }
    if (data.owner) {
      await this.assertOwnerExists(data.owner);
    }

    const previous = await this.db.phoneNumber.findUnique({
      where: { phoneNumber: data.phoneNumber },
      select: { id: true, deletedAt: true, status: true },
    });

    if (previous && !previous.deletedAt && previous.status === 'RELEASED') {
      throw new AdminServiceError(
        'The last release of this number did not finish. Choose Finish release on it in the list before adding it again.',
        409,
      );
    }

    if (previous && !previous.deletedAt) {
      throw alreadyListed();
    }

    const { metadata, settings } = await this.provider.readNumberForImport(
      data.phoneNumber,
    );
    const holder = holderOf(data.owner ?? null);
    let recorded: PhoneNumberRow;

    try {
      recorded = await this.recordHeld({
        phoneNumber: data.phoneNumber,
        releasedRow: previous,
        holder,
        isPrimary: data.isPrimary,
        label: data.label,
        metadata,
        actorId,
        conflict: alreadyListed,
        audit: (row) => ({
          action: 'phone_number.imported',
          entityType: 'PhoneNumber',
          entityId: row.id,
          userId: actorId,
          changes: {
            phoneNumber: row.phoneNumber,
            type: row.type,
            label: data.label,
            owner: ownerOf(holder),
            // Removing the number later leaves these as importing set them.
            previously: settings,
            ...(previous ? { releasedHereBefore: true } : {}),
          },
          ipAddress,
        }),
      });
    } catch (error) {
      // Another import of the same number recorded it first.
      if (isUniqueConstraintViolation(error)) {
        throw alreadyListed();
      }
      throw error;
    }

    let connected = true;

    try {
      await this.provider.configureNumber(data.phoneNumber);
    } catch (error) {
      // The number is in the list either way, and Reconnect on its page
      // finishes the job; failing the request would hide that it was added.
      connected = false;
      this.log.error(
        { error, phoneNumberId: recorded.id, actorId },
        'Imported number could not be pointed at this deployment',
      );
    }

    await this.refreshRoutingAfterward(recorded, actorId);
    this.log.info(
      {
        phoneNumberId: recorded.id,
        actorId,
        releasedHereBefore: Boolean(previous),
        connected,
      },
      'Phone number imported',
    );

    return { ...toPhoneNumberResponse(recorded), connected };
  }

  /**
   * Whether the number's calls and texts reach this deployment, as Twilio
   * has it now. Null when the number is not in the list.
   */
  async connection(id: string): Promise<PhoneNumberConnection | null> {
    const row = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
      select: { phoneNumber: true, type: true },
    });

    return row
      ? this.provider.checkConnection(row.phoneNumber, row.type)
      : null;
  }

  /**
   * Changes a number's label, holder or department primary. A change that
   * names the holder the admin saw is refused once somebody else has moved
   * the number, and the new holder is written only if the number still has
   * the holder read here, so of two admins moving it at once one wins and the
   * other is told.
   *
   * @throws AdminServiceError 400 on an unknown owner, 409 when the number
   *   changed hands since the admin saw it or since it was read.
   */
  async update(
    id: string,
    data: UpdatePhoneNumber,
    actorId: string,
    ipAddress?: string,
  ): Promise<PhoneNumberResponse | null> {
    const existing = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
      include: phoneNumberInclude,
    });

    if (!existing) {
      return null;
    }

    if (existing.status === 'RELEASED') {
      throw beingReleased();
    }

    const before: NumberHolder = {
      userId: existing.userId,
      departmentId: existing.departmentId,
    };

    if (
      data.expectedOwner !== undefined &&
      !sameHolder(before, holderOf(data.expectedOwner))
    ) {
      throw changedHands();
    }

    const after = requestedHolder(before, data.owner);
    const holderChanged = !sameHolder(before, after);

    // Would otherwise be dropped without a word and answered as done.
    if (data.isPrimary === true && !after.departmentId) {
      throw new AdminServiceError(
        'Only a number a department holds can be its primary number.',
        400,
      );
    }

    if (holderChanged && data.owner) {
      await this.assertOwnerExists(data.owner);
    }

    const updated = await this.db.$transaction(async (tx) => {
      const isPrimary = isPrimaryAfter({
        before,
        after,
        wasPrimary: existing.isPrimary,
        requested: data.isPrimary,
        departmentHasPrimary: await departmentHasPrimary(tx, after, id),
      });
      const changes: Record<string, unknown> = {};

      if (data.label !== undefined && data.label !== existing.label) {
        changes.label = { from: existing.label, to: data.label };
      }
      if (holderChanged) {
        changes.owner = { from: ownerOf(before), to: ownerOf(after) };
      }
      if (isPrimary !== existing.isPrimary) {
        changes.isPrimary = { from: existing.isPrimary, to: isPrimary };
      }

      if (Object.keys(changes).length === 0) {
        return existing;
      }

      // Only what depends on the holder is refused once somebody moved the
      // number meanwhile; a label is the number's own.
      const holderMatters = holderChanged || isPrimary !== existing.isPrimary;
      const { count } = await tx.phoneNumber.updateMany({
        where: {
          id,
          deletedAt: null,
          status: { not: 'RELEASED' },
          ...(holderMatters
            ? { userId: before.userId, departmentId: before.departmentId }
            : {}),
        },
        data: {
          label: data.label,
          updatedBy: actorId,
          ...(holderMatters ? { isPrimary } : {}),
          ...(holderChanged
            ? {
                userId: after.userId,
                departmentId: after.departmentId,
                status: statusFor(after),
              }
            : {}),
        },
      });

      if (count === 0) {
        throw (await isBeingReleased(tx, id))
          ? beingReleased()
          : changedHands();
      }

      if (isPrimary && after.departmentId) {
        await demoteOtherPrimaries(tx, after.departmentId, id);
      }

      await this.auditLog.create(
        {
          action: auditActionFor(holderChanged, after),
          entityType: 'PhoneNumber',
          entityId: id,
          userId: actorId,
          changes,
          ipAddress,
        },
        tx,
      );

      return tx.phoneNumber.findUniqueOrThrow({
        where: { id },
        include: phoneNumberInclude,
      });
    });

    if (holderChanged) {
      await this.refreshRoutingAfterward(updated, actorId);
    }

    return toPhoneNumberResponse(updated);
  }

  /**
   * Points the number's webhooks at this deployment again and takes off
   * whatever Twilio would use instead: after a purchase or an import whose
   * setup failed, after the deployment moved to another address, or after
   * somebody changed the number in the Twilio Console. The audit entry
   * records what the number carried before.
   */
  async reconnect(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<PhoneNumberResponse | null> {
    const existing = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
      include: phoneNumberInclude,
    });

    if (!existing) {
      return null;
    }

    if (existing.status === 'RELEASED') {
      throw beingReleased();
    }

    // Written once the number is read and before Twilio changes it, so what
    // a Reconnect that fails half-way detached is still on record.
    await this.provider.configureNumber(
      existing.phoneNumber,
      async (previously) => {
        await this.auditLog.create({
          action: 'phone_number.reconnected',
          entityType: 'PhoneNumber',
          entityId: id,
          userId: actorId,
          changes: { phoneNumber: existing.phoneNumber, previously },
          ipAddress,
        });
      },
    );

    const reconnected = await this.applyOwnedMetadata(existing, existing.type);

    await this.refreshRoutingAfterward(reconnected, actorId);
    this.log.info({ phoneNumberId: id, actorId }, 'Phone number reconnected');

    return toPhoneNumberResponse(reconnected);
  }

  /**
   * Gives a number in the reserve back to Twilio. Only a number in the
   * reserve can be released, so taking a line away from the people who answer
   * it is always its own, earlier step.
   *
   * The number is first marked as being released, on the condition that it
   * is still in the reserve, so nobody can give it to someone or buy it back
   * while Twilio is cancelling it. It stays listed until Twilio has let go of
   * it: a number we may still pay for must stay visible. If Twilio refuses,
   * it goes back to the reserve; if this stops after Twilio let go, releasing
   * it again finishes the job. One Twilio's account no longer has (released
   * in its console, ported out) is released here as well, and the answer says
   * nothing was cancelled at Twilio.
   *
   * @throws AdminServiceError 409 when a user or department holds the number,
   *   or somebody gave it to one while this release began.
   */
  async release(
    id: string,
    actorId: string,
    ipAddress?: string,
  ): Promise<ReleasedPhoneNumber | null> {
    const phoneNumber = await this.db.phoneNumber.findUnique({
      where: { id, deletedAt: null },
      select: {
        id: true,
        phoneNumber: true,
        provider: true,
        userId: true,
        departmentId: true,
        status: true,
      },
    });

    if (!phoneNumber) {
      return null;
    }

    if (ownerOf(phoneNumber)) {
      throw new AdminServiceError(
        'Move this number to the reserve before releasing it.',
        409,
      );
    }

    // Already marked by an earlier release that did not finish: asking again
    // finishes it, and a failure leaves the mark for the next try.
    const resuming = phoneNumber.status === 'RELEASED';

    if (!resuming) {
      const { count } = await this.db.phoneNumber.updateMany({
        where: {
          id,
          deletedAt: null,
          userId: null,
          departmentId: null,
          status: { not: 'RELEASED' },
        },
        data: { status: 'RELEASED', isPrimary: false, updatedBy: actorId },
      });

      if (count === 0) {
        throw await this.claimRefusal(id);
      }
    }

    let outcome: CancelOutcome;

    try {
      outcome = await this.provider.cancelNumber(phoneNumber.phoneNumber);
    } catch (error) {
      // A resumed release keeps its mark, since an earlier try may have let
      // go of the number, unless Twilio just refused while it had it.
      const returnedToReserve =
        resuming && !(error instanceof ReleaseRefusedError)
          ? false
          : await this.returnToReserve(id, actorId);

      await this.auditRefusedRelease({
        id,
        phoneNumber: phoneNumber.phoneNumber,
        error,
        returnedToReserve,
        actorId,
        ipAddress,
      });
      throw error;
    }

    if (outcome === 'unconfirmed') {
      // Twilio may have taken the number back, so it must not return to the
      // reserve to be given to someone: it keeps its mark, and Finish release
      // asks Twilio again.
      const unconfirmed = new TwilioProviderError(
        'Twilio did not confirm the release. The number stays listed as Release unfinished: choose Finish release to ask Twilio again.',
        504,
      );

      await this.auditRefusedRelease({
        id,
        phoneNumber: phoneNumber.phoneNumber,
        error: unconfirmed,
        returnedToReserve: false,
        actorId,
        ipAddress,
      });
      throw unconfirmed;
    }

    let finished: boolean;

    try {
      finished = await this.db.$transaction(async (tx) => {
        const { count } = await tx.phoneNumber.updateMany({
          where: { id, deletedAt: null, status: 'RELEASED' },
          data: { deletedAt: new Date(), updatedBy: actorId },
        });

        if (count === 0) {
          return false;
        }

        await this.auditLog.create(
          {
            action: 'phone_number.released',
            entityType: 'PhoneNumber',
            entityId: id,
            userId: actorId,
            changes: {
              phoneNumber: phoneNumber.phoneNumber,
              ...(outcome === 'not-in-account'
                ? { alreadyGoneFromTwilio: true }
                : {}),
              ...(resuming ? { finishedEarlierRelease: true } : {}),
            },
            ipAddress,
          },
          tx,
        );

        return true;
      });
    } catch (error) {
      this.log.error(
        { error, phoneNumberId: id, actorId, outcome },
        'Number is gone from Twilio but could not be taken off the list',
      );
      throw new AdminServiceError(
        'The number is no longer on your Twilio account, but it could not be taken off the list here. Release it again to finish.',
        500,
      );
    }

    if (!finished) {
      await this.assertReleasedElsewhere(id, actorId);
    }

    await this.refreshRoutingAfterward(phoneNumber, actorId);
    this.log.info(
      { phoneNumberId: id, actorId, outcome, resuming },
      'Phone number released',
    );

    // An unfinished release of a number bought on Twilio that finds nothing
    // there most likely lost it on its first try, and sending the admin to
    // look for it on another account would be the wrong advice. A number
    // imported from the previous provider was most likely never on Twilio,
    // and the admin must hear to cancel it there. The audit entry keeps
    // exactly what this request found.
    const lostOnFirstTry = resuming && phoneNumber.provider === 'TWILIO';

    return { cancelledAtTwilio: outcome === 'released' || lostOnFirstTry };
  }

  /**
   * The closing write found no number being released. Another request
   * finishing the same release is fine; a number put back or given to
   * someone meanwhile is listed while Twilio no longer has it, and the admin
   * must hear that.
   */
  private async assertReleasedElsewhere(
    id: string,
    actorId: string,
  ): Promise<void> {
    const current = await this.db.phoneNumber.findUnique({
      where: { id },
      select: { deletedAt: true },
    });

    if (current?.deletedAt) {
      return;
    }

    this.log.error(
      { phoneNumberId: id, actorId },
      'Number is gone from Twilio but was changed here while it was being released',
    );
    throw new AdminServiceError(
      'Twilio no longer has this number, but it was changed here while it was being released. Move it to the reserve if it is not there, then release it again to take it off the list.',
      409,
    );
  }

  /**
   * Undoes a release Twilio refused: a number we still pay for stays usable.
   * Answers whether the number is back in the reserve.
   */
  private async returnToReserve(id: string, actorId: string): Promise<boolean> {
    this.log.warn(
      { phoneNumberId: id, actorId },
      'Twilio did not release the number; putting it back in the reserve',
    );

    try {
      const { count } = await this.db.phoneNumber.updateMany({
        where: { id, deletedAt: null, status: 'RELEASED' },
        data: { status: 'RESERVED', updatedBy: actorId },
      });

      return count > 0;
    } catch (error) {
      // Twilio's refusal is what the admin must see. The number stays listed
      // as being released, and releasing it again tries once more.
      this.log.error(
        { error, phoneNumberId: id, actorId },
        'Could not put a number Twilio kept back in the reserve',
      );
      return false;
    }
  }

  private async auditRefusedRelease(refusal: {
    id: string;
    phoneNumber: string;
    error: unknown;
    returnedToReserve: boolean;
    actorId: string;
    ipAddress: string | undefined;
  }): Promise<void> {
    try {
      await this.auditLog.create({
        action: 'phone_number.release_failed',
        entityType: 'PhoneNumber',
        entityId: refusal.id,
        userId: refusal.actorId,
        changes: {
          phoneNumber: refusal.phoneNumber,
          reason:
            refusal.error instanceof Error
              ? refusal.error.message
              : 'Unknown error',
          returnedToReserve: refusal.returnedToReserve,
        },
        ipAddress: refusal.ipAddress,
      });
    } catch (error) {
      // Twilio's refusal is what the admin must see; the log keeps the rest.
      this.log.error(
        { error, phoneNumberId: refusal.id, actorId: refusal.actorId },
        'Could not record a refused release in the audit log',
      );
    }
  }

  /**
   * Why a release could not mark the number: another release got there
   * first, or somebody gave the number to someone.
   */
  private async claimRefusal(id: string): Promise<AdminServiceError> {
    return (await isBeingReleased(this.db, id))
      ? new AdminServiceError(
          'Somebody else is releasing this number already. Reload the list to see how it ended.',
          409,
        )
      : changedHands();
  }

  /**
   * Writes a number the account holds to the list with its holder, applying
   * the department primary rule, and audits it in the same transaction. A
   * number released here before revives its row, conditionally, so that of
   * two requests bringing it back at once only one records it: its
   * conversations and calls stay attached to the line and to the owners they
   * were written under.
   */
  private async recordHeld(record: HeldNumberRecord): Promise<PhoneNumberRow> {
    const { holder, actorId, releasedRow } = record;

    return this.db.$transaction(async (tx) => {
      const isPrimary = isPrimaryAfter({
        before: RESERVE,
        after: holder,
        wasPrimary: false,
        // Off means "not asked", so a department's first number still
        // becomes its primary.
        requested: record.isPrimary || undefined,
        departmentHasPrimary: await departmentHasPrimary(tx, holder),
      });

      if (isPrimary && holder.departmentId) {
        await demoteOtherPrimaries(tx, holder.departmentId, null);
      }

      const fields = {
        ...metadataFields(record.metadata),
        // A number that comes back starts without the label it had before.
        label: record.label ?? null,
        provider: 'TWILIO',
        userId: holder.userId,
        departmentId: holder.departmentId,
        isPrimary,
        status: statusFor(holder),
      } as const;
      let row: PhoneNumberRow;

      if (releasedRow) {
        const { count } = await tx.phoneNumber.updateMany({
          where: { id: releasedRow.id, deletedAt: { not: null } },
          data: {
            ...fields,
            deletedAt: null,
            // Back in the list is added now, and by this admin: the list
            // puts the newest number first.
            createdAt: new Date(),
            createdBy: actorId,
            updatedBy: actorId,
          },
        });

        if (count === 0) {
          throw record.conflict();
        }

        row = await tx.phoneNumber.findUniqueOrThrow({
          where: { id: releasedRow.id },
          include: phoneNumberInclude,
        });
      } else {
        row = await tx.phoneNumber.create({
          data: {
            ...fields,
            phoneNumber: record.phoneNumber,
            createdBy: actorId,
          },
          include: phoneNumberInclude,
        });
      }

      await this.auditLog.create(record.audit(row), tx);

      return row;
    });
  }

  /**
   * Refreshes routing after a change that has already happened, which a
   * failure here must not report as failed. The call controller asks the API
   * when the cache does not know a number.
   */
  private async refreshRoutingAfterward(
    changed: { id: string; phoneNumber: string },
    actorId: string,
  ): Promise<void> {
    try {
      await this.routingCache.refreshPhoneNumbers([changed.phoneNumber]);
    } catch (error) {
      this.log.error(
        { error, phoneNumberId: changed.id, actorId },
        'Routing cache could not be refreshed after a number changed',
      );
    }
  }

  /** @throws AdminServiceError 400 when the user or department does not exist. */
  private async assertOwnerExists(owner: PhoneNumberOwner): Promise<void> {
    if (owner.type === 'user') {
      const user = await this.db.user.findUnique({
        where: { id: owner.id, deletedAt: null },
        select: { id: true },
      });

      if (!user) {
        throw new AdminServiceError('User not found');
      }

      return;
    }

    const department = await this.db.department.findUnique({
      where: { id: owner.id, deletedAt: null },
      select: { id: true },
    });

    if (!department) {
      throw new AdminServiceError('Department not found');
    }
  }

  /**
   * Copies what Twilio says about an owned number onto its row. The number
   * already works without it; a failed read keeps the details we guessed at
   * purchase time, and the next reconnect reads them again.
   */
  private async applyOwnedMetadata(
    row: PhoneNumberRow,
    fallbackType: PhoneNumberType,
  ): Promise<PhoneNumberRow> {
    try {
      const metadata = await this.provider.getOwnedNumberMetadata(
        row.phoneNumber,
        fallbackType,
      );

      if (!metadata) {
        return row;
      }

      return await this.db.phoneNumber.update({
        where: { id: row.id },
        data: metadataFields(metadata),
        include: phoneNumberInclude,
      });
    } catch (error) {
      // Details are a nicety; the purchase or reconnect they follow has
      // already happened and must be answered as such.
      this.log.warn(
        { error, phoneNumberId: row.id },
        'Could not refresh the number details from Twilio; keeping the ones we had',
      );
      return row;
    }
  }

  /**
   * The price shown before buying. A search is still worth answering without
   * it, and the confirmation then says the price could not be read.
   */
  private async monthlyPriceOrNull(
    country: string,
    type: PhoneNumberType,
  ): Promise<MonthlyPrice | null> {
    try {
      return await this.provider.getMonthlyPrice(country, type);
    } catch (error) {
      this.log.warn({ error }, 'Could not read Twilio phone number prices');
      return null;
    }
  }
}

/** Whether the department a holder names already has a primary, this number aside. */
async function departmentHasPrimary(
  tx: Prisma.TransactionClient,
  holder: NumberHolder,
  exceptId?: string,
): Promise<boolean> {
  if (!holder.departmentId) {
    return false;
  }

  const primaries = await tx.phoneNumber.count({
    where: {
      departmentId: holder.departmentId,
      deletedAt: null,
      isPrimary: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  });

  return primaries > 0;
}

/** A department has one primary number; promoting one demotes the rest. */
async function demoteOtherPrimaries(
  tx: Prisma.TransactionClient,
  departmentId: string,
  keepId: string | null,
): Promise<void> {
  await tx.phoneNumber.updateMany({
    where: {
      departmentId,
      deletedAt: null,
      isPrimary: true,
      ...(keepId ? { id: { not: keepId } } : {}),
    },
    data: { isPrimary: false },
  });
}

/**
 * Whether a number is being released, or already was: what a conditional
 * write that matched nothing ran into, if not a move.
 */
async function isBeingReleased(
  db: Prisma.TransactionClient,
  id: string,
): Promise<boolean> {
  const current = await db.phoneNumber.findUnique({
    where: { id },
    select: { deletedAt: true, status: true },
  });

  return (
    !current || current.deletedAt !== null || current.status === 'RELEASED'
  );
}

function alreadyOnAccount(): AdminServiceError {
  return new AdminServiceError('This number is already on your account.', 409);
}

function alreadyListed(): AdminServiceError {
  return new AdminServiceError('This number is already in the list.', 409);
}

/**
 * Whether a number is one number management handles. Twilio does not say
 * which country a number the account holds is in, so its +1 calling code is
 * as close as the number itself tells; a Canadian number passes.
 */
function isUsNumber(phoneNumber: string): boolean {
  return phoneNumber.startsWith('+1');
}

function changedHands(): AdminServiceError {
  return new AdminServiceError(
    'This number changed hands while you were editing it. Reload it and try again.',
    409,
  );
}

function beingReleased(): AdminServiceError {
  return new AdminServiceError(
    'This number is being released. Release it again to finish, or reload the list.',
    409,
  );
}

function auditActionFor(holderChanged: boolean, after: NumberHolder) {
  if (!holderChanged) {
    return 'phone_number.updated' as const;
  }

  return ownerOf(after)
    ? ('phone_number.assigned' as const)
    : ('phone_number.unassigned' as const);
}

/**
 * Numbers are stored in E.164, so a number typed with punctuation, such as
 * `(312) 555-0101`, is matched by its digits.
 */
function numberSearchText(search: string): string {
  const digits = search.replace(/\D/g, '');

  return /^[\d\s()+.-]+$/.test(search) && digits ? digits : search;
}

/** What we know about a number before Twilio confirms its metadata. */
function fallbackMetadata(data: PurchasePhoneNumber): OwnedNumberMetadata {
  return {
    phoneNumber: data.phoneNumber,
    friendlyName: data.phoneNumber,
    type: data.type,
    providerType: data.type === 'TOLL_FREE' ? 'toll-free' : 'local',
    locality: null,
    region: null,
    country: data.country,
    voiceEnabled: true,
    smsEnabled: true,
    mmsEnabled: false,
    faxEnabled: false,
  };
}

function metadataFields(metadata: OwnedNumberMetadata) {
  return {
    friendlyName: metadata.friendlyName,
    type: metadata.type,
    locality: metadata.locality,
    region: metadata.region,
    country: metadata.country,
    voiceEnabled: metadata.voiceEnabled,
    smsEnabled: metadata.smsEnabled,
    mmsEnabled: metadata.mmsEnabled,
    faxEnabled: metadata.faxEnabled,
  };
}

function toPhoneNumberResponse(
  phoneNumber: PhoneNumberRow,
): PhoneNumberResponse {
  let assignedTo: PhoneNumberResponse['assignedTo'] = null;

  if (phoneNumber.user) {
    assignedTo = {
      type: 'user',
      id: phoneNumber.user.id,
      name: phoneNumber.user.name || phoneNumber.user.email,
    };
  } else if (phoneNumber.department) {
    assignedTo = {
      type: 'department',
      id: phoneNumber.department.id,
      name: phoneNumber.department.name,
    };
  }

  return {
    id: phoneNumber.id,
    phoneNumber: phoneNumber.phoneNumber,
    friendlyName: phoneNumber.friendlyName,
    type: phoneNumber.type,
    label: phoneNumber.label,
    provider: phoneNumber.provider,
    locality: phoneNumber.locality,
    region: phoneNumber.region,
    country: phoneNumber.country,
    voiceEnabled: phoneNumber.voiceEnabled,
    smsEnabled: phoneNumber.smsEnabled,
    mmsEnabled: phoneNumber.mmsEnabled,
    faxEnabled: phoneNumber.faxEnabled,
    status: phoneNumber.status,
    isPrimary: phoneNumber.isPrimary,
    assignedTo,
    createdAt: phoneNumber.createdAt.toISOString(),
    updatedAt: phoneNumber.updatedAt.toISOString(),
  };
}
