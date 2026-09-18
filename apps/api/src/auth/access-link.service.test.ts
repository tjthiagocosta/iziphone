import type { PrismaClient } from '@repo/db';
import bcrypt from 'bcryptjs';
import { describe, expect, test, vi } from 'vitest';
import { silentLogger } from '../infra/index.js';
import { InMemoryMailer, NullMailer } from '../mail/index.js';
import { hashAccessToken } from './access-link.js';
import { AccessLinkService } from './access-link.service.js';

const WEB_URL = 'https://app.example.com';

interface TokenRow {
  id: string;
  tokenHash: string;
  purpose: 'INVITE' | 'RESET';
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  issuedBy: string | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  deletedAt: Date | null;
}

interface AccountRow {
  userId: string;
  accountId: string;
  providerId: string;
  password: string | null;
}

/**
 * Enough of Postgres to exercise the rotation, the claim and the revoking: the
 * three tables this service writes, with the same uniqueness the schema has.
 */
function fakeStore(seed: {
  users?: UserRow[];
  tokens?: TokenRow[];
  accounts?: AccountRow[];
  sessions?: { id: string; userId: string }[];
}) {
  const users = [...(seed.users ?? [])];
  const tokens = [...(seed.tokens ?? [])];
  const accounts = [...(seed.accounts ?? [])];
  let sessions = [...(seed.sessions ?? [])];
  let nextId = 1;

  const matchesToken = (row: TokenRow, where: Record<string, unknown>) => {
    if ('id' in where && where.id !== row.id) return false;
    if ('tokenHash' in where && where.tokenHash !== row.tokenHash) return false;
    if ('consumedAt' in where && where.consumedAt !== row.consumedAt)
      return false;
    return true;
  };

  const withUser = (row: TokenRow) => ({
    ...row,
    user: users.find((user) => user.id === row.userId) ?? null,
  });

  const db = {
    setPasswordToken: {
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId_purpose: { userId: string; purpose: string } };
          create: Omit<TokenRow, 'id' | 'consumedAt'>;
          update: Partial<TokenRow>;
        }) => {
          const { userId, purpose } = where.userId_purpose;
          const existing = tokens.find(
            (row) => row.userId === userId && row.purpose === purpose,
          );

          if (existing) {
            Object.assign(existing, update);
            return existing;
          }

          const row: TokenRow = {
            id: `token-${nextId++}`,
            consumedAt: null,
            ...create,
          };
          tokens.push(row);
          return row;
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { tokenHash: string } }) =>
          tokens.filter((row) => matchesToken(row, where)).map(withUser)[0] ??
          null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<TokenRow>;
        }) => {
          const matched = tokens.filter((row) => matchesToken(row, where));
          for (const row of matched) {
            Object.assign(row, data);
          }
          return { count: matched.length };
        },
      ),
    },
    account: {
      create: vi.fn(async ({ data }: { data: AccountRow }) => {
        accounts.push({ ...data });
        return data;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { userId: string; providerId: string };
          data: Partial<AccountRow>;
        }) => {
          const matched = accounts.filter(
            (row) =>
              row.userId === where.userId &&
              row.providerId === where.providerId,
          );
          for (const row of matched) {
            Object.assign(row, data);
          }
          return { count: matched.length };
        },
      ),
    },
    session: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const before = sessions.length;
        sessions = sessions.filter((row) => row.userId !== where.userId);
        return { count: before - sessions.length };
      }),
    },
    user: {
      findFirst: vi.fn(
        async ({ where }: { where: { email: string; deletedAt: null } }) => {
          const user = users.find(
            (row) => row.email === where.email && row.deletedAt === null,
          );

          return user
            ? {
                ...user,
                accounts: accounts
                  .filter(
                    (row) =>
                      row.userId === user.id && row.providerId === 'credential',
                  )
                  .map((row) => ({ password: row.password })),
              }
            : null;
        },
      ),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run(db),
    ),
  };

  return {
    db: db as unknown as PrismaClient,
    tokens,
    accounts,
    sessions: () => sessions,
  };
}

function tokenFrom(url: string): string {
  const token = new URL(url).searchParams.get('token');
  if (!token) {
    throw new Error('the link carries no token');
  }
  return token;
}

const invitedUser: UserRow = {
  id: 'user-1',
  email: 'new@example.com',
  name: 'New User',
  deletedAt: null,
};

function buildService(
  store: ReturnType<typeof fakeStore>,
  mailer = new InMemoryMailer(),
) {
  return {
    mailer,
    service: new AccessLinkService(store.db, mailer, WEB_URL, silentLogger),
  };
}

