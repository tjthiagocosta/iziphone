'use client';

import { Device } from '@twilio/voice-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchVoiceToken, requestHangup } from '@/lib/api/call-controller';
import {
  INITIAL_TELEPHONY_STATE,
  TelephonySession,
  type TelephonyState,
} from '@/lib/telephony/telephony-session';

export type {
  CallStatus,
  DeviceStatus,
  TelephonyState,
} from '@/lib/telephony/telephony-session';

export interface TelephonyClientOptions {
  /** The user id, which is also the Twilio client identity. Absent while signed out. */
  identity: string | undefined;
  getRealtimeToken: () => Promise<string>;
}

export interface TelephonyClient extends TelephonyState {
  makeCall: (to: string) => Promise<void>;
  hangUp: () => Promise<void>;
  answerIncoming: () => void;
  rejectIncoming: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
}

async function requestMicrophone(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/** Runs a telephony session for the signed-in user and mirrors its state into React. */
export function useTelephonyClient({
  identity,
  getRealtimeToken,
}: TelephonyClientOptions): TelephonyClient {
  const [state, setState] = useState<TelephonyState>(INITIAL_TELEPHONY_STATE);
  const sessionRef = useRef<TelephonySession | null>(null);
  const getRealtimeTokenRef = useRef(getRealtimeToken);

  useEffect(() => {
    getRealtimeTokenRef.current = getRealtimeToken;
  }, [getRealtimeToken]);

  useEffect(() => {
    if (!identity) {
      setState(INITIAL_TELEPHONY_STATE);
      return;
    }

    const session = new TelephonySession(
      {
        requestMicrophone,
        fetchVoiceToken: async () =>
          fetchVoiceToken(await getRealtimeTokenRef.current()),
        requestHangup: async (legSid) =>
          requestHangup(await getRealtimeTokenRef.current(), legSid),
        createDevice: (token) =>
          new Device(token, {
            closeProtection: true,
            logLevel: 'error',
            tokenRefreshMs: 30_000,
          }),
      },
      setState,
    );
    sessionRef.current = session;
    void session.start();

    return () => {
      session.dispose();
      sessionRef.current = null;
      setState(INITIAL_TELEPHONY_STATE);
    };
  }, [identity]);

  const makeCall = useCallback(
    (to: string) => sessionRef.current?.makeCall(to) ?? Promise.resolve(),
    [],
  );
  const hangUp = useCallback(
    () => sessionRef.current?.hangUp() ?? Promise.resolve(),
    [],
  );
  const answerIncoming = useCallback(() => {
    sessionRef.current?.answerIncoming();
  }, []);
  const rejectIncoming = useCallback(() => {
    sessionRef.current?.rejectIncoming();
  }, []);
  const toggleMute = useCallback(() => {
    sessionRef.current?.toggleMute();
  }, []);
  const sendDigits = useCallback((digits: string) => {
    sessionRef.current?.sendDigits(digits);
  }, []);

  return {
    ...state,
    makeCall,
    hangUp,
    answerIncoming,
    rejectIncoming,
    toggleMute,
    sendDigits,
  };
}
