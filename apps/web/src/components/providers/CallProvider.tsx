'use client';

import type { CallEnded, IncomingCall, Teammate } from '@repo/dto';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useCallLines } from '@/hooks/use-call-lines';
import { useCallSocket } from '@/hooks/use-call-socket';
import { useTeammates } from '@/hooks/use-teammates';
import {
  type CallEndReason,
  type CallStatus,
  type DeviceStatus,
  type TransferProgress,
  type TransferTarget,
  useTelephonyClient,
} from '@/hooks/use-telephony-client';
import {
  type CallLineChoice,
  type CallLines,
  chosenLineIdFor,
} from '@/lib/telephony/call-line';
import {
  type EarlyAnswer,
  earlyAnswerOf,
  NO_OFFER_MEMORY,
  OFFER_EXPIRY_MS,
  offerFate,
} from '@/lib/telephony/incoming-offer';
import { PENDING_ANSWER_TTL_MS } from '@/lib/telephony/telephony-session';
import { transferredByName } from '@/lib/telephony/transfer-offer';
import { useAuth } from './AuthProvider';

export interface CallContextValue {
  deviceStatus: DeviceStatus;
  callStatus: CallStatus;
  remoteNumber: string | null;
  /** Seconds since the current call connected. */
  callDuration: number;
  isMuted: boolean;
  /** The other party hears the hold audio; the two cannot hear each other. */
  isOnHold: boolean;
  isHoldPending: boolean;
  /** The transfer this user started and is still on the line for. */
  transfer: TransferProgress | null;
  /** Why the last transfer did not go through. */
  notice: string | null;
  isEndingCall: boolean;
  /** How the call that just finished ended. */
  endReason: CallEndReason;
  error: string | null;
  /** A call the controller offered this user and Twilio may be about to ring. */
  incomingCall: IncomingCall | null;
  /** What an Answer pressed before the device rang has come to, if one was. */
  earlyAnswer: EarlyAnswer | null;
  /** The teammate handing the offered call over, when it is a transfer. */
  incomingCallTransferredBy: string | null;
  /** Everyone a call can be handed to; it does not say who is online. */
  teammates: Teammate[];
  teammatesError: Error | null;
  refreshTeammates: () => Promise<void>;
  /**
   * The call that ended most recently, for views that show call history: the
   * API writes that history from the same event, so it is the cue to refetch.
   */
  lastEndedCall: CallEnded | null;
  isSocketConnected: boolean;
  /** The user's numbers a call may leave from; see `lib/telephony/call-line`. */
  callLines: CallLines;
  /** Asks the API for the lines again; see `useCallLines`. */
  reloadCallLines: () => void;
  /**
   * The line the user picked for calls that no conversation ties to a line,
   * shared by every picker so the dialer and the contacts list agree. Null
   * until they pick one, which means the default line.
   */
  chosenCallLineId: string | null;
  chooseCallLine: (lineId: string) => void;
  /** Dials `to` from `line`, the E.164 number of one of `callLines`. */
  makeCall: (to: string, line: string) => Promise<void>;
  hangUp: () => void;
  sendDigits: (digits: string) => void;
  toggleMute: () => void;
  toggleHold: () => void;
  transferTo: (target: TransferTarget) => void;
  cancelTransfer: () => void;
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
  const { user, getRealtimeToken, isLoading: isSessionLoading } = useAuth();
  const telephony = useTelephonyClient({
    identity: user?.id,
    getRealtimeToken,
  });
  const socket = useCallSocket({
    userId: user?.id,
    getRealtimeToken,
    onTransferOutcome: telephony.applyTransferOutcome,
  });
  const directory = useTeammates({ userId: user?.id });
  const { callLines, reload: reloadCallLines } = useCallLines({
    userId: user?.id,
    isLoading: isSessionLoading,
  });
  const [callLineChoice, setCallLineChoice] = useState<CallLineChoice | null>(
    null,
  );
  const userId = user?.id;
  const chooseCallLine = useCallback(
    (lineId: string) => {
      if (userId) {
        setCallLineChoice({ userId, lineId });
      }
    },
    [userId],
  );
  const [callDuration, setCallDuration] = useState(0);

