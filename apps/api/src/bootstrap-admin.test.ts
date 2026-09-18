import type { PrismaClient } from '@repo/db';
import { describe, expect, test, vi } from 'vitest';
import { AccessLinkService } from './auth/index.js';
import {
  BootstrapError,
  bootstrapAdmin,
  bootstrapReport,
  readBootstrapOptions,
} from './bootstrap-admin.js';
import { silentLogger } from './infra/index.js';
import { InMemoryMailer, type Mailer, NullMailer } from './mail/index.js';

const WEB_URL = 'https://app.example.com';

/** Records how the command used the transaction, which is where its guard lives. */
interface TransactionUse {
  options: { isolationLevel?: string } | undefined;
  countedInside: boolean;
}

function fakeDb(admins: number, use: TransactionUse = blankUse()) {
  let inTransaction = false;

  const db = {
    user: {
      count: vi.fn(async () => {
        use.countedInside = inTransaction;
        return admins;
      }),
      create: vi.fn(async ({ data }: { data: { email: string } }) => ({
        id: 'user-1',
        email: data.email,
        name: 'Administrator',
      })),
    },
    account: { create: vi.fn(async () => ({})) },
    setPasswordToken: {
      upsert: vi.fn(async () => ({})),
    },
  } as Record<string, unknown>;

  db.$transaction = async (
    run: (tx: unknown) => unknown,
    options?: { isolationLevel?: string },
  ) => {
    use.options = options;
    inTransaction = true;

    try {
      return await run(db);
    } finally {
      inTransaction = false;
    }
  };

  return db as unknown as PrismaClient;
}

function blankUse(): TransactionUse {
  return { options: undefined, countedInside: false };
}

function buildLinks(db: PrismaClient, mailer: Mailer): AccessLinkService {
  return new AccessLinkService(db, mailer, WEB_URL, silentLogger);
}

describe('bootstrapAdmin', () => {
  test('creates the first administrator with an invite and no password', async () => {
    const db = fakeDb(0);
    const mailer = new InMemoryMailer();

    const result = await bootstrapAdmin(
      db,
      buildLinks(db, mailer),
      'admin@example.com',
      'Administrator',
    );

    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          email: 'admin@example.com',
          name: 'Administrator',
          role: 'ADMIN',
        },
      }),
    );
    // A credential row with no password in it: the link is the only way in.
    expect(db.account.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        accountId: 'user-1',
        providerId: 'credential',
      },
    });
    expect(result.url.startsWith(`${WEB_URL}/set-password?token=`)).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(mailer.sent).toHaveLength(1);
  });

  test('refuses once the deployment has an administrator', async () => {
    const db = fakeDb(1);

    await expect(
      bootstrapAdmin(
        db,
        buildLinks(db, new InMemoryMailer()),
        'second@example.com',
        'Second',
      ),
    ).rejects.toBeInstanceOf(BootstrapError);
    expect(db.user.create).not.toHaveBeenCalled();
  });

  test('looks for an existing administrator inside a serializable transaction', async () => {
    const use = blankUse();
    const db = fakeDb(0, use);

    await bootstrapAdmin(
      db,
      buildLinks(db, new InMemoryMailer()),
      'admin@example.com',
      'Administrator',
    );

    // Two operators setting the deployment up at the same moment would
    // otherwise both read zero administrators and both create one.
    expect(use.countedInside).toBe(true);
    expect(use.options).toEqual({ isolationLevel: 'Serializable' });
  });

  test('still prints the link when there is no mail server', async () => {
    const db = fakeDb(0);

    const result = await bootstrapAdmin(
      db,
      buildLinks(db, new NullMailer()),
      'admin@example.com',
      'Administrator',
    );

    expect(result.emailSent).toBe(false);
    expect(result.url).toContain('/set-password?token=');
    expect(bootstrapReport(result)).toContain(result.url);
    expect(bootstrapReport(result)).toContain('pass it on yourself');
  });
});

describe('readBootstrapOptions', () => {
  test('reads the address and lowercases it', () => {
    expect(readBootstrapOptions(['--email', 'Admin@Example.com'])).toEqual({
      email: 'admin@example.com',
      name: 'Administrator',
    });
  });

  test('reads a name when one is given', () => {
    expect(
      readBootstrapOptions([
        '--email',
        'admin@example.com',
        '--name',
        'Dana Operator',
      ]),
    ).toEqual({ email: 'admin@example.com', name: 'Dana Operator' });
  });

  test.each([
    [[]],
    [['--email']],
    [['--email', 'not-an-address']],
    [['--password', 'a-fictional-passphrase']],
  ])('refuses %j with usage', (argv) => {
    expect(() => readBootstrapOptions(argv)).toThrowError(BootstrapError);
  });
});

describe('bootstrapReport', () => {
  test('names the address, the link and when it dies', () => {
    const report = bootstrapReport({
      userId: 'user-1',
      email: 'admin@example.com',
      url: `${WEB_URL}/set-password?token=a-fictional-token`,
      expiresAt: new Date('2026-09-25T12:00:00.000Z'),
      emailSent: true,
      emailError: null,
    });

    expect(report).toContain('admin@example.com');
    expect(report).toContain('a-fictional-token');
    expect(report).toContain('2026-09-25T12:00:00.000Z');
    expect(report).toContain('emailed');
  });
});
