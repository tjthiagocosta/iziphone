import type { DeviceStatus } from './telephony-session';

export type ConnectionStatus = 'online' | 'connecting' | 'offline';

/**
 * The phone can take calls only when the socket delivers the offer and the
 * device carries the audio, so both have to be up to show green.
 */
export function connectionStatus(
  deviceStatus: DeviceStatus,
  isSocketConnected: boolean,
): ConnectionStatus {
  if (deviceStatus === 'ready' && isSocketConnected) {
    return 'online';
  }
  if (deviceStatus === 'error') {
    return 'offline';
  }
  if (deviceStatus !== 'offline' || isSocketConnected) {
    return 'connecting';
  }
  return 'offline';
}
