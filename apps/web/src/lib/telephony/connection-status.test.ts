import { describe, expect, test } from 'vitest';
import { connectionStatus } from './connection-status';

describe('connectionStatus', () => {
  test('is online only when the device and the socket are both up', () => {
    expect(connectionStatus('ready', true)).toBe('online');
    expect(connectionStatus('ready', false)).toBe('connecting');
    expect(connectionStatus('connecting', true)).toBe('connecting');
  });

  test('is connecting while either side is still coming up', () => {
    expect(connectionStatus('connecting', false)).toBe('connecting');
    expect(connectionStatus('offline', true)).toBe('connecting');
  });

  test('is offline when nothing is up or the device failed', () => {
    expect(connectionStatus('offline', false)).toBe('offline');
    expect(connectionStatus('error', true)).toBe('offline');
  });
});
