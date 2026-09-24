import type { PrismaClient } from '@repo/db';
import type { MessageSender } from '@repo/dto';
import { toMessageOwner } from './conversation-scope.js';

/** A phone number the user may send from, with the channels it supports. */
export interface AllowedSender {
  id: string;
  phoneNumber: string;
  label: string | null;
  isPrimary: boolean;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  userId: string | null;
  departmentId: string | null;
}

type SenderRecord = {
  id: string;
  phoneNumber: string;
  label: string | null;
  isPrimary: boolean;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  userId: string | null;
  departmentId: string | null;
  user: { id: string; name: string | null; email: string } | null;
  department: { id: string; name: string } | null;
};

/** A line as a sender, with both owner columns and both owner relations. */
const senderSelect = {
  id: true,
  phoneNumber: true,
  label: true,
  isPrimary: true,
  smsEnabled: true,
  mmsEnabled: true,
  userId: true,
  departmentId: true,
  user: { select: { id: true, name: true, email: true } },
  department: { select: { id: true, name: true } },
} as const;

export class MessageSenderService {
  constructor(private readonly db: PrismaClient) {}

  async listAllowedSenders(userId: string): Promise<MessageSender[]> {
    const [userSenders, departmentSenders] = await Promise.all([
      this.db.phoneNumber.findMany({
        where: {
          userId,
          deletedAt: null,
          status: 'ACTIVE',
          OR: [{ smsEnabled: true }, { mmsEnabled: true }],
        },
        select: senderSelect,
      }),
      this.db.phoneNumber.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          OR: [{ smsEnabled: true }, { mmsEnabled: true }],
          department: {
            deletedAt: null,
            users: {
              some: {
                userId,
              },
            },
          },
        },
        select: senderSelect,
      }),
    ]);

    return [...userSenders, ...departmentSenders]
      .map((sender) => this.mapSender(sender))
      .sort((left, right) => {
        if (left.isPrimary !== right.isPrimary) {
          return left.isPrimary ? -1 : 1;
        }

        if (left.ownerName !== right.ownerName) {
          return left.ownerName.localeCompare(right.ownerName);
        }

        return left.phoneNumber.localeCompare(right.phoneNumber);
      });
  }

  async getAllowedSmsSender(
    userId: string,
    senderId: string,
  ): Promise<AllowedSender | null> {
    return this.db.phoneNumber.findFirst({
      where: {
        id: senderId,
        deletedAt: null,
        status: 'ACTIVE',
        smsEnabled: true,
        OR: [
          { userId },
          {
            department: {
              deletedAt: null,
              users: {
                some: {
                  userId,
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        phoneNumber: true,
        label: true,
        isPrimary: true,
        smsEnabled: true,
        mmsEnabled: true,
        userId: true,
        departmentId: true,
      },
    });
  }

  async getAllowedMmsSender(
    userId: string,
    senderId: string,
  ): Promise<AllowedSender | null> {
    return this.db.phoneNumber.findFirst({
      where: {
        id: senderId,
        deletedAt: null,
        status: 'ACTIVE',
        mmsEnabled: true,
        OR: [
          { userId },
          {
            department: {
              deletedAt: null,
              users: {
                some: {
                  userId,
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        phoneNumber: true,
        label: true,
        isPrimary: true,
        smsEnabled: true,
        mmsEnabled: true,
        userId: true,
        departmentId: true,
      },
    });
  }

  private mapSender(sender: SenderRecord): MessageSender {
    const owner = toMessageOwner(sender);

    if (!owner) {
      throw new Error(`Sender ${sender.id} is missing an owner`);
    }

    return {
      id: sender.id,
      phoneNumber: sender.phoneNumber,
      label: sender.label,
      ownerType: owner.type,
      ownerId: owner.id,
      ownerName: owner.name,
      isPrimary: sender.isPrimary,
      smsEnabled: sender.smsEnabled,
      mmsEnabled: sender.mmsEnabled,
    };
  }
}
