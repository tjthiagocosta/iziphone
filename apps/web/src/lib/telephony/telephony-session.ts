/*
 * The softphone's state machine over a Twilio Voice device: registering the
 * browser, ringing, answering, dialing, muting and hanging up. It decides
 * what the UI shows; the hook that owns it wires it to React and to the SDK,
 * so everything here runs and is tested without a browser.
 */

export type DeviceStatus = 'offline' | 'connecting' | 'ready' | 'error';

export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'ringing'
  | 'connected'
  | 'disconnecting'
  | 'disconnected';

export interface TelephonyState {
  deviceStatus: DeviceStatus;
  callStatus: CallStatus;
  /** The other party of the current call, as Twilio or the dialer named it. */
  remoteNumber: string | null;
  isMuted: boolean;
  /** A hangup is in flight; the button stays disabled until the call drops. */
  isEndingCall: boolean;
  error: string | null;
}

export const INITIAL_TELEPHONY_STATE: TelephonyState = {
  deviceStatus: 'offline',
  callStatus: 'idle',
  remoteNumber: null,
  isMuted: false,
  isEndingCall: false,
  error: null,
};

/** The slice of a Twilio `Call` the session drives. */
export interface VoiceCall {
  parameters: Record<string, string>;
  on(event: 'accept', listener: (call: VoiceCall) => void): unknown;
  on(
    event: 'ringing' | 'disconnect' | 'cancel' | 'reject',
    listener: () => void,
  ): unknown;
  on(event: 'mute', listener: (muted: boolean) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  accept(): void;
  reject(): void;
  disconnect(): void;
  mute(shouldMute: boolean): void;
  isMuted(): boolean;
  sendDigits(digits: string): void;
  /** One of the SDK's `Call.State` values. */
  status(): string;
}

/** The slice of a Twilio `Device` the session drives. */
export interface VoiceDevice {
  on(
    event: 'registering' | 'registered' | 'unregistered' | 'tokenWillExpire',
    listener: () => void,
  ): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'incoming', listener: (call: VoiceCall) => void): unknown;
  register(): Promise<void>;
  destroy(): void;
  connect(options: { params: Record<string, string> }): Promise<VoiceCall>;
  updateToken(token: string): void;
}

export interface TelephonySessionDeps {
  /** Prompts for the microphone; rejects when the browser denies it. */
  requestMicrophone(): Promise<void>;
  /** A Twilio access token for this user; asked again before one expires. */
  fetchVoiceToken(): Promise<string>;
  createDevice(token: string): VoiceDevice;
  /** Asks the call controller to end the conversation this leg belongs to. */
  requestHangup(legSid: string): Promise<void>;
}

/** How long "Call ended" stays on screen before the call UI goes away. */
export const ENDED_DISPLAY_MS = 1000;

/**
 * The socket may offer a call before Twilio rings this device, so an answer
 * or rejection is remembered briefly and applied when the ring arrives. Past
 * this window it is forgotten, so it cannot act on an unrelated later call.
 */
export const PENDING_ANSWER_TTL_MS = 10_000;

const CALL_STATE_CLOSED = 'closed';

/**
 * Twilio names the leg `CallSid` on incoming calls and `CallSID` once an
 * outgoing call is accepted. Only these are the SIDs the controller knows;
 * the SDK's own temporary connection ids are of no use to it.
 */
export function getCallSid(call: VoiceCall | null): string | null {
  if (!call) {
    return null;
  }
  return call.parameters.CallSID || call.parameters.CallSid || null;
}

type PendingAnswer = { action: 'accept' | 'reject'; at: number };

