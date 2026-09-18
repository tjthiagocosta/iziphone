import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import { createApiRouteApp } from '../test/route-test-helpers.js';
import { adminSettingsRoutes } from './settings.routes.js';

const admin: AuthUser = {
  id: 'user-1',
  email: 'admin@example.com',
  name: 'Admin One',
  role: 'ADMIN',
  emailVerified: true,
};

const updatedAt = new Date('2026-09-18T09:30:00.000Z');

const stored = {
  voicemailRetention: 'DAYS_90' as const,
  callRecordingRetention: 'YEARS_1' as const,
  updatedAt,
};

describe('adminSettingsRoutes', () => {
  let app: FastifyInstance;

  const findUnique = vi.fn(async (): Promise<unknown> => null);
  const upsert = vi.fn(async () => stored);
  const createAuditEntry = vi.fn(async () => ({ id: 'audit-1' }));

  /** The settings routes as `adminApiRoutes` composes them: ADMIN only. */
  const guardedSettingsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', fastify.requireRole(['ADMIN']));
    await fastify.register(adminSettingsRoutes);
  };

  async function buildApp(user: AuthUser | null = admin) {
    const db = {
      systemSettings: { findUnique, upsert },
      auditLog: { create: createAuditEntry },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
        run(db),
      ),
    };

    return createApiRouteApp(guardedSettingsRoutes, {
      user,
      db: db as never,
    });
  }

  function save(body: unknown) {
    return app.inject({
      method: 'PUT',
      url: '/recording-retention',
      payload: body,
    });
  }

  beforeEach(async () => {
    findUnique.mockResolvedValue(null);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  test('answers the defaults before anybody has changed anything', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      recordingRetention: {
        voicemail: 'KEEP_UNTIL_DELETED',
        callRecordings: 'KEEP_UNTIL_DELETED',
      },
      updatedAt: null,
    });
  });

  test('answers what an admin saved, and when', async () => {
    findUnique.mockResolvedValue(stored);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.json()).toEqual({
      recordingRetention: { voicemail: 'DAYS_90', callRecordings: 'YEARS_1' },
      updatedAt: updatedAt.toISOString(),
    });
  });

  test('saves both policies and answers the settings as stored', async () => {
    const response = await save({
      voicemail: 'DAYS_90',
      callRecordings: 'YEARS_1',
    });

    expect(response.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'system' },
        create: expect.objectContaining({
          voicemailRetention: 'DAYS_90',
          callRecordingRetention: 'YEARS_1',
        }),
        update: {
          voicemailRetention: 'DAYS_90',
          callRecordingRetention: 'YEARS_1',
        },
      }),
    );
    expect(response.json()).toEqual({
      recordingRetention: { voicemail: 'DAYS_90', callRecordings: 'YEARS_1' },
      updatedAt: updatedAt.toISOString(),
    });
  });

  test('records who shortened the policy, and what it was before', async () => {
    findUnique.mockResolvedValue({
      voicemailRetention: 'YEARS_7',
      callRecordingRetention: 'YEARS_7',
      updatedAt,
    });

    await save({ voicemail: 'DAYS_30', callRecordings: 'DAYS_30' });

    expect(createAuditEntry).toHaveBeenCalledTimes(1);
    expect(createAuditEntry).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'settings.recording_retention_updated',
        entityType: 'SystemSettings',
        entityId: 'system',
        userId: 'user-1',
        changes: {
          from: { voicemail: 'YEARS_7', callRecordings: 'YEARS_7' },
          to: { voicemail: 'DAYS_30', callRecordings: 'DAYS_30' },
        },
      }),
    });
  });

  test('records the defaults as what the first change replaced', async () => {
    await save({ voicemail: 'DAYS_30', callRecordings: 'DAYS_30' });

    expect(createAuditEntry).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changes: expect.objectContaining({
          from: {
            voicemail: 'KEEP_UNTIL_DELETED',
            callRecordings: 'KEEP_UNTIL_DELETED',
          },
        }),
      }),
    });
  });

  test.each([
    {
      name: 'a policy that is not offered',
      body: { voicemail: 'DAYS_45', callRecordings: 'DAYS_30' },
    },
    {
      name: 'a plain number of days',
      body: { voicemail: 45, callRecordings: 'DAYS_30' },
    },
    { name: 'only one of the two policies', body: { voicemail: 'DAYS_30' } },
    { name: 'nothing at all', body: {} },
  ])('refuses $name, and writes nothing', async ({ body }) => {
    const response = await save(body);

    expect(response.statusCode).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    expect(createAuditEntry).not.toHaveBeenCalled();
  });

  test.each([
    { name: 'an agent', role: 'AGENT' as const },
    { name: 'a supervisor', role: 'SUPERVISOR' as const },
  ])(
    'refuses $name, who cannot read or change the settings',
    async ({ role }) => {
      await app.close();
      app = await buildApp({ ...admin, role });

      const read = await app.inject({ method: 'GET', url: '/' });
      const write = await save({
        voicemail: 'DAYS_30',
        callRecordings: 'DAYS_30',
      });

      expect(read.statusCode).toBe(403);
      expect(write.statusCode).toBe(403);
      expect(findUnique).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  test('refuses a signed-out request', async () => {
    await app.close();
    app = await buildApp(null);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
