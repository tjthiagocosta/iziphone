import { describe, expect, test } from 'vitest';
import {
  copyPlan,
  playbackSource,
  recordingContextOf,
  recordingEventType,
  recordingObjectKey,
} from './recording-copy.js';

const key = 'recordings/conv-1/REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp3';
const deletedAt = new Date('2026-03-20T10:05:00.000Z');

/** A recording nobody has deleted; the whereabouts under test are the rest. */
const kept = { deletedAt: null, deletionReason: null } as const;

const announced = { ...kept, objectKey: null, providerDeletedAt: null };
const copied = { ...kept, objectKey: key, providerDeletedAt: null };
const settled = { ...kept, objectKey: key, providerDeletedAt: deletedAt };
const lost = { ...kept, objectKey: null, providerDeletedAt: deletedAt };

/** Swept by the retention policy: the copy is gone and Twilio's was deleted. */
const swept = {
  objectKey: null,
  providerDeletedAt: deletedAt,
  deletedAt,
  deletionReason: 'RETENTION_POLICY',
} as const;

describe('playbackSource', () => {
  test('plays a copy from the store', () => {
    expect(playbackSource(copied)).toEqual({ source: 'store', key });
    expect(playbackSource(settled)).toEqual({ source: 'store', key });
  });

  test('falls back to Twilio while no copy exists and Twilio still has it', () => {
    expect(playbackSource(announced)).toEqual({ source: 'provider' });
  });

  test('has nothing to play once Twilio no longer has it and no copy exists', () => {
    expect(playbackSource(lost)).toEqual({ source: 'gone' });
  });

  test('tells a deleted recording apart from a lost one, with its reason', () => {
    expect(playbackSource(swept)).toEqual({
      source: 'deleted',
      reason: 'RETENTION_POLICY',
    });
    expect(playbackSource({ ...swept, deletionReason: 'MANUAL' })).toEqual({
      source: 'deleted',
      reason: 'MANUAL',
    });
  });

  test('plays nothing from a store copy the deletion has not yet cleared', () => {
    expect(playbackSource({ ...swept, objectKey: key })).toEqual({
      source: 'deleted',
      reason: 'RETENTION_POLICY',
    });
  });
});

describe('copyPlan', () => {
  test('fetches a recording that has no copy yet', () => {
    expect(copyPlan(announced)).toEqual({ copy: 'fetch' });
  });

  test('owes only the deletion once the copy exists', () => {
    expect(copyPlan(copied)).toEqual({ copy: 'skip', deleteAtProvider: true });
  });

  test('has nothing to do for a recording copied and deleted', () => {
    expect(copyPlan(settled)).toEqual({
      copy: 'skip',
      deleteAtProvider: false,
    });
  });

  test('does not fetch what Twilio no longer has', () => {
    expect(copyPlan(lost)).toEqual({ copy: 'skip', deleteAtProvider: false });
  });

  test('never fetches a deleted recording', () => {
    expect(copyPlan(swept)).toEqual({ copy: 'skip', deleteAtProvider: false });
  });

  test('still owes Twilio the deletion of a recording deleted before it was copied', () => {
    expect(
      copyPlan({ ...swept, providerDeletedAt: null, deletionReason: 'MANUAL' }),
    ).toEqual({ copy: 'skip', deleteAtProvider: true });
  });
});

describe('recordingObjectKey', () => {
  test('files the MP3 under the conversation and the recording', () => {
    expect(
      recordingObjectKey('conv-1', 'REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    ).toBe(key);
  });
});

describe('recordingContextOf', () => {
  test.each([
    { context: 'voicemail', expected: 'VOICEMAIL' },
    { context: undefined, expected: 'VOICEMAIL' },
    { context: 'conference', expected: 'CONFERENCE' },
    { context: 'call', expected: 'CONFERENCE' },
  ])('reads $context as $expected', ({ context, expected }) => {
    expect(recordingContextOf(context)).toBe(expected);
  });
});

describe('recordingEventType', () => {
  test('a voicemail completes the voicemail, a conference the recording', () => {
    expect(recordingEventType('VOICEMAIL')).toBe('VOICEMAIL_COMPLETED');
    expect(recordingEventType('CONFERENCE')).toBe('RECORDING_COMPLETED');
  });
});
