'use client';

import { Call, Device } from '@twilio/voice-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export type DeviceStatus = 'offline' | 'connecting' | 'ready' | 'error';
export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'ringing'
  | 'disconnecting'
  | 'connected'
  | 'disconnected';

interface UseTelephonyClientOptions {
  identity?: string;
  getToken: () => Promise<string | null>;
}

interface UseTelephonyClientReturn {
  client: Device | null;
  currentCallId: string | null;
  deviceStatus: DeviceStatus;
  callStatus: CallStatus;
  error: string | null;
  isEndingCall: boolean;
  makeCall: (to: string) => Promise<void>;
  hangUp: () => Promise<void>;
  sendDigits: (digits: string) => Promise<void>;
  answerIncoming: () => Promise<void>;
  rejectIncoming: () => Promise<void>;
  toggleMute: () => Promise<void>;
  isMuted: boolean;
  setDND: (enabled: boolean) => void;
  isDND: boolean;
}

async function requestMicrophonePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => {
    track.stop();
  });
}

export function getCallSid(call: Call | null): string | null {
  if (!call) {
    return null;
  }

  // Twilio uses `CallSid` for incoming payloads and `CallSID` for the real
  // outgoing call SID after the call is accepted. Avoid SDK-local temp IDs
  // here because the backend only knows Twilio leg SIDs.
  return call.parameters.CallSID || call.parameters.CallSid || null;
}

