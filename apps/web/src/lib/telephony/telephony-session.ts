/*
 * The softphone's state machine over a Twilio Voice device: registering the
 * browser, ringing, answering, dialing, muting, holding, handing a call to a
 * teammate and hanging up. It decides what the UI shows; the hook that owns
 * it wires it to React and to the SDK, so everything here runs and is tested
 * without a browser.
 */

import {
  type CallControlRefusal,
  CallControlRefusalSchema,
  type CallTransferOutcome,
  type TransferFailureReason,
} from '@repo/dto';

export type DeviceStatus = 'offline' | 'connecting' | 'ready' | 'error';

export type CallStatus =
  | 'idle'
  | 'connecting'
  | 'ringing'
  | 'connected'
  | 'disconnecting'
  | 'disconnected';

/** Twilio ends a handed-over leg like any other; only the controller knows. */
export type CallEndReason = 'ended' | 'transferred';

/** The teammate a call is being handed to. */
export interface TransferTarget {
  id: string;
  name: string;
}

export interface TransferProgress {
  targetUserId: string;
  targetName: string;
  /**
   * Asked of the controller, ringing the teammate, being called off, or
   * answered and waiting for this leg to be released. A request whose answer
   * was lost reads as ringing too, since it may be, and can be called off.
   */
  status: 'requesting' | 'ringing' | 'cancelling' | 'answered';
}

export interface TelephonyState {
  deviceStatus: DeviceStatus;
  callStatus: CallStatus;
  /** The other party of the current call, as Twilio or the dialer named it. */
  remoteNumber: string | null;
  isMuted: boolean;
  /** The other party hears the hold audio and the two cannot hear each other. */
  isOnHold: boolean;
  /** A hold or a resume is in flight; a second press waits for its answer. */
  isHoldPending: boolean;
  /** The transfer this user started and is still on the line for. */
  transfer: TransferProgress | null;
  /** Why the last transfer did not go through, until the next hold or transfer. */
  notice: string | null;
  /** A hangup is in flight; the button stays disabled until the call drops. */
  isEndingCall: boolean;
  /** How the call that just finished ended; read while it shows as disconnected. */
  endReason: CallEndReason;
  error: string | null;
}