export class TelephonySession {
  private state = INITIAL_TELEPHONY_STATE;
  private device: VoiceDevice | null = null;
  /** The call in progress, or being set up. */
  private activeCall: VoiceCall | null = null;
  /** The call ringing this device, until it is answered or rejected. */
  private incomingCall: VoiceCall | null = null;
  private pendingAnswer: PendingAnswer | null = null;
  private endedTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly deps: TelephonySessionDeps,
    private readonly onChange: (state: TelephonyState) => void,
  ) {}

  getState(): TelephonyState {
    return this.state;
  }

  /** Registers the browser as the user's device. Resolves once it rang or failed. */
  async start(): Promise<void> {
    try {
      await this.deps.requestMicrophone();
      if (this.disposed) return;

      this.update({ deviceStatus: 'connecting', error: null });

      const token = await this.deps.fetchVoiceToken();
      if (this.disposed) return;

      const device = this.deps.createDevice(token);
      this.device = device;

      device.on('registering', () =>
        this.update({ deviceStatus: 'connecting' }),
      );
      device.on('registered', () =>
        this.update({ deviceStatus: 'ready', error: null }),
      );
      device.on('unregistered', () => this.update({ deviceStatus: 'offline' }));
      device.on('error', (error) =>
        this.update({
          deviceStatus: 'error',
          error: messageOf(error, 'The phone reported an error'),
        }),
      );
      device.on('tokenWillExpire', () => void this.refreshToken(device));
      device.on('incoming', (call) => this.ring(call));

      await device.register();
    } catch (error) {
      if (this.disposed) return;
      this.update({
        deviceStatus: 'error',
        error: messageOf(error, 'The phone could not start'),
      });
    }
  }

  /** Tears the device down. Twilio drops any call still on it. */
  dispose(): void {
    this.disposed = true;
    this.clearEndedTimer();
    this.device?.destroy();
    this.device = null;
    this.activeCall = null;
    this.incomingCall = null;
  }

  async makeCall(to: string): Promise<void> {
    if (!this.device || this.state.deviceStatus !== 'ready') {
      this.update({ error: 'The phone is not ready' });
      return;
    }
    if (this.activeCall) {
      this.update({ error: 'A call is already in progress' });
      return;
    }

    this.clearEndedTimer();
    this.update({
      callStatus: 'connecting',
      remoteNumber: to,
      isMuted: false,
      isEndingCall: false,
      error: null,
    });

    try {
      const call = await this.device.connect({
        params: { type: 'outbound-pstn', to },
      });
      if (this.disposed) return;

      this.activeCall = call;
      this.bind(call);
    } catch (error) {
      this.update({
        callStatus: 'idle',
        remoteNumber: null,
        error: messageOf(error, 'The call could not be started'),
      });
    }
  }

  /**
   * Ends the current call. The controller is asked to release the other
   * parties first; whether or not it answers, the local leg is dropped, so
   * the user is never stuck on a call because a server was unreachable.
   */
  async hangUp(): Promise<void> {
    const call = this.activeCall;
    if (!call || this.state.isEndingCall) return;

    if (call === this.incomingCall) {
      this.rejectIncoming();
      return;
    }

    this.update({ isEndingCall: true, error: null });

    const legSid = getCallSid(call);
    if (legSid) {
      try {
        await this.deps.requestHangup(legSid);
      } catch (error) {
        this.update({
          error: messageOf(error, 'The call could not be ended on the server'),
        });
      }
    }
    if (this.disposed) return;

    this.update({ callStatus: 'disconnecting' });
    call.disconnect();
  }

  answerIncoming(): void {
    const call = this.incomingCall;
    if (!call) {
      this.pendingAnswer = { action: 'accept', at: Date.now() };
      return;
    }
    this.accept(call);
  }

  rejectIncoming(): void {
    const call = this.incomingCall;
    if (!call) {
      this.pendingAnswer = { action: 'reject', at: Date.now() };
      return;
    }
    this.incomingCall = null;
    call.reject();
    this.ended();
  }

  toggleMute(): void {
    const call = this.activeCall;
    if (!call || this.state.callStatus !== 'connected') return;
    call.mute(!call.isMuted());
  }

  sendDigits(digits: string): void {
    if (this.state.callStatus !== 'connected') return;
    this.activeCall?.sendDigits(digits);
  }

  private ring(call: VoiceCall): void {
    this.clearEndedTimer();
    this.bind(call);
    this.incomingCall = call;
    this.activeCall = call;
    this.update({
      callStatus: 'ringing',
      remoteNumber: call.parameters.From || null,
      isMuted: false,
      isEndingCall: false,
      error: null,
    });

    const pending = this.takePendingAnswer();
    if (pending === 'accept') {
      this.accept(call);
    } else if (pending === 'reject') {
      this.rejectIncoming();
    }
  }

  private takePendingAnswer(): PendingAnswer['action'] | null {
    const pending = this.pendingAnswer;
    this.pendingAnswer = null;
    if (!pending || Date.now() - pending.at > PENDING_ANSWER_TTL_MS) {
      return null;
    }
    return pending.action;
  }

  private accept(call: VoiceCall): void {
    this.update({ callStatus: 'connecting' });
    call.accept();
  }

  private bind(call: VoiceCall): void {
    call.on('accept', (accepted) => {
      this.activeCall = accepted;
      this.incomingCall = null;
      this.update({
        callStatus: 'connected',
        isMuted: accepted.isMuted(),
        isEndingCall: false,
        error: null,
      });
    });
    call.on('ringing', () => this.update({ callStatus: 'ringing' }));
    call.on('mute', (muted) => this.update({ isMuted: muted }));
    call.on('disconnect', () => this.ended());
    call.on('cancel', () => this.ended());
    call.on('reject', () => this.ended());
    call.on('error', (error) => {
      this.update({ error: messageOf(error, 'The call reported an error') });
      if (call.status() === CALL_STATE_CLOSED) {
        this.ended();
      }
    });
  }

  /** The call is over: show "Call ended" briefly, then clear the call UI. */
  private ended(): void {
    if (
      this.state.callStatus === 'idle' ||
      this.state.callStatus === 'disconnected'
    ) {
      return;
    }

    this.activeCall = null;
    this.incomingCall = null;
    this.update({
      callStatus: 'disconnected',
      isMuted: false,
      isEndingCall: false,
    });

    this.endedTimer = setTimeout(() => {
      this.endedTimer = null;
      if (this.state.callStatus === 'disconnected') {
        this.update({ callStatus: 'idle', remoteNumber: null });
      }
    }, ENDED_DISPLAY_MS);
  }

  private clearEndedTimer(): void {
    if (this.endedTimer !== null) {
      clearTimeout(this.endedTimer);
      this.endedTimer = null;
    }
  }

  private async refreshToken(device: VoiceDevice): Promise<void> {
    try {
      device.updateToken(await this.deps.fetchVoiceToken());
    } catch (error) {
      this.update({
        deviceStatus: 'error',
        error: messageOf(error, 'The phone could not renew its token'),
      });
    }
  }

  private update(patch: Partial<TelephonyState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