  const { callStatus } = telephony;
  const { incomingCall: offeredCall, clearIncomingCall, rejectCall } = socket;
  const [heldOffer, setHeldOffer] = useState<IncomingCall | null>(null);
  // A new object on every press: pressing Answer again makes the session
  // remember for longer, and the clock here has to restart with it.
  const [answerPress, setAnswerPress] = useState<{
    offer: IncomingCall | null;
  } | null>(null);
  const answeredOffer = answerPress?.offer ?? null;
  const [expiredOffer, setExpiredOffer] = useState<IncomingCall | null>(null);
  const offerMemory = useRef(NO_OFFER_MEMORY);
  // An offer that arrived during a call waits off screen for the device to ring.
  const incomingCall = offeredCall === heldOffer ? null : offeredCall;

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

  // The controller says a call ended only once the whole conversation is
  // over, so an offer the device never rings for needs a deadline of its own.
  useEffect(() => {
    if (!offeredCall) {
      return;
    }
    const timer = window.setTimeout(
      () => setExpiredOffer(offeredCall),
      OFFER_EXPIRY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [offeredCall]);

  // The offer arrives while the phone is still idle, before Twilio rings the
  // device, so the rule keeps what it saw last time to tell a ring that
  // stopped from one that has not started. A layout effect, so that an offer
  // that arrives during a call is held back before the browser paints it.
  useLayoutEffect(() => {
    const { fate, memory } = offerFate({
      memory: offerMemory.current,
      callStatus,
      offer: offeredCall,
      answeredOffer,
      expiredOffer,
    });
    offerMemory.current = memory;

    if (fate === 'dismiss' && offeredCall) {
      clearIncomingCall(offeredCall);
    }
    setHeldOffer(memory.heldOffer);
  }, [callStatus, offeredCall, answeredOffer, expiredOffer, clearIncomingCall]);

  // The session forgets an early answer the device does not ring for in time;
  // the offer must stop saying "connecting" when it does.
  useEffect(() => {
    if (!answerPress) {
      return;
    }
    const timer = window.setTimeout(
      () => setAnswerPress(null),
      PENDING_ANSWER_TTL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [answerPress]);

  // An Answer pressed before the device rang belongs to the offer it was
  // pressed on. Once that offer is gone — the caller hung up, a colleague took
  // it, it was declined, or another offer replaced it — the answer goes with
  // it; the session would otherwise apply it to whichever call rings next
  // inside its window, and answer a call nobody chose.
  const { cancelPendingAnswer } = telephony;
  useEffect(() => {
    if (!answerPress || answerPress.offer === offeredCall) {
      return;
    }
    cancelPendingAnswer();
    setAnswerPress(null);
  }, [answerPress, offeredCall, cancelPendingAnswer]);

  const answerIncoming = useCallback(() => {
    telephony.answerIncoming();
    // Before the device rings the session can only remember the answer, so
    // the offer stays up to say so; it is dismissed once the call connects.
    setAnswerPress({ offer: incomingCall });
  }, [telephony.answerIncoming, incomingCall]);

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

  const { toggleHold, transferTo, cancelTransfer } = telephony;

  const value: CallContextValue = {
    deviceStatus: telephony.deviceStatus,
    callStatus,
    remoteNumber: telephony.remoteNumber,
    callDuration,
    isMuted: telephony.isMuted,
    isOnHold: telephony.isOnHold,
    isHoldPending: telephony.isHoldPending,
    transfer: telephony.transfer,
    notice: telephony.notice,
    isEndingCall: telephony.isEndingCall,
    endReason: telephony.endReason,
    error: telephony.error,
    incomingCall,
    earlyAnswer: earlyAnswerOf(
      incomingCall,
      answeredOffer,
      telephony.deviceStatus,
    ),
    incomingCallTransferredBy: incomingCall
      ? transferredByName(incomingCall, directory.teammates)
      : null,
    teammates: directory.teammates,
    teammatesError: directory.error,
    refreshTeammates: directory.refetch,
    lastEndedCall: socket.lastEndedCall,
    isSocketConnected: socket.isConnected,
    callLines,
    reloadCallLines,
    chosenCallLineId: chosenLineIdFor(callLineChoice, userId),
    chooseCallLine,
    makeCall: telephony.makeCall,
    hangUp,
    sendDigits: telephony.sendDigits,
    toggleMute: telephony.toggleMute,
    toggleHold: () => void toggleHold(),
    transferTo: (target) => void transferTo(target),
    cancelTransfer: () => void cancelTransfer(),
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
