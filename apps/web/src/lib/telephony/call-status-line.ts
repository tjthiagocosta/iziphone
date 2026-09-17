import { formatDuration } from '../duration';
import type { TelephonyState } from './telephony-session';

/** What the line colours itself by; the call bar maps each to a colour. */
export type CallStatusTone =
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'held'
  | 'transferring'
  | 'ending'
  | 'over';

export interface CallStatusLine {
  text: string;
  tone: CallStatusTone;
}

type CallSnapshot = Pick<
  TelephonyState,
  'callStatus' | 'isOnHold' | 'transfer' | 'endReason'
>;

/**
 * The one line under the number in the call bar. A transfer outranks the
 * hold it implies, and a hold outranks the timer, so the agent always reads
 * the thing that explains why the other party cannot hear them.
 */
export function callStatusLine(
  call: CallSnapshot,
  durationSeconds: number,
): CallStatusLine {
  switch (call.callStatus) {
    case 'idle':
      return { text: '', tone: 'over' };
    case 'connecting':
      return { text: 'Connecting...', tone: 'connecting' };
    case 'ringing':
      return { text: 'Ringing...', tone: 'ringing' };
    case 'disconnecting':
      return { text: 'Ending...', tone: 'ending' };
    case 'disconnected':
      return {
        text:
          call.endReason === 'transferred' ? 'Call transferred' : 'Call ended',
        tone: 'over',
      };
    case 'connected':
      break;
  }

  const { transfer } = call;
  if (transfer) {
    switch (transfer.status) {
      case 'cancelling':
        return { text: 'Cancelling transfer...', tone: 'transferring' };
      case 'answered':
        return {
          text: `${transfer.targetName} answered`,
          tone: 'transferring',
        };
      default:
        return {
          text: `Transferring to ${transfer.targetName}...`,
          tone: 'transferring',
        };
    }
  }

  if (call.isOnHold) {
    return {
      text: `On hold · ${formatDuration(durationSeconds)}`,
      tone: 'held',
    };
  }
  return { text: formatDuration(durationSeconds), tone: 'connected' };
}
