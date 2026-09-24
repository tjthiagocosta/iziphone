'use client';

import {
  type CallEnded,
  CallEndedSchema,
  type CallTransferOutcome,
  CallTransferOutcomeSchema,
  type ClientToServerEvents,
  type IncomingCall,
  IncomingCallSchema,
  type MessageActivity,
  MessageActivitySchema,
  type ServerToClientEvents,
  type UserAvailability,
  UserAvailabilitySchema,
} from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { CALL_CONTROLLER_URL } from '@/lib/api/client';

type CallSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface CallSocketOptions {
  /** Absent while signed out; the socket is then closed. */
  userId: string | undefined;
  getRealtimeToken: () => Promise<string>;
  /** How a transfer this user started, or was rung for, turned out. */
  onTransferOutcome?: (outcome: CallTransferOutcome) => void;
  /** Every time the socket connects, the first time and after each drop. */
  onConnected?: () => void;
  /** The user's own availability changed; older news may still arrive late. */
  onAvailability?: (availability: UserAvailability) => void;
}

export interface CallSocketState {
  isConnected: boolean;
  /** A call the controller offered this user, until it is taken or ends. */
  incomingCall: IncomingCall | null;
  /**
   * The call that ended most recently. History is written by the API from the
   * same Redis event, so anything showing call history can refetch on it.
   */
  lastEndedCall: CallEnded | null;
  /**
   * The most recent change to a message conversation this user can see. It
   * names the conversation and nothing else, so whatever shows messages reads
   * them from the API on it, the way `lastEndedCall` works for call history.
   */
  lastMessageActivity: MessageActivity | null;
  rejectCall: (conversationUuid: string) => void;
  /** Forgets this offer, unless a newer one has already taken its place. */
  clearIncomingCall: (offer: IncomingCall) => void;
}

/** The realtime token lives an hour; a long-lived socket renews it before then. */
const TOKEN_REFRESH_MS = 45 * 60 * 1000;

/** Backoff for retrying a handshake the controller rejected. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/**
 * The socket the call controller uses to offer calls to this user. It carries
 * a fresh realtime token on every connection attempt, so a reconnect after
 * the token expired needs no special handling.
 */
export function useCallSocket({
  userId,
  getRealtimeToken,
  onTransferOutcome,
  onConnected,
  onAvailability,
}: CallSocketOptions): CallSocketState {
  const [isConnected, setIsConnected] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [lastEndedCall, setLastEndedCall] = useState<CallEnded | null>(null);
  const [lastMessageActivity, setLastMessageActivity] =
    useState<MessageActivity | null>(null);
  const socketRef = useRef<CallSocket | null>(null);
  const getRealtimeTokenRef = useRef(getRealtimeToken);

  useEffect(() => {
    getRealtimeTokenRef.current = getRealtimeToken;
  }, [getRealtimeToken]);

  const onTransferOutcomeRef = useRef(onTransferOutcome);

  useEffect(() => {
    onTransferOutcomeRef.current = onTransferOutcome;
  }, [onTransferOutcome]);

  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  const onAvailabilityRef = useRef(onAvailability);

  useEffect(() => {
    onAvailabilityRef.current = onAvailability;
  }, [onAvailability]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    let retryDelay = RETRY_MIN_MS;
    let retryTimer: number | null = null;

    const socket: CallSocket = io(CALL_CONTROLLER_URL, {
      transports: ['websocket', 'polling'],
      auth: (provide) => {
        getRealtimeTokenRef.current().then(
          (token) => provide({ token }),
          // Without a token the controller rejects the handshake, which
          // schedules a retry below; the API may be back by then.
          () => provide({}),
        );
      },
    });

    socket.on('connect', () => {
      retryDelay = RETRY_MIN_MS;
      setIsConnected(true);
      socket.emit('register_user', {
        deviceInfo: { userAgent: navigator.userAgent.slice(0, 512) },
      });
      onConnectedRef.current?.();
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', (error) => {
      // A handshake the server refused is final for Socket.IO; it retries
      // network failures on its own.
      if (socket.active) {
        return;
      }
      console.error(`Call controller refused the socket: ${error.message}`);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        socket.connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    });

    socket.on('incoming_call', (data) => {
      const parsed = IncomingCallSchema.safeParse(data);
      if (!parsed.success) {
        console.error('Ignored an incoming call with an unexpected payload');
        return;
      }
      setIncomingCall(parsed.data);
    });

    socket.on('call_ended', (data) => {
      const parsed = CallEndedSchema.safeParse(data);
      if (!parsed.success) {
        console.error('Ignored a call ended event with an unexpected payload');
        return;
      }
      setIncomingCall((current) =>
        current?.conversationUuid === parsed.data.conversationUuid
          ? null
          : current,
      );
      setLastEndedCall(parsed.data);
    });

    socket.on('call_transfer_outcome', (data) => {
      const parsed = CallTransferOutcomeSchema.safeParse(data);
      if (!parsed.success) {
        console.error('Ignored a transfer outcome with an unexpected payload');
        return;
      }
      const outcome = parsed.data;
      // A transfer that failed no longer rings the teammate it was offered to.
      if (outcome.status === 'failed') {
        setIncomingCall((current) =>
          current?.conversationUuid === outcome.conversationUuid
            ? null
            : current,
        );
      }
      onTransferOutcomeRef.current?.(outcome);
    });

    socket.on('message_activity', (data) => {
      const parsed = MessageActivitySchema.safeParse(data);
      if (!parsed.success) {
        console.error('Ignored message activity with an unexpected payload');
        return;
      }
      // A new object every time, even for a repeat of the same conversation
      // and kind: the listeners react to the event, not to a changed value.
      setLastMessageActivity(parsed.data);
    });

    socket.on('user_availability', (data) => {
      const parsed = UserAvailabilitySchema.safeParse(data);
      if (!parsed.success) {
        console.error(
          'Ignored an availability change with an unexpected payload',
        );
        return;
      }
      onAvailabilityRef.current?.(parsed.data);
    });

    socket.on('error', (data) => {
      console.error(`Call controller reported an error: ${data.message}`);
    });

    const refreshTimer = window.setInterval(() => {
      if (!socket.connected) {
        return;
      }
      getRealtimeTokenRef.current().then(
        (token) => socket.emit('auth:refresh', { token }),
        // The next reconnect fetches a token anyway.
        () => undefined,
      );
    }, TOKEN_REFRESH_MS);

    socketRef.current = socket;

    return () => {
      window.clearInterval(refreshTimer);
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      setIncomingCall(null);
      setLastEndedCall(null);
      setLastMessageActivity(null);
    };
  }, [userId]);

  // Both forget only the offer they were asked about: a newer one can be
  // queued behind the render that decided this, and must not go with it.
  const rejectCall = useCallback((conversationUuid: string) => {
    socketRef.current?.emit('call_reject', { conversationUuid });
    setIncomingCall((current) =>
      current?.conversationUuid === conversationUuid ? null : current,
    );
  }, []);

  const clearIncomingCall = useCallback((offer: IncomingCall) => {
    setIncomingCall((current) => (current === offer ? null : current));
  }, []);

  return {
    isConnected,
    incomingCall,
    lastEndedCall,
    lastMessageActivity,
    rejectCall,
    clearIncomingCall,
  };
}