export function useTelephonyClient(
  options: UseTelephonyClientOptions,
): UseTelephonyClientReturn {
  const { identity, getToken } = options;
  const [client, setClient] = useState<Device | null>(null);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('offline');
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isEndingCall, setIsEndingCall] = useState(false);
  const [isDND, setIsDNDState] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('softphone_dnd') === 'true';
    }

    return false;
  });

  const clientRef = useRef<Device | null>(null);
  const activeCallRef = useRef<Call | null>(null);
  const incomingCallRef = useRef<Call | null>(null);
  const currentCallIdRef = useRef<string | null>(null);
  const isDNDRef = useRef(isDND);
  const autoAnswerRef = useRef(false);
  const autoRejectRef = useRef(false);

  const syncCallId = useCallback((call: Call | null) => {
    const callSid = getCallSid(call);
    currentCallIdRef.current = callSid;
    setCurrentCallId(callSid);
    return callSid;
  }, []);

  const resetCallState = useCallback(() => {
    activeCallRef.current = null;
    incomingCallRef.current = null;
    currentCallIdRef.current = null;
    setCurrentCallId(null);
    setCallStatus('idle');
    setIsMuted(false);
    setIsEndingCall(false);
  }, []);

  const completeDisconnectedCall = useCallback(() => {
    setCallStatus('disconnected');
    setIsMuted(false);
    setIsEndingCall(false);
    window.setTimeout(() => {
      resetCallState();
    }, 1000);
  }, [resetCallState]);

  const fetchVoiceToken = useCallback(async () => {
    const authToken = await getToken();
    if (!authToken) {
      throw new Error('No authentication token available');
    }

    const callControllerUrl =
      process.env.NEXT_PUBLIC_CALL_CONTROLLER_URL || 'http://localhost:3002';
    const response = await fetch(`${callControllerUrl}/api/voice/jwt`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Twilio access token: ${response.status}`,
      );
    }

    const { jwt } = (await response.json()) as { jwt?: string };
    if (!jwt) {
      throw new Error('Call controller did not return a Twilio access token');
    }

    return jwt;
  }, [getToken]);

  useEffect(() => {
    isDNDRef.current = isDND;
  }, [isDND]);

  useEffect(() => {
    if (!identity) {
      clientRef.current?.destroy();
      clientRef.current = null;
      setClient(null);
      setDeviceStatus('offline');
      setError(null);
      resetCallState();
      return;
    }

    let cancelled = false;

    const attachCallListeners = (call: Call) => {
      call.on('accept', (connectedCall) => {
        if (cancelled) {
          return;
        }

        activeCallRef.current = connectedCall;
        incomingCallRef.current = null;
        syncCallId(connectedCall);
        setCallStatus('connected');
        setIsMuted(connectedCall.isMuted());
        setIsEndingCall(false);
        setError(null);
      });

      call.on('ringing', () => {
        if (cancelled) {
          return;
        }

        syncCallId(call);
        setCallStatus('ringing');
      });

      call.on('mute', (muted) => {
        if (cancelled) {
          return;
        }

        setIsMuted(muted);
      });

      call.on('disconnect', () => {
        if (cancelled) {
          return;
        }

        completeDisconnectedCall();
      });

      call.on('cancel', () => {
        if (cancelled) {
          return;
        }

        completeDisconnectedCall();
      });

      call.on('reject', () => {
        if (cancelled) {
          return;
        }

        completeDisconnectedCall();
      });

      call.on('error', (callError) => {
        if (cancelled) {
          return;
        }

        const message =
          callError instanceof Error ? callError.message : 'Twilio call error';
        setError(message);

        if (call.status() === Call.State.Closed) {
          completeDisconnectedCall();
        }
      });
    };

    const init = async () => {
      try {
        await requestMicrophonePermission();
        setDeviceStatus('connecting');
        setError(null);

        const voiceToken = await fetchVoiceToken();
        const device = new Device(voiceToken, {
          closeProtection: true,
          logLevel: 'error',
          tokenRefreshMs: 30_000,
        });

        device.on('registering', () => {
          if (!cancelled) {
            setDeviceStatus('connecting');
          }
        });

        device.on('registered', () => {
          if (!cancelled) {
            setDeviceStatus('ready');
            setError(null);
          }
        });

        device.on('unregistered', () => {
          if (!cancelled) {
            setDeviceStatus('offline');
          }
        });

        device.on('error', (deviceError) => {
          if (cancelled) {
            return;
          }

          const message =
            deviceError instanceof Error
              ? deviceError.message
              : 'Twilio device error';
          setError(message);
          setDeviceStatus('error');
        });

        device.on('tokenWillExpire', () => {
          void (async () => {
            try {
              const refreshedToken = await fetchVoiceToken();
              device.updateToken(refreshedToken);
            } catch (refreshError) {
              const message =
                refreshError instanceof Error
                  ? refreshError.message
                  : 'Failed to refresh Twilio access token';
              setError(message);
              setDeviceStatus('error');
            }
          })();
        });

        device.on('incoming', (call) => {
          if (cancelled) {
            call.reject();
            return;
          }

          attachCallListeners(call);
          incomingCallRef.current = call;
          activeCallRef.current = call;
          syncCallId(call);
          setCallStatus('ringing');
          setIsMuted(false);

          if (isDNDRef.current) {
            call.reject();
            return;
          }

          if (autoRejectRef.current) {
            autoRejectRef.current = false;
            call.reject();
            return;
          }

          if (autoAnswerRef.current) {
            autoAnswerRef.current = false;
            call.accept();
            setCallStatus('connecting');
          }
        });

        await device.register();

        if (cancelled) {
          device.destroy();
          return;
        }

        clientRef.current = device;
        setClient(device);
      } catch (initError) {
        const message =
          initError instanceof Error
            ? initError.message
            : 'Failed to initialize telephony client';
        setError(message);
        setDeviceStatus('error');
      }
    };

    void init();

    return () => {
      cancelled = true;
      clientRef.current?.destroy();
      clientRef.current = null;
      activeCallRef.current = null;
      incomingCallRef.current = null;
    };
  }, [
    identity,
    fetchVoiceToken,
    completeDisconnectedCall,
    resetCallState,
    syncCallId,
  ]);

  const makeCall = useCallback(
    async (to: string) => {
      if (!clientRef.current) {
        setError('Telephony client not ready');
        return;
      }

      try {
        setError(null);
        setCallStatus('connecting');
        setIsMuted(false);
        setIsEndingCall(false);

        const call = await clientRef.current.connect({
          params: {
            type: 'outbound-pstn',
            to,
          },
        });

        activeCallRef.current = call;
        syncCallId(call);

        call.on('mute', (muted) => setIsMuted(muted));
        call.on('accept', (acceptedCall) => {
          activeCallRef.current = acceptedCall;
          syncCallId(acceptedCall);
          setCallStatus('connected');
        });
        call.on('ringing', () => {
          syncCallId(call);
          setCallStatus('ringing');
        });
        call.on('disconnect', completeDisconnectedCall);
        call.on('cancel', completeDisconnectedCall);
        call.on('reject', completeDisconnectedCall);
        call.on('error', (callError) => {
          const message =
            callError instanceof Error
              ? callError.message
              : 'Twilio call error';
          setError(message);

          if (call.status() === Call.State.Closed) {
            completeDisconnectedCall();
          }
        });
      } catch (callError) {
        const message =
          callError instanceof Error
            ? callError.message
            : 'Failed to start outbound call';
        setError(message);
        setCallStatus('idle');
      }
    },
    [completeDisconnectedCall, syncCallId],
  );

  const hangUp = useCallback(async () => {
    const call = activeCallRef.current || incomingCallRef.current;
    const callId = currentCallIdRef.current || getCallSid(call);

    if (!call || isEndingCall) {
      return;
    }

    try {
      setError(null);
      setIsEndingCall(true);

      if (callId) {
        const authToken = await getToken();
        if (!authToken) {
          throw new Error('No authentication token available');
        }

        const callControllerUrl =
          process.env.NEXT_PUBLIC_CALL_CONTROLLER_URL ||
          'http://localhost:3002';
        const response = await fetch(
          `${callControllerUrl}/api/voice/calls/${encodeURIComponent(callId)}/hangup`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          },
        );

        if (!response.ok) {
          throw new Error(`Failed to end call: ${response.status}`);
        }
      }

      setCallStatus('disconnecting');
      call.disconnect();
    } catch (hangupError) {
      const message =
        hangupError instanceof Error
          ? hangupError.message
          : 'Failed to end call';
      setError(message);
      setIsEndingCall(false);
    }
  }, [getToken, isEndingCall]);

  const sendDigits = useCallback(async (digits: string) => {
    activeCallRef.current?.sendDigits(digits);
  }, []);

  const answerIncoming = useCallback(async () => {
    const call = incomingCallRef.current;

    if (!call) {
      autoAnswerRef.current = true;
      return;
    }

    autoAnswerRef.current = false;
    setCallStatus('connecting');
    call.accept();
  }, []);

  const rejectIncoming = useCallback(async () => {
    const call = incomingCallRef.current;

    if (!call) {
      autoRejectRef.current = true;
      return;
    }

    autoRejectRef.current = false;
    call.reject();
    completeDisconnectedCall();
  }, [completeDisconnectedCall]);

  const toggleMute = useCallback(async () => {
    const call = activeCallRef.current;
    if (!call) {
      return;
    }

    call.mute(!isMuted);
    setIsMuted(!isMuted);
  }, [isMuted]);

  const setDND = useCallback((enabled: boolean) => {
    localStorage.setItem('softphone_dnd', enabled ? 'true' : 'false');
    setIsDNDState(enabled);
  }, []);

  return {
    client,
    currentCallId,
    deviceStatus,
    callStatus,
    error,
    isEndingCall,
    makeCall,
    hangUp,
    sendDigits,
    answerIncoming,
    rejectIncoming,
    toggleMute,
    isMuted,
    setDND,
    isDND,
  };
}
