'use client';

import type {
  ClientToServerEvents,
  IncomingCall,
  ServerToClientEvents,
} from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface UseCallSocketReturn {
  isConnected: boolean;
  incomingCall: IncomingCall | null;
  rejectCall: (conversationUuid: string) => void;
  clearIncomingCall: () => void;
}

/**
 * Hook for connecting to the call-controller service via Socket.IO
 * Handles real-time call signaling events (incoming calls, call ended, etc.)
 *
 * @param userId - The user ID to register with the call-controller
 * @param getToken - Function to get JWT token for authentication
 */
export function useCallSocket(
  userId: string | undefined,
  getToken: () => Promise<string | null>,
): UseCallSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const socketRef = useRef<TypedSocket | null>(null);
  const tokenRefreshInterval = useRef<NodeJS.Timeout | null>(null);
  const getTokenRef = useRef(getToken);
  const currentUserIdRef = useRef<string | undefined>(undefined);

  // Keep getToken ref updated without causing effect re-runs
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    // Clean up if userId becomes undefined (user logged out)
    if (!userId) {
      if (socketRef.current) {
        console.log('[CallSocket] Disconnecting - no userId');
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
      if (tokenRefreshInterval.current) {
        clearInterval(tokenRefreshInterval.current);
        tokenRefreshInterval.current = null;
      }
      currentUserIdRef.current = undefined;
      return;
    }

    // If already connected with the same userId, don't reconnect
    if (socketRef.current?.connected && currentUserIdRef.current === userId) {
      console.log('[CallSocket] Already connected with userId:', userId);
      return;
    }

    // Clean up existing connection if userId changed
    if (socketRef.current) {
      console.log('[CallSocket] UserId changed, reconnecting...');
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    currentUserIdRef.current = userId;
    let socket: TypedSocket | null = null;
    let authRetryCount = 0;
    const MAX_AUTH_RETRIES = 3;

    const connect = async () => {
      console.log('[CallSocket] Attempting connection for userId:', userId);
      const token = await getTokenRef.current();

      if (!token) {
        console.error('[CallSocket] No auth token available');
        return;
      }

      // Connect to call-controller for real-time call events
      const callControllerUrl =
        process.env.NEXT_PUBLIC_CALL_CONTROLLER_URL || 'http://localhost:3002';

      // Create socket connection with JWT in auth object
      socket = io(callControllerUrl, {
        auth: { token },
        transports: ['websocket', 'polling'],
      });

      socket.on('connect', () => {
        console.log('[CallSocket] Connected:', socket?.id);
        setIsConnected(true);
        authRetryCount = 0; // Reset retry counter on successful connection

        // Register user with socket server
        console.log('[CallSocket] Emitting register_user for:', userId);
        socket?.emit('register_user', {});
      });

      socket.on('disconnect', (reason) => {
        console.log('[CallSocket] Disconnected:', reason);
        setIsConnected(false);
      });

      socket.on('incoming_call', (data: IncomingCall) => {
        console.log('[CallSocket] Incoming call:', data);
        setIncomingCall(data);
      });

      socket.on('call_ended', (data) => {
        console.log('[CallSocket] Call ended:', data);
        // Clear incoming call if it matches the ended call
        setIncomingCall((current) =>
          current?.conversationUuid === data.conversationUuid ? null : current,
        );
      });

      socket.on('error', (error) => {
        console.error('[CallSocket] Error:', error);
      });

      socket.on('connect_error', async (error) => {
        console.error('[CallSocket] Connection error:', error.message);
        // If auth error, disconnect and reconnect with fresh token
        if (
          error.message.includes('token') ||
          error.message.includes('auth') ||
          error.message.includes('expired')
        ) {
          authRetryCount++;
          if (authRetryCount <= MAX_AUTH_RETRIES) {
            console.log(
              `[CallSocket] Auth error detected, retry ${authRetryCount}/${MAX_AUTH_RETRIES}...`,
            );
            socket?.disconnect();
            // Small delay before reconnecting
            await new Promise((resolve) => setTimeout(resolve, 1000));
            connect();
          } else {
            console.error(
              '[CallSocket] Max auth retries exceeded, please refresh the page',
            );
          }
        }
      });

      socketRef.current = socket;

      // Setup token refresh every 45 minutes (token expires in 1 hour)
      tokenRefreshInterval.current = setInterval(refreshToken, 45 * 60 * 1000);
    };

    const refreshToken = async () => {
      const newToken = await getTokenRef.current();
      if (newToken && socketRef.current?.connected) {
        socketRef.current.emit('auth:refresh', { token: newToken });
      }
    };

    connect();

    return () => {
      if (tokenRefreshInterval.current) {
        clearInterval(tokenRefreshInterval.current);
        tokenRefreshInterval.current = null;
      }
      if (socket) {
        socket.disconnect();
        socketRef.current = null;
      }
    };
  }, [userId]); // Only depend on userId, use ref for getToken

  const rejectCall = useCallback((conversationUuid: string) => {
    if (!socketRef.current) return;

    socketRef.current.emit('call_reject', { conversationUuid });
    setIncomingCall(null);
  }, []);

  const clearIncomingCall = useCallback(() => {
    setIncomingCall(null);
  }, []);

  return {
    isConnected,
    incomingCall,
    rejectCall,
    clearIncomingCall,
  };
}
