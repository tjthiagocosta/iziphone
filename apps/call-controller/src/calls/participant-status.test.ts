import { describe, expect, test } from 'vitest';
import {
  isTerminalStatus,
  normalizeCallStatus,
  participantDescription,
  participantEventType,
} from './participant-status.js';

describe('normalizeCallStatus', () => {
  test('collapses the in-progress variants', () => {
    expect(normalizeCallStatus('queued')).toBe('initiated');
    expect(normalizeCallStatus('in-progress')).toBe('answered');
    expect(normalizeCallStatus('connected')).toBe('answered');
    expect(normalizeCallStatus('no-answer')).toBe('no-answer');
  });

  test('drops statuses it does not know', () => {
    expect(normalizeCallStatus('transferring')).toBeUndefined();
  });
});

describe('isTerminalStatus', () => {
  test('only the final statuses end a leg', () => {
    expect(isTerminalStatus('ringing')).toBe(false);
    expect(isTerminalStatus('answered')).toBe(false);
    expect(isTerminalStatus('busy')).toBe(true);
    expect(isTerminalStatus('completed')).toBe(true);
  });
});

describe('participantEventType', () => {
  test('uses CALL_ events for the caller and DIAL_ events for dialed legs', () => {
    expect(participantEventType('caller', 'initiated')).toBe('CALL_INITIATED');
    expect(participantEventType('agent', 'initiated')).toBe('DIAL_INITIATED');
    expect(participantEventType('external', 'no-answer')).toBe(
      'DIAL_NO_ANSWER',
    );
    expect(participantEventType('agent', 'canceled')).toBe('CALL_CANCELED');
  });
});

describe('participantDescription', () => {
  test('names the participant by its kind', () => {
    expect(participantDescription('agent', 'user-1', 'ringing')).toBe(
      'Agent user-1 is ringing',
    );
    expect(participantDescription('external', '+15555550199', 'busy')).toBe(
      'Number +15555550199 is busy',
    );
    expect(participantDescription('caller', '+15555550101', 'completed')).toBe(
      'Caller +15555550101 completed',
    );
  });
});
