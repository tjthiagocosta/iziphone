import type { Prisma, PrismaClient } from '@repo/db';
import type {
  AccessLinkResponse,
  SetPassword,
  SetPasswordLink,
  SetPasswordPurpose,
} from '@repo/dto';
import bcrypt from 'bcryptjs';
import type { ServiceLogger } from '../infra/index.js';
import { accessLinkEmail, type Mailer } from '../mail/index.js';
import {
  accessLinkExpiry,
  accessLinkLifetimeWords,
  accessLinkMessage,
  accessLinkUrl,
  accessLinkValidity,
  generateAccessToken,
  hasCredentialPassword,
  hashAccessToken,
} from './access-link.js';
import { BCRYPT_ROUNDS } from './better-auth.js';

/** The part of a transaction that issues links, so a user and their invite commit together. */
export type AccessLinkWriter = Pick<
  Prisma.TransactionClient,
  'setPasswordToken'
>;

export interface IssueAccessLink {
  userId: string;
  purpose: SetPasswordPurpose;
  /** The admin who issued it; omitted when the person asked for it themselves. */
  issuedBy?: string;
  now?: Date;
}

/** A link that has just been issued. Its raw token exists only here and in the URL. */
export interface IssuedAccessLink {
  purpose: SetPasswordPurpose;
  url: string;
  expiresAt: Date;
}

export interface AccessLinkRecipient {
  email: string;
  name: string | null;
}

export type ConsumedAccessLink =
  | { ok: true; email: string }
  | { ok: false; message: string };

/** Aborts the transaction when another submission of the same link won the race. */
class AccessLinkAlreadyConsumed extends Error {}

/**
 * Issues, delivers and consumes the links that are the only way a password is
 * ever set here. The rules live in `./access-link.js`; this is the storing,
 * the mailing and the revoking around them.
 *
 * Mail is never sent inside a transaction: an admin who is shown a link must
 * be able to trust that the account behind it exists, and a mail server that
 * is slow or down must not hold a database transaction open or roll one back.
 */
export class AccessLinkService {
  constructor(
    private readonly db: PrismaClient,
    private readonly mailer: Mailer,
    /** Public origin of the web app; every link is built on it. */
    private readonly webUrl: string,
    private readonly log: ServiceLogger,
  ) {}

  /**
   * Replaces whatever link that user had for that purpose, which is what makes
   * a resend a rotation: the previous email stops working the moment a new one
   * is sent.
   */
  async issueIn(
    tx: AccessLinkWriter,
    params: IssueAccessLink,
  ): Promise<IssuedAccessLink> {
    const now = params.now ?? new Date();
    const rawToken = generateAccessToken();
    const tokenHash = hashAccessToken(rawToken);
    const expiresAt = accessLinkExpiry(params.purpose, now);

    await tx.setPasswordToken.upsert({
      where: {
        userId_purpose: { userId: params.userId, purpose: params.purpose },
      },
      create: {
        tokenHash,
        purpose: params.purpose,
        userId: params.userId,
        expiresAt,
        issuedBy: params.issuedBy ?? null,
        createdAt: now,
      },
      update: {
        tokenHash,
        expiresAt,
        issuedBy: params.issuedBy ?? null,
        consumedAt: null,
        createdAt: now,
      },
    });

    return {
      purpose: params.purpose,
      url: accessLinkUrl(this.webUrl, rawToken),
      expiresAt,
    };
  }

  async issue(params: IssueAccessLink): Promise<IssuedAccessLink> {
    return this.issueIn(this.db, params);
  }

  /**
   * Emails the link and reports what an admin needs to know: the link itself,
   * and whether they have to pass it on by hand.
   */
  async deliver(
    link: IssuedAccessLink,
    recipient: AccessLinkRecipient,
  ): Promise<AccessLinkResponse> {
    const result = await this.mailer.send(
      accessLinkEmail(link.purpose, {
        to: recipient.email,
        name: recipient.name ?? recipient.email,
        url: link.url,
        lifetime: accessLinkLifetimeWords(link.purpose),
      }),
    );

    return {
      purpose: link.purpose,
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      emailSent: result.sent,
      emailError: result.sent ? null : result.reason,
    };
  }

