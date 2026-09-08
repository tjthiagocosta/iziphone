import {
  ClosedHoursRoutingTypeSchema,
  MessageChannelSchema,
  MessageDirectionSchema,
  MessageStatusSchema,
  OpenHoursRoutingTypeSchema,
  PhoneNumberStatusSchema,
  PhoneNumberTypeSchema,
  RoleSchema,
  TelephonyProviderSchema,
} from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  ClosedHoursRouting,
  createPrismaClient,
  MessageChannel,
  MessageDirection,
  MessageStatus,
  PhoneNumberStatus,
  PhoneNumberType,
  Role,
  RoutingType,
  TelephonyProvider,
} from './index.js';

const connectionString =
  'postgresql://iziphone:not-a-real-password@db.example.com:5432/iziphone';

describe('createPrismaClient', () => {
  test('builds a client without opening a connection', async () => {
    const client = createPrismaClient({ connectionString });

    expect(client.user).toBeDefined();
    await expect(client.$disconnect()).resolves.toBeUndefined();
  });

  test('accepts explicit log levels', async () => {
    const client = createPrismaClient({
      connectionString,
      log: ['warn', 'error'],
    });

    await expect(client.$disconnect()).resolves.toBeUndefined();
  });
});

/*
 * The shared contracts in @repo/dto mirror these enums by hand because the
 * database package must not depend on them at runtime. This pins the two
 * sides together so a schema change cannot silently drift from the API.
 */
describe('schema enums match the shared contracts', () => {
  test.each([
    ['Role', Role, RoleSchema.options],
    ['PhoneNumberType', PhoneNumberType, PhoneNumberTypeSchema.options],
    ['PhoneNumberStatus', PhoneNumberStatus, PhoneNumberStatusSchema.options],
    ['TelephonyProvider', TelephonyProvider, TelephonyProviderSchema.options],
    ['RoutingType', RoutingType, OpenHoursRoutingTypeSchema.options],
    [
      'ClosedHoursRouting',
      ClosedHoursRouting,
      ClosedHoursRoutingTypeSchema.options,
    ],
    ['MessageDirection', MessageDirection, MessageDirectionSchema.options],
    ['MessageChannel', MessageChannel, MessageChannelSchema.options],
    ['MessageStatus', MessageStatus, MessageStatusSchema.options],
  ])('%s', (_name, schemaEnum, contractValues) => {
    expect([...Object.values(schemaEnum)].sort()).toEqual(
      [...contractValues].sort(),
    );
  });
});
