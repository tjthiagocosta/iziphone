'use client';

import type { CallTransferOutcome } from '@repo/dto';
import { Device } from '@twilio/voice-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchVoiceToken,
  requestHangup,
  requestHold,
  requestOutboundGrant,
  requestTransfer,
  requestTransferCancel,
} from '@/lib/api/call-controller';
import {
  INITIAL_TELEPHONY_STATE,
  TelephonySession,
  type TelephonyState,
  type TransferTarget,
} from '@/lib/telephony/telephony-session';

export type {
  CallEndReason,
  CallStatus,
  DeviceStatus,
  TelephonyState,
  TransferProgress,
  TransferTarget,
} from '@/lib/telephony/telephony-session';

export interface TelephonyClientOptions {
  /** The user id, which is also the Twilio client identity. Absent while signed out. */
  identity: string | undefined;
  getRealtimeToken: () => Promise<string>;
}

export interface TelephonyClient extends TelephonyState {
  /** Dials `to` from `line`, the E.164 number of one of the user's lines. */
  makeCall: (to: string, line: string) => Promise<void>;
  hangUp: () => Promise<void>;
  answerIncoming: () => void;
  rejectIncoming: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
  toggleHold: () => Promise<void>;
  transferTo: (target: TransferTarget) => Promise<void>;
  cancelTransfer: () => Promise<void>;
  applyTransferOutcome: (outcome: CallTransferOutcome) => void;
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
        requestOutboundGrant: async (to, line) =>
          requestOutboundGrant(await getRealtimeTokenRef.current(), to, line),
        requestHangup: async (legSid) =>
          requestHangup(await getRealtimeTokenRef.current(), legSid),
        requestHold: async (legSid, hold) =>
          requestHold(await getRealtimeTokenRef.current(), legSid, hold),
        requestTransfer: async (legSid, targetUserId) =>
          requestTransfer(
            await getRealtimeTokenRef.current(),
            legSid,
            targetUserId,
          ),
        requestTransferCancel: async (legSid) =>
          requestTransferCancel(await getRealtimeTokenRef.current(), legSid),
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
    (to: string, line: string) =>
      sessionRef.current?.makeCall(to, line) ?? Promise.resolve(),
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
  const toggleHold = useCallback(
    () => sessionRef.current?.toggleHold() ?? Promise.resolve(),
    [],
  );
  const transferTo = useCallback(
    (target: TransferTarget) =>
      sessionRef.current?.transferTo(target) ?? Promise.resolve(),
    [],
  );
  const cancelTransfer = useCallback(
    () => sessionRef.current?.cancelTransfer() ?? Promise.resolve(),
    [],
  );
  const applyTransferOutcome = useCallback((outcome: CallTransferOutcome) => {
    sessionRef.current?.applyTransferOutcome(outcome);
  }, []);

  return {
    ...state,
    makeCall,
    hangUp,
    answerIncoming,
    rejectIncoming,
    toggleMute,
    sendDigits,
    toggleHold,
    transferTo,
    cancelTransfer,
    applyTransferOutcome,
  };
}