  /** Whether the page behind a link may still ask for a password, and what for. */
  async describe(
    rawToken: string,
    now: Date = new Date(),
  ): Promise<SetPasswordLink> {
    const stored = await this.db.setPasswordToken.findUnique({
      where: { tokenHash: hashAccessToken(rawToken) },
      select: {
        purpose: true,
        expiresAt: true,
        consumedAt: true,
        user: { select: { deletedAt: true } },
      },
    });

    const validity = accessLinkValidity(
      stored
        ? {
            purpose: stored.purpose,
            expiresAt: stored.expiresAt,
            consumedAt: stored.consumedAt,
            userDeletedAt: stored.user.deletedAt,
          }
        : null,
      now,
    );

    return validity.valid
      ? { valid: true, purpose: validity.purpose, message: null }
      : {
          valid: false,
          purpose: null,
          message: accessLinkMessage(validity.reason),
        };
  }

  /**
   * Sets the password the link was issued for, spends the link and signs every
   * other device out. The caller signs the browser in afterwards; that is the
   * one step that belongs to Better Auth rather than here.
   */
  async consume(
    input: SetPassword,
    now: Date = new Date(),
  ): Promise<ConsumedAccessLink> {
    const stored = await this.db.setPasswordToken.findUnique({
      where: { tokenHash: hashAccessToken(input.token) },
      select: {
        id: true,
        purpose: true,
        expiresAt: true,
        consumedAt: true,
        userId: true,
        user: { select: { email: true, deletedAt: true } },
      },
    });

    const validity = accessLinkValidity(
      stored
        ? {
            purpose: stored.purpose,
            expiresAt: stored.expiresAt,
            consumedAt: stored.consumedAt,
            userDeletedAt: stored.user.deletedAt,
          }
        : null,
      now,
    );

    if (!stored || !validity.valid) {
      return {
        ok: false,
        message: accessLinkMessage(
          validity.valid ? 'unknown' : validity.reason,
        ),
      };
    }

    const hashedPassword = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const { id, userId, purpose } = stored;

    try {
      await this.db.$transaction(async (tx) => {
        /*
         * Spend the link first. Two submissions of the same link reach this
         * line together; the one that does not claim it must not go on to set
         * a password of its own.
         */
        const claimed = await tx.setPasswordToken.updateMany({
          where: { id, consumedAt: null },
          data: { consumedAt: now },
        });

        if (claimed.count !== 1) {
          throw new AccessLinkAlreadyConsumed();
        }

        /*
         * `accountId` is also written: Better Auth looks the credential up by
         * the user's id, and rows written by an older version of the admin
         * screen carry the email there instead, which no sign-in would match.
         */
        const updated = await tx.account.updateMany({
          where: { userId, providerId: 'credential' },
          data: { password: hashedPassword, accountId: userId },
        });

        if (updated.count === 0) {
          await tx.account.create({
            data: {
              userId,
              providerId: 'credential',
              accountId: userId,
              password: hashedPassword,
            },
          });
        }

        // Whoever was signed in as this account before does not stay signed in.
        await tx.session.deleteMany({ where: { userId } });
      });
    } catch (error) {
      if (error instanceof AccessLinkAlreadyConsumed) {
        return { ok: false, message: accessLinkMessage('consumed') };
      }
      throw error;
    }

    this.log.info({ userId, purpose }, 'Password set from an access link');

    return { ok: true, email: stored.user.email };
  }

  /**
   * Issues a reset for an address somebody typed on the signed-out page.
   * Tells the caller nothing either way: whether the address belongs to an
   * account is exactly what a stranger must not learn from asking, which is
   * also why the route answers without waiting for this to finish.
   */
  async requestReset(email: string, now: Date = new Date()): Promise<void> {
    const user = await this.db.user.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        accounts: {
          where: { providerId: 'credential' },
          select: { password: true },
        },
      },
    });

    // No credential means they were never let in; an invite, not a reset,
    // is what they need, and only an admin can issue one.
    if (!user || !hasCredentialPassword(user.accounts)) {
      this.log.info('Password reset requested for an address with no account');
      return;
    }

    const link = await this.issue({ userId: user.id, purpose: 'RESET', now });
    const delivered = await this.deliver(link, {
      email: user.email,
      name: user.name,
    });

    this.log.info(
      { userId: user.id, emailSent: delivered.emailSent },
      'Password reset link issued',
    );
  }
}
