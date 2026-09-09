'use client';

import type { IncomingCall } from '@repo/dto';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useCallSocket } from '@/hooks/useCallSocket';
import {
  type CallStatus,
  type DeviceStatus,
  useTelephonyClient,
} from '@/hooks/useTelephonyClient';
import { useAuth } from './AuthProvider';

/**
 * Call context value - provides global call state and actions
 */
interface CallContextValue {
  // Device state
  deviceStatus: DeviceStatus;
  error: string | null;

  // Call state
  callStatus: CallStatus;
  remoteNumber: string | null;
  callDuration: number;
  isMuted: boolean;
  isEndingCall: boolean;

  // Incoming call (from socket)
  incomingCall: IncomingCall | null;

  // Socket connection
  isSocketConnected: boolean;

  // Actions
  makeCall: (to: string) => Promise<void>;
  hangUp: () => void;
  sendDigits: (digits: string) => void;
  toggleMute: () => void;
  answerIncoming: () => void;
  rejectIncoming: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

/**
 * Call provider component
 * Manages the Twilio client session, socket connection, and call state globally
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { user, getToken } = useAuth();

  // Call duration timer
  const [callDuration, setCallDuration] = useState(0);

  // Remote party number
  const [remoteNumber, setRemoteNumber] = useState<string | null>(null);

  // Initialize the telephony client
  const {
    deviceStatus,
    callStatus,
    error,
    isEndingCall,
    makeCall: telephonyMakeCall,
    hangUp: telephonyHangUp,
    sendDigits,
    answerIncoming: telephonyAnswerIncoming,
    rejectIncoming: telephonyRejectIncoming,
    toggleMute,
    isMuted,
  } = useTelephonyClient({
    identity: user?.id,
    getToken,
  });

  // Initialize socket connection to call-controller
  const {
    isConnected: isSocketConnected,
    incomingCall,
    rejectCall: socketRejectCall,
    clearIncomingCall,
  } = useCallSocket(user?.id, getToken);

  // Track call duration when connected
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;

    if (callStatus === 'connected') {
      timer = setInterval(() => {
        setCallDuration((d) => d + 1);
      }, 1000);
    } else if (callStatus === 'idle' || callStatus === 'disconnected') {
      setCallDuration(0);
      setRemoteNumber(null);
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [callStatus]);

  // Clear the socket incoming state once the client-side call has fully ended.
  useEffect(() => {
    if (callStatus === 'idle' && incomingCall) {
      console.log(
        '[CallProvider] Telephony call idle, clearing socket incomingCall',
      );
      clearIncomingCall();
    }
  }, [callStatus, incomingCall, clearIncomingCall]);

  // Make an outgoing call
  const makeCall = useCallback(
    async (to: string) => {
      setRemoteNumber(to);
      await telephonyMakeCall(to);
    },
    [telephonyMakeCall],
  );

  // Hang up the current call
  const hangUp = useCallback(() => {
    void telephonyHangUp();
  }, [telephonyHangUp]);

  const sendDigitsToCall = useCallback(
    (digits: string) => {
      void sendDigits(digits);
    },
    [sendDigits],
  );

  const toggleMuteForCall = useCallback(() => {
    void toggleMute();
  }, [toggleMute]);

  // Accept incoming call
  const answerIncoming = useCallback(() => {
    if (incomingCall) {
      setRemoteNumber(incomingCall.from);
    }
    void telephonyAnswerIncoming();
    clearIncomingCall();
  }, [incomingCall, telephonyAnswerIncoming, clearIncomingCall]);

  // Reject incoming call
  const rejectIncoming = useCallback(() => {
    if (incomingCall) {
      void telephonyRejectIncoming();
      socketRejectCall(incomingCall.conversationUuid);
    }
  }, [incomingCall, telephonyRejectIncoming, socketRejectCall]);

  const value: CallContextValue = {
    // Device state
    deviceStatus,
    error,

    // Call state
    callStatus,
    remoteNumber,
    callDuration,
    isMuted,
    isEndingCall,

    // Incoming call
    incomingCall,

    // Socket
    isSocketConnected,

    // Actions
    makeCall,
    hangUp,
    sendDigits: sendDigitsToCall,
    toggleMute: toggleMuteForCall,
    answerIncoming,
    rejectIncoming,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

/**
 * Hook to access call context
 * Must be used within CallProvider
 */
export function useCall(): CallContextValue {
  const context = useContext(CallContext);

  if (!context) {
    throw new Error('useCall must be used within CallProvider');
  }

  return context;
}