export const INITIAL_TELEPHONY_STATE: TelephonyState = {
  deviceStatus: 'offline',
  callStatus: 'idle',
  remoteNumber: null,
  isMuted: false,
  isOnHold: false,
  isHoldPending: false,
  transfer: null,
  notice: null,
  isEndingCall: false,
  endReason: 'ended',
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
  /**
   * Asks the controller to hold or resume the other party of this leg's
   * call. Resolves to whether they are held now.
   */
  requestHold(legSid: string, hold: boolean): Promise<boolean>;
  /**
   * Asks the controller to ring a teammate to take this leg's call over.
   * Resolves once they ring, with the conversation the outcome will name.
   */
  requestTransfer(
    legSid: string,
    targetUserId: string,
  ): Promise<{ conversationUuid: string }>;
  /** Asks the controller to stop ringing the teammate and give the call back. */
  requestTransferCancel(legSid: string): Promise<void>;
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

/**
 * A transfer this session asked for and has not seen settled. The
 * controller's answer and its outcome signal travel separately and arrive in
 * either order, so whichever comes second is recognised by the attempt no
 * longer being the current one.
 */
interface TransferAttempt {
  id: number;
  call: VoiceCall;
  target: TransferTarget;
  /** Known once the controller answers; checked against the outcome's. */
  conversationUuid: string | null;
}

export class TelephonySession {
  private state = INITIAL_TELEPHONY_STATE;
  private device: VoiceDevice | null = null;
  /** The call in progress, or being set up. */
  private activeCall: VoiceCall | null = null;
  /** The call ringing this device, until it is answered or rejected. */
  private incomingCall: VoiceCall | null = null;
  private pendingAnswer: PendingAnswer | null = null;
  private transferAttempt: TransferAttempt | null = null;
  private transferAttemptCount = 0;
  /** The call a teammate took over, until Twilio drops this device's leg. */
  private handedOverCall: VoiceCall | null = null;
  /** The call "Call ended" is on screen for. */
  private lastEndedCall: VoiceCall | null = null;
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
    this.transferAttempt = null;
    this.handedOverCall = null;
    this.lastEndedCall = null;
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

  /**
   * Holds the other party, or takes them off hold. The controller does it,
   * so the state follows its answer, not the press; a press while one is in
   * flight, or while a transfer holds the call, does nothing.
   */
  async toggleHold(): Promise<void> {
    const call = this.controllableCall();
    const legSid = getCallSid(call);
    if (!call || !legSid) return;

    const hold = !this.state.isOnHold;
    this.update({ isHoldPending: true, notice: null, error: null });

    try {
      const held = await this.deps.requestHold(legSid, hold);
      // A call that ended meanwhile has had its hold state reset already.
      if (this.activeCall !== call) return;
      this.update({ isOnHold: held, isHoldPending: false });
    } catch (error) {
      if (this.activeCall !== call) return;
      this.update({
        isHoldPending: false,
        error: messageOf(
          error,
          hold
            ? 'The call could not be put on hold'
            : 'The call could not be taken off hold',
        ),
      });
    }
  }

  /**
   * Hands the call to a teammate. The user stays on the line while the
   * teammate rings; `applyTransferOutcome` says how it went.
   */
  async transferTo(target: TransferTarget): Promise<void> {
    const call = this.controllableCall();
    const legSid = getCallSid(call);
    if (!call || !legSid) return;

    this.transferAttemptCount += 1;
    const attempt: TransferAttempt = {
      id: this.transferAttemptCount,
      call,
      target,
      conversationUuid: null,
    };
    this.transferAttempt = attempt;
    this.update({
      transfer: {
        targetUserId: target.id,
        targetName: target.name,
        status: 'requesting',
      },
      notice: null,
      error: null,
    });

    try {
      const { conversationUuid } = await this.deps.requestTransfer(
        legSid,
        target.id,
      );
      const current = this.transferAttempt;
      if (current?.id !== attempt.id) return;

      this.transferAttempt = { ...current, conversationUuid };
      // Hung up meanwhile: the transfer goes on without this leg.
      if (this.activeCall !== call) return;

      const shown = this.state.transfer;
      this.update({
        // The controller holds the other party before it rings the teammate.
        isOnHold: true,
        transfer: shown && { ...shown, status: 'ringing' },
      });
    } catch (error) {
      if (this.transferAttempt?.id !== attempt.id) return;

      const refusal = transferRefusalOf(error);
      if (refusal === null && !wasTurnedDown(error)) {
        // No answer, or one that does not say: the controller may be
        // ringing the teammate all the same, with the other party on hold.
        // The transfer stays on screen, where it can be called off, and the
        // attempt is kept for the outcome that would then still come.
        if (this.activeCall !== call) return;
        const shown = this.state.transfer;
        this.update({
          transfer: shown && { ...shown, status: 'ringing' },
          error: UNCONFIRMED_TRANSFER_MESSAGE,
        });
        return;
      }

      // Refused because the teammate turned the call down, or could not be
      // rung, before the controller was done: the outcome on its way says
      // which, so the attempt is kept for it.
      const settledMeanwhile = refusal === 'no-transfer-pending';
      if (!settledMeanwhile) {
        this.transferAttempt = null;
      }
      if (this.activeCall !== call) return;

      this.update({
        transfer: null,
        notice: settledMeanwhile
          ? transferFailureNotice(undefined, target.name)
          : transferRefusalNotice(error, target.name),
        ...(refusal !== null && HOLD_ENDING_REFUSALS.has(refusal)
          ? { isOnHold: false }
          : {}),
      });
    }
  }

  /**
   * Stops ringing the teammate; the other party comes back to the user. A
   * transfer still being asked for cannot be cancelled: the controller may
   * not have marked the call yet, and would answer that nothing is pending
   * while it goes on to ring the teammate.
   */
  async cancelTransfer(): Promise<void> {
    const call = this.activeCall;
    const attempt = this.transferAttempt;
    const shown = this.state.transfer;
    if (
      !call ||
      !attempt ||
      attempt.call !== call ||
      shown?.status !== 'ringing'
    ) {
      return;
    }
    const legSid = getCallSid(call);
    if (!legSid) return;

    this.update({ transfer: { ...shown, status: 'cancelling' }, error: null });

    try {
      await this.deps.requestTransferCancel(legSid);
    } catch (error) {
      const current = this.transferAttempt;
      if (current?.id !== attempt.id || this.activeCall !== call) return;

      if (refusalCodeOf(error) === 'no-transfer-pending') {
        // Answered or failed a moment ago, and either ended the hold. The
        // attempt is kept so that the outcome, still on its way, can say
        // which. A transfer the controller never confirmed may not have
        // begun at all, and then the hold is as the user left it.
        this.update({
          transfer: null,
          ...(attempt.conversationUuid !== null ? { isOnHold: false } : {}),
        });
        return;
      }
      this.update({
        transfer: shown,
        error: messageOf(error, 'The transfer could not be cancelled'),
      });
      return;
    }

    if (this.transferAttempt?.id !== attempt.id) return;
    this.transferAttempt = null;
    if (this.activeCall !== call) return;
    this.update({ transfer: null, isOnHold: false });
  }

  /**
   * What the controller says became of a transfer this user started. Twilio
   * ends a handed-over leg like any other, so this signal is the only thing
   * that tells "transferred" from "ended"; it may come before or after the
   * leg drops, and more than once.
   */
  applyTransferOutcome(outcome: CallTransferOutcome): void {
    const attempt = this.transferAttempt;
    if (
      !attempt ||
      attempt.target.id !== outcome.targetUserId ||
      (attempt.conversationUuid !== null &&
        attempt.conversationUuid !== outcome.conversationUuid)
    ) {
      return;
    }
    this.transferAttempt = null;

    if (outcome.status === 'completed') {
      if (attempt.call === this.activeCall) {
        this.handedOverCall = attempt.call;
        const shown = this.state.transfer;
        this.update({
          transfer: shown ? { ...shown, status: 'answered' } : null,
          error: null,
        });
      } else if (
        attempt.call === this.lastEndedCall &&
        this.state.callStatus === 'disconnected'
      ) {
        // The leg dropped first and "Call ended" is still on screen.
        this.update({ endReason: 'transferred' });
        this.clearEndedTimer();
        this.clearCallUiSoon();
      }
      return;
    }

    if (attempt.call !== this.activeCall) return;
    this.update({
      transfer: null,
      // The controller takes the other party off hold when a transfer fails.
      isOnHold: false,
      notice: transferFailureNotice(outcome.reason, attempt.target.name),
      // What is left there is about the transfer this settles, a cancel that
      // did not get through, say, and it would hide the notice.
      error: null,
    });
  }

  /** The connected call, when nothing else is being asked of the controller for it. */
  private controllableCall(): VoiceCall | null {
    if (
      this.state.callStatus !== 'connected' ||
      this.state.isHoldPending ||
      this.state.transfer
    ) {
      return null;
    }
    return this.activeCall;
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

  /**
   * The call is over: show how it ended briefly, then clear the call UI. A
   * transfer still ringing is left to go on; its outcome may yet arrive.
   */
  private ended(): void {
    if (
      this.state.callStatus === 'idle' ||
      this.state.callStatus === 'disconnected'
    ) {
      return;
    }

    const endedCall = this.activeCall;
    const wasHandedOver =
      endedCall !== null && endedCall === this.handedOverCall;

    this.activeCall = null;
    this.incomingCall = null;
    this.handedOverCall = null;
    this.lastEndedCall = endedCall;
    this.update({
      callStatus: 'disconnected',
      endReason: wasHandedOver ? 'transferred' : 'ended',
      isMuted: false,
      isOnHold: false,
      isHoldPending: false,
      transfer: null,
      notice: null,
      isEndingCall: false,
    });

    this.clearCallUiSoon();
  }

  private clearCallUiSoon(): void {
    this.endedTimer = setTimeout(() => {
      this.endedTimer = null;
      this.lastEndedCall = null;
      if (this.state.callStatus === 'disconnected') {
        // Past this point nothing on screen could still say "transferred".
        this.transferAttempt = null;
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

/** The controller's machine-readable reason for refusing, when it gave one. */
function refusalCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  return typeof error.code === 'string' ? error.code : null;
}

/**
 * Whether the controller answered that it would not do it, as it does with a
 * client error before it acts on a request. No answer at all, or a server
 * error, leaves open that it went ahead.
 */
function wasTurnedDown(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  return (
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
  );
}

const UNCONFIRMED_TRANSFER_MESSAGE =
  'The transfer could not be confirmed. Cancel it to take the call back.';

function transferRefusalOf(error: unknown): CallControlRefusal | null {
  const parsed = CallControlRefusalSchema.safeParse(refusalCodeOf(error));
  return parsed.success ? parsed.data : null;
}

/**
 * The refusals the controller gives once it has touched the hold. By then it
 * has taken the other party off hold again, whether the transfer held them
 * or the user had before it. The failed outcome says the same, but it can
 * come second, when the attempt it belongs to is already settled here.
 */
const HOLD_ENDING_REFUSALS: ReadonlySet<CallControlRefusal> = new Set([
  'provider-error',
  'no-transfer-pending',
  'call-gone',
]);

/** The controller does not know names; the refusals about the teammate get theirs here. */
function transferRefusalNotice(error: unknown, targetName: string): string {
  switch (refusalCodeOf(error)) {
    case 'target-offline':
      return `${targetName} is not online`;
    case 'target-on-call':
      return `${targetName} is already on this call`;
    default:
      return messageOf(error, 'The call could not be transferred');
  }
}

function transferFailureNotice(
  reason: TransferFailureReason | undefined,
  targetName: string,
): string | null {
  switch (reason) {
    case 'declined':
      return `${targetName} declined the call`;
    case 'no-answer':
      return `${targetName} did not answer`;
    case 'cancelled':
      // Only the user cancels their own transfer; they need no telling.
      return null;
    default:
      return `${targetName} could not be reached`;
  }
}