describe('AccessLinkService', () => {
  test('stores only the hash of the token it puts in the link', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service } = buildService(store);

    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });
    const raw = tokenFrom(link.url);

    expect(link.url.startsWith(`${WEB_URL}/set-password?token=`)).toBe(true);
    expect(store.tokens).toHaveLength(1);
    expect(store.tokens[0]?.tokenHash).toBe(hashAccessToken(raw));
    // The secret itself is nowhere in the row.
    expect(JSON.stringify(store.tokens[0])).not.toContain(raw);
  });

  test('a second link for the same purpose kills the first', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service } = buildService(store);

    const first = await service.issue({ userId: 'user-1', purpose: 'INVITE' });
    const second = await service.issue({ userId: 'user-1', purpose: 'INVITE' });

    expect(store.tokens).toHaveLength(1);
    expect(tokenFrom(second.url)).not.toBe(tokenFrom(first.url));
    expect((await service.describe(tokenFrom(first.url))).valid).toBe(false);
    expect((await service.describe(tokenFrom(second.url))).valid).toBe(true);
  });

  test('a reset link and an invite link can be outstanding at once', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service } = buildService(store);

    const invite = await service.issue({ userId: 'user-1', purpose: 'INVITE' });
    const reset = await service.issue({ userId: 'user-1', purpose: 'RESET' });

    expect(store.tokens).toHaveLength(2);
    expect((await service.describe(tokenFrom(invite.url))).purpose).toBe(
      'INVITE',
    );
    expect((await service.describe(tokenFrom(reset.url))).purpose).toBe(
      'RESET',
    );
  });

  test('a reset runs out in an hour and an invite in a week', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service } = buildService(store);
    const now = new Date('2026-09-18T12:00:00.000Z');

    const invite = await service.issue({
      userId: 'user-1',
      purpose: 'INVITE',
      now,
    });
    const reset = await service.issue({
      userId: 'user-1',
      purpose: 'RESET',
      now,
    });

    expect(invite.expiresAt.toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(reset.expiresAt.toISOString()).toBe('2026-09-18T13:00:00.000Z');
  });

  test('sets the password, spends the link and signs every device out', async () => {
    const store = fakeStore({
      users: [invitedUser],
      accounts: [
        {
          userId: 'user-1',
          accountId: 'user-1',
          providerId: 'credential',
          password: null,
        },
      ],
      sessions: [
        { id: 'session-1', userId: 'user-1' },
        { id: 'session-2', userId: 'user-2' },
      ],
    });
    const { service } = buildService(store);
    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });

    const result = await service.consume({
      token: tokenFrom(link.url),
      password: 'a-fictional-passphrase',
    });

    expect(result).toEqual({ ok: true, email: 'new@example.com' });
    expect(
      await bcrypt.compare(
        'a-fictional-passphrase',
        store.accounts[0]?.password ?? '',
      ),
    ).toBe(true);
    expect(store.tokens[0]?.consumedAt).toBeInstanceOf(Date);
    // Only this user's sessions; somebody else's stay.
    expect(store.sessions().map((row) => row.id)).toEqual(['session-2']);
  });

  test('repairs a credential an older admin screen keyed by email', async () => {
    const store = fakeStore({
      users: [invitedUser],
      accounts: [
        {
          userId: 'user-1',
          accountId: 'new@example.com',
          providerId: 'credential',
          password: null,
        },
      ],
    });
    const { service } = buildService(store);
    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });

    await service.consume({
      token: tokenFrom(link.url),
      password: 'a-fictional-passphrase',
    });

    // Better Auth looks the credential up by the user's id, not their address.
    expect(store.accounts[0]?.accountId).toBe('user-1');
  });

  test('creates the credential when the user has none', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service } = buildService(store);
    const link = await service.issue({ userId: 'user-1', purpose: 'RESET' });

    await service.consume({
      token: tokenFrom(link.url),
      password: 'a-fictional-passphrase',
    });

    expect(store.accounts).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        accountId: 'user-1',
        providerId: 'credential',
      }),
    ]);
  });

  test('refuses a link that has already been spent, without touching the password', async () => {
    const store = fakeStore({
      users: [invitedUser],
      accounts: [
        {
          userId: 'user-1',
          accountId: 'user-1',
          providerId: 'credential',
          password: null,
        },
      ],
    });
    const { service } = buildService(store);
    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });
    const token = tokenFrom(link.url);

    await service.consume({ token, password: 'a-fictional-passphrase' });
    const firstHash = store.accounts[0]?.password;

    const second = await service.consume({
      token,
      password: 'a-different-passphrase',
    });

    expect(second).toMatchObject({ ok: false });
    expect(store.accounts[0]?.password).toBe(firstHash);
  });

  test('the loser of a simultaneous submission changes nothing', async () => {
    const store = fakeStore({
      users: [invitedUser],
      accounts: [
        {
          userId: 'user-1',
          accountId: 'user-1',
          providerId: 'credential',
          password: null,
        },
      ],
    });
    const { service } = buildService(store);
    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });
    const token = tokenFrom(link.url);

    const [first, second] = await Promise.all([
      service.consume({ token, password: 'the-first-passphrase' }),
      service.consume({ token, password: 'the-second-passphrase' }),
    ]);

    // One of them wins; both cannot.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const winner = first.ok ? 'the-first-passphrase' : 'the-second-passphrase';
    expect(
      await bcrypt.compare(winner, store.accounts[0]?.password ?? ''),
    ).toBe(true);
  });

  test('refuses an expired link', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service } = buildService(store);
    const issued = new Date('2026-09-18T12:00:00.000Z');
    const link = await service.issue({
      userId: 'user-1',
      purpose: 'RESET',
      now: issued,
    });
    const tooLate = new Date('2026-09-18T13:00:01.000Z');

    expect(await service.describe(tokenFrom(link.url), tooLate)).toMatchObject({
      valid: false,
      purpose: null,
    });
    expect(
      await service.consume(
        { token: tokenFrom(link.url), password: 'a-fictional-passphrase' },
        tooLate,
      ),
    ).toMatchObject({ ok: false });
    expect(store.accounts).toHaveLength(0);
  });

  test("refuses a deleted user's outstanding link", async () => {
    const store = fakeStore({
      users: [{ ...invitedUser, deletedAt: new Date('2026-09-18T00:00:00Z') }],
    });
    const { service } = buildService(store);
    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });

    expect(
      await service.consume({
        token: tokenFrom(link.url),
        password: 'a-fictional-passphrase',
      }),
    ).toMatchObject({ ok: false });
    expect(store.accounts).toHaveLength(0);
  });

  test('says the same thing about an unknown token as about a deleted account', async () => {
    const store = fakeStore({
      users: [{ ...invitedUser, deletedAt: new Date('2026-09-18T00:00:00Z') }],
    });
    const { service } = buildService(store);
    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });

    const deleted = await service.describe(tokenFrom(link.url));
    const unknown = await service.describe('not-a-real-token');

    expect(deleted.message).toBe(unknown.message);
  });

  test('emails the link and reports that it went out', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service, mailer } = buildService(store);

    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });
    const delivered = await service.deliver(link, {
      email: 'new@example.com',
      name: 'New User',
    });

    expect(delivered).toMatchObject({
      purpose: 'INVITE',
      url: link.url,
      emailSent: true,
      emailError: null,
    });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('new@example.com');
    expect(mailer.sent[0]?.text).toContain(link.url);
  });

  test('still hands back the link when there is no mail server', async () => {
    const store = fakeStore({ users: [invitedUser] });
    const { service } = buildService(store, new NullMailer());

    const link = await service.issue({ userId: 'user-1', purpose: 'INVITE' });
    const delivered = await service.deliver(link, {
      email: 'new@example.com',
      name: null,
    });

    expect(delivered.url).toBe(link.url);
    expect(delivered.emailSent).toBe(false);
    expect(delivered.emailError).toBeTruthy();
  });

  test('a forgotten password mails a reset to a user who has one', async () => {
    const store = fakeStore({
      users: [invitedUser],
      accounts: [
        {
          userId: 'user-1',
          accountId: 'user-1',
          providerId: 'credential',
          password: 'an-existing-bcrypt-hash',
        },
      ],
    });
    const { service, mailer } = buildService(store);

    await service.requestReset('new@example.com');

    expect(store.tokens).toHaveLength(1);
    expect(store.tokens[0]?.purpose).toBe('RESET');
    // Nobody asked an admin for it, so it is recorded as self-service.
    expect(store.tokens[0]?.issuedBy).toBeNull();
    expect(mailer.sent).toHaveLength(1);
  });

  test('a forgotten password issues nothing for an address with no account', async () => {
    const store = fakeStore({ users: [] });
    const { service, mailer } = buildService(store);

    await service.requestReset('stranger@example.com');

    expect(store.tokens).toHaveLength(0);
    expect(mailer.sent).toHaveLength(0);
  });

  test('a forgotten password issues nothing for a user who never set one', async () => {
    const store = fakeStore({
      users: [invitedUser],
      accounts: [
        {
          userId: 'user-1',
          accountId: 'user-1',
          providerId: 'credential',
          password: null,
        },
      ],
    });
    const { service, mailer } = buildService(store);

    // Only an admin can invite: a reset would let a stranger who knows the
    // address finish an invite that was never sent to them.
    await service.requestReset('new@example.com');

    expect(store.tokens).toHaveLength(0);
    expect(mailer.sent).toHaveLength(0);
  });

  test('a forgotten password issues nothing for a deleted user', async () => {
    const store = fakeStore({
      users: [{ ...invitedUser, deletedAt: new Date('2026-09-18T00:00:00Z') }],
      accounts: [
        {
          userId: 'user-1',
          accountId: 'user-1',
          providerId: 'credential',
          password: 'an-existing-bcrypt-hash',
        },
      ],
    });
    const { service, mailer } = buildService(store);

    await service.requestReset('new@example.com');

    expect(store.tokens).toHaveLength(0);
    expect(mailer.sent).toHaveLength(0);
  });
});
