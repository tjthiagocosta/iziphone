import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { EmailSchema } from '@repo/dto';
import { config as loadDotenv } from 'dotenv';
import { AccessLinkService } from './auth/index.js';
import { type ApiConfig, loadApiConfig } from './config.js';
import { silentLogger } from './infra/index.js';
import { createSmtpMailer, type Mailer, NullMailer } from './mail/index.js';

/*
 * The one way a deployment gets its first administrator. Sign-up is closed and
 * there is no seed data, so this creates one ADMIN with no password and prints
 * the invite link that lets them choose one. It is not a seed script: it takes
 * no password, it creates nobody else, and it refuses once an administrator
 * exists, because from then on the admin console is the way in.
 *
 *   pnpm --filter @repo/api bootstrap-admin --email admin@example.com
 *
 * In a container, where the sources are not present:
 *
 *   node dist/bootstrap-admin.js --email admin@example.com
 */

export interface BootstrapResult {
  userId: string;
  email: string;
  url: string;
  expiresAt: Date;
  emailSent: boolean;
  emailError: string | null;
}

export class BootstrapError extends Error {}

/**
 * Creates the first ADMIN and issues their invite.
 *
 * @throws BootstrapError when an administrator already exists.
 */
export async function bootstrapAdmin(
  db: PrismaClient,
  accessLinks: AccessLinkService,
  email: string,
  name: string,
): Promise<BootstrapResult> {
  const { user, link } = await db.$transaction(
    async (tx) => {
      /*
       * Counted inside the transaction, and at the strictest isolation level,
       * because "there is no administrator yet" is the whole permission this
       * command runs on: two operators setting the deployment up at the same
       * time must not each get one. The second transaction is rolled back
       * instead of adding a second administrator nobody decided to create.
       */
      const existing = await tx.user.count({
        where: { role: 'ADMIN', deletedAt: null },
      });

      if (existing > 0) {
        throw new BootstrapError(
          'This deployment already has an administrator. Invite further users from the admin console.',
        );
      }

      const created = await tx.user.create({
        data: { email, name, role: 'ADMIN' },
        select: { id: true, email: true, name: true },
      });

      // Same shape as an invited user: a credential with no password in it.
      await tx.account.create({
        data: {
          userId: created.id,
          accountId: created.id,
          providerId: 'credential',
        },
      });

      return {
        user: created,
        link: await accessLinks.issueIn(tx, {
          userId: created.id,
          purpose: 'INVITE',
        }),
      };
    },
    { isolationLevel: 'Serializable' },
  );

  const delivered = await accessLinks.deliver(link, {
    email: user.email,
    name: user.name,
  });

  return {
    userId: user.id,
    email: user.email,
    url: delivered.url,
    expiresAt: link.expiresAt,
    emailSent: delivered.emailSent,
    emailError: delivered.emailError,
  };
}

/** What the command was asked to do, or a usage error. */
export function readBootstrapOptions(argv: readonly string[]): {
  email: string;
  name: string;
} {
  let email: string | undefined;
  let name: string | undefined;

  try {
    ({
      values: { email, name },
    } = parseArgs({
      args: [...argv],
      options: { email: { type: 'string' }, name: { type: 'string' } },
    }));
  } catch {
    throw new BootstrapError(USAGE);
  }

  const parsed = EmailSchema.safeParse(email ?? '');

  if (!parsed.success) {
    throw new BootstrapError(USAGE);
  }

  return { email: parsed.data, name: name?.trim() || 'Administrator' };
}

const USAGE = 'Usage: bootstrap-admin --email <address> [--name "<full name>"]';

/** What the command prints, given what it did. */
export function bootstrapReport(result: BootstrapResult): string {
  return `${[
    `Administrator created: ${result.email}`,
    '',
    'Open this link to choose a password:',
    result.url,
    '',
    `The link works once and expires at ${result.expiresAt.toISOString()}.`,
    result.emailSent
      ? 'It was also emailed to that address.'
      : `It was not emailed (${result.emailError ?? 'unknown reason'}), so pass it on yourself.`,
  ].join('\n')}\n`;
}

function createMailer(config: ApiConfig): Mailer {
  // Silent: this command prints a link, and log lines around it would only
  // make that harder to find or to copy.
  return config.mail
    ? createSmtpMailer(config.mail, silentLogger)
    : new NullMailer();
}

async function main(): Promise<void> {
  loadDotenv({
    path: fileURLToPath(new URL('../../../.env', import.meta.url)),
    quiet: true,
  });

  const { email, name } = readBootstrapOptions(process.argv.slice(2));
  const config = loadApiConfig(process.env);
  const db = createPrismaClient({ connectionString: config.databaseUrl });

  try {
    const result = await bootstrapAdmin(
      db,
      new AccessLinkService(
        db,
        createMailer(config),
        config.webUrl,
        silentLogger,
      ),
      email,
      name,
    );

    process.stdout.write(bootstrapReport(result));
  } finally {
    await db.$disconnect();
  }
}

// Only when run as a command: importing this file for its tests must not act.
const invokedAs = process.argv[1];

if (invokedAs && import.meta.url === pathToFileURL(invokedAs).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
