'use client';

import type { CallEnded, IncomingCall } from '@repo/dto';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useCallSocket } from '@/hooks/use-call-socket';
import {
  type CallStatus,
  type DeviceStatus,
  useTelephonyClient,
} from '@/hooks/use-telephony-client';
import { useAuth } from './AuthProvider';

export interface CallContextValue {
  deviceStatus: DeviceStatus;
  callStatus: CallStatus;
  remoteNumber: string | null;
  /** Seconds since the current call connected. */
  callDuration: number;
  isMuted: boolean;
  isEndingCall: boolean;
  error: string | null;
  /** A call the controller offered this user and Twilio may be about to ring. */
  incomingCall: IncomingCall | null;
  /**
   * The call that ended most recently, for views that show call history: the
   * API writes that history from the same event, so it is the cue to refetch.
   */
  lastEndedCall: CallEnded | null;
  isSocketConnected: boolean;
  makeCall: (to: string) => Promise<void>;
  hangUp: () => void;
  sendDigits: (digits: string) => void;
  toggleMute: () => void;
  answerIncoming: () => void;
  rejectIncoming: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

/**
 * Owns the phone for the signed-in user: the Twilio device and the socket
 * over which the call controller offers calls. Calls arrive on both; the
 * socket shows the offer, and the device carries the audio.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { user, getRealtimeToken } = useAuth();
  const telephony = useTelephonyClient({
    identity: user?.id,
    getRealtimeToken,
  });
  const socket = useCallSocket({ userId: user?.id, getRealtimeToken });
  const [callDuration, setCallDuration] = useState(0);

  const { callStatus } = telephony;
  const { incomingCall, clearIncomingCall, rejectCall } = socket;

  useEffect(() => {
    if (callStatus !== 'connected') {
      setCallDuration(0);
      return;
    }
    const timer = window.setInterval(() => {
      setCallDuration((seconds) => seconds + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [callStatus]);

  // An offer the device never rang for, or that ended, must not linger.
  useEffect(() => {
    if (callStatus === 'idle' && incomingCall) {
      clearIncomingCall();
    }
  }, [callStatus, incomingCall, clearIncomingCall]);

  const answerIncoming = useCallback(() => {
    telephony.answerIncoming();
    clearIncomingCall();
  }, [telephony.answerIncoming, clearIncomingCall]);

  const rejectIncoming = useCallback(() => {
    telephony.rejectIncoming();
    if (incomingCall) {
      rejectCall(incomingCall.conversationUuid);
    }
  }, [telephony.rejectIncoming, incomingCall, rejectCall]);

  const hangUp = useCallback(() => {
    if (incomingCall) {
      rejectIncoming();
      return;
    }
    void telephony.hangUp();
  }, [incomingCall, rejectIncoming, telephony.hangUp]);

  const value: CallContextValue = {
    deviceStatus: telephony.deviceStatus,
    callStatus,
    remoteNumber: telephony.remoteNumber,
    callDuration,
    isMuted: telephony.isMuted,
    isEndingCall: telephony.isEndingCall,
    error: telephony.error,
    incomingCall,
    lastEndedCall: socket.lastEndedCall,
    isSocketConnected: socket.isConnected,
    makeCall: telephony.makeCall,
    hangUp,
    sendDigits: telephony.sendDigits,
    toggleMute: telephony.toggleMute,
    answerIncoming,
    rejectIncoming,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCall must be used within CallProvider');
  }
  return context;
}
