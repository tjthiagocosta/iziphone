import type { Contact, Prisma, PrismaClient } from '@repo/db';

type ContactDbClient = PrismaClient | Prisma.TransactionClient;

export class MessagingContactService {
  constructor(private readonly db: PrismaClient) {}

  /** `phoneNumber` must already be E.164; callers normalise at their boundary. */
  async findOrCreateByPhoneNumber(
    phoneNumber: string,
    name?: string | null,
    dbClient: ContactDbClient = this.db,
  ): Promise<Contact> {
    const normalizedName = name?.trim() || null;

    const existing = await dbClient.contact.findUnique({
      where: { phoneNumber },
    });

    if (!existing) {
      return dbClient.contact.create({
        data: {
          phoneNumber,
          name: normalizedName,
        },
      });
    }

    if (!existing.name && normalizedName) {
      return dbClient.contact.update({
        where: { id: existing.id },
        data: { name: normalizedName },
      });
    }

    return existing;
  }
}
