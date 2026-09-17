import type { Role } from '../common/domain.js';
import type {
  AuthRefresh,
  AuthRefreshed,
  CallAccepted,
  CallEnded,
  CallRejected,
  CallTransferOutcome,
  IncomingCall,
  SocketError,
  UserSocketRegistration,
} from './payloads.js';

/*
 * Typed event maps for `socket.io` (server) and `socket.io-client` (browser).
 * Event names are the wire protocol: renaming one is a breaking change for
 * every connected softphone.
 */

export interface ServerToClientEvents {
  incoming_call: (data: IncomingCall) => void;
  call_ended: (data: CallEnded) => void;
  call_transfer_outcome: (data: CallTransferOutcome) => void;
  'auth:refreshed': (data: AuthRefreshed) => void;
  error: (data: SocketError) => void;
}

export interface ClientToServerEvents {
  register_user: (data: UserSocketRegistration) => void;
  call_accept: (data: CallAccepted) => void;
  call_reject: (data: CallRejected) => void;
  'auth:refresh': (data: AuthRefresh) => void;
}

/** No server-to-server events are defined; the Redis adapter handles fan-out. */
export type InterServerEvents = Record<never, never>;

/** Attached to every authenticated socket by the call controller. */
export interface SocketData {
  userId: string;
  email: string;
  role: Role;
  connectedAt: string;
}
