import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ENDED_DISPLAY_MS,
  getCallSid,
  PENDING_ANSWER_TTL_MS,
  TelephonySession,
  type TelephonySessionDeps,
  type TelephonyState,
  type VoiceCall,
  type VoiceDevice,
} from './telephony-session';

/** The number of the user's the test calls leave from. */
const line = '+15550100102';

class FakeCall extends EventEmitter implements VoiceCall {
  parameters: Record<string, string>;
  private muted = false;
  private currentStatus = 'pending';
  accept = vi.fn(() => {
    this.currentStatus = 'open';
    this.emit('accept', this);
  });
  reject = vi.fn(() => {
    this.currentStatus = 'closed';
    this.emit('reject');
  });
  disconnect = vi.fn(() => {
    this.currentStatus = 'closed';
    this.emit('disconnect');
  });
  mute = vi.fn((shouldMute: boolean) => {
    this.muted = shouldMute;
    this.emit('mute', shouldMute);
  });
  sendDigits = vi.fn();

  constructor(parameters: Record<string, string> = {}) {
    super();
    this.parameters = parameters;
  }

  isMuted(): boolean {
    return this.muted;
  }

  status(): string {
    return this.currentStatus;
  }
}

class FakeDevice extends EventEmitter implements VoiceDevice {
  token: string;
  nextCall = new FakeCall();
  register = vi.fn(async () => {
    this.emit('registered');
  });
  destroy = vi.fn();
  connect = vi.fn(async () => this.nextCall);
  updateToken = vi.fn((token: string) => {
    this.token = token;
  });

  constructor(token: string) {
    super();
    this.token = token;
  }
}

function setup(overrides: Partial<TelephonySessionDeps> = {}) {
  const devices: FakeDevice[] = [];
  const deps: TelephonySessionDeps = {
    requestMicrophone: vi.fn(async () => {}),
    fetchVoiceToken: vi.fn(async () => 'voice-token'),
    createDevice: vi.fn((token: string) => {
      const device = new FakeDevice(token);
      devices.push(device);
      return device;
    }),
    requestOutboundGrant: vi.fn(async () => 'a-grant-token'),
    requestHangup: vi.fn(async () => {}),
    requestHold: vi.fn(async (_legSid: string, hold: boolean) => hold),
    requestTransfer: vi.fn(async () => ({ conversationUuid: 'CAcall1' })),
    requestTransferCancel: vi.fn(async () => {}),
    ...overrides,
  };
  const states: TelephonyState[] = [];
  const session = new TelephonySession(deps, (state) => states.push(state));

  return {
    deps,
    session,
    states,
    get device() {
      const device = devices[0];
      if (!device) throw new Error('No device was created');
      return device;
    },
    get state() {
      return session.getState();
    },
  };
}

async function startedSession(overrides: Partial<TelephonySessionDeps> = {}) {
  const context = setup(overrides);
  await context.session.start();
  return context;
}

/** A promise the test settles when it chooses, to order what arrives when. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** What the API client throws for a controller refusal. */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('getCallSid', () => {
  test('prefers the SID Twilio assigns to an accepted outgoing call', () => {
    expect(
      getCallSid({ parameters: { CallSID: 'CA_out' } } as unknown as VoiceCall),
    ).toBe('CA_out');
  });

  test('reads the SID of an incoming call', () => {
    expect(
      getCallSid({ parameters: { CallSid: 'CA_in' } } as unknown as VoiceCall),
    ).toBe('CA_in');
  });

  test('has none before Twilio assigned one', () => {
    expect(getCallSid({ parameters: {} } as unknown as VoiceCall)).toBeNull();
    expect(getCallSid(null)).toBeNull();
  });
});

describe('TelephonySession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start', () => {
    test('asks for the microphone, then registers a device with a token', async () => {
      const { session, deps, device, state } = await startedSession();

      expect(deps.requestMicrophone).toHaveBeenCalledOnce();
      expect(deps.createDevice).toHaveBeenCalledWith('voice-token');
      expect(device.register).toHaveBeenCalledOnce();
      expect(state).toMatchObject({ deviceStatus: 'ready', error: null });
      expect(session.getState()).toBe(state);
    });

    test('reports a denied microphone without creating a device', async () => {
      const context = setup({
        requestMicrophone: vi.fn(async () => {
          throw new Error('Permission denied');
        }),
      });

      await context.session.start();

      expect(context.deps.createDevice).not.toHaveBeenCalled();
      expect(context.state).toMatchObject({
        deviceStatus: 'error',
        error: 'Permission denied',
      });
    });

    test('reports a token the controller refused', async () => {
      const context = setup({
        fetchVoiceToken: vi.fn(async () => {
          throw new Error('Voice is not configured');
        }),
      });

      await context.session.start();

      expect(context.state).toMatchObject({
        deviceStatus: 'error',
        error: 'Voice is not configured',
      });
    });

    test('follows the device through its registration events', async () => {
      const { device, state: _, session } = await startedSession();

      device.emit('unregistered');
      expect(session.getState().deviceStatus).toBe('offline');

      device.emit('registering');
      expect(session.getState().deviceStatus).toBe('connecting');

      device.emit('error', new Error('31005: Connection lost'));
      expect(session.getState()).toMatchObject({
        deviceStatus: 'error',
        error: '31005: Connection lost',
      });
    });

    test('renews the token when the device warns it will expire', async () => {
      const { device, deps } = await startedSession();
      vi.mocked(deps.fetchVoiceToken).mockResolvedValueOnce('fresh-token');

      device.emit('tokenWillExpire');
      await vi.runAllTimersAsync();

      expect(device.updateToken).toHaveBeenCalledWith('fresh-token');
    });

    test('reports a token renewal that failed', async () => {
      const { device, deps, session } = await startedSession();
      vi.mocked(deps.fetchVoiceToken).mockRejectedValueOnce(
        new Error('Session expired'),
      );

      device.emit('tokenWillExpire');
      await vi.runAllTimersAsync();

      expect(session.getState()).toMatchObject({
        deviceStatus: 'error',
        error: 'Session expired',
      });
    });
  });

  describe('incoming calls', () => {
    test('rings, then connects when the user answers', async () => {
      const { device, session } = await startedSession();
      const call = new FakeCall({ CallSid: 'CA_in', From: '+15550100100' });

      device.emit('incoming', call);
      expect(session.getState()).toMatchObject({
        callStatus: 'ringing',
        remoteNumber: '+15550100100',
      });

      session.answerIncoming();
      expect(call.accept).toHaveBeenCalledOnce();
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        isMuted: false,
      });
    });

    test('rejects a call the user declines and clears the UI after a moment', async () => {
      const { device, session } = await startedSession();
      const call = new FakeCall({ CallSid: 'CA_in' });
      device.emit('incoming', call);

      session.rejectIncoming();

      expect(call.reject).toHaveBeenCalledOnce();
      expect(session.getState().callStatus).toBe('disconnected');

      vi.advanceTimersByTime(ENDED_DISPLAY_MS);
      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        remoteNumber: null,
      });
    });

    test('applies an answer given before Twilio rang the device', async () => {
      const { device, session } = await startedSession();

      session.answerIncoming();
      const call = new FakeCall({ CallSid: 'CA_in' });
      device.emit('incoming', call);

      expect(call.accept).toHaveBeenCalledOnce();
      expect(session.getState().callStatus).toBe('connected');
    });

    test('applies a rejection given before Twilio rang the device', async () => {
      const { device, session } = await startedSession();

      session.rejectIncoming();
      const call = new FakeCall({ CallSid: 'CA_in' });
      device.emit('incoming', call);

      expect(call.reject).toHaveBeenCalledOnce();
    });

    test('forgets an early answer once it is stale', async () => {
      const { device, session } = await startedSession();

      session.answerIncoming();
      vi.advanceTimersByTime(PENDING_ANSWER_TTL_MS + 1);
      const call = new FakeCall({ CallSid: 'CA_in' });
      device.emit('incoming', call);

      expect(call.accept).not.toHaveBeenCalled();
      expect(session.getState().callStatus).toBe('ringing');
    });

    test('ends the ring when the caller hangs up first', async () => {
      const { device, session } = await startedSession();
      const call = new FakeCall({ CallSid: 'CA_in' });
      device.emit('incoming', call);

      call.emit('cancel');

      expect(session.getState().callStatus).toBe('disconnected');
    });

    test('hanging up while ringing rejects instead of asking the controller', async () => {
      const { device, session, deps } = await startedSession();
      const call = new FakeCall({ CallSid: 'CA_in' });
      device.emit('incoming', call);

      await session.hangUp();

      expect(call.reject).toHaveBeenCalledOnce();
      expect(deps.requestHangup).not.toHaveBeenCalled();
    });

    test('a new ring during the ended display replaces it', async () => {
      const { device, session } = await startedSession();
      const first = new FakeCall({ CallSid: 'CA_1' });
      device.emit('incoming', first);
      first.emit('cancel');
      expect(session.getState().callStatus).toBe('disconnected');

      const second = new FakeCall({ CallSid: 'CA_2', From: '+15550100101' });
      device.emit('incoming', second);
      vi.advanceTimersByTime(ENDED_DISPLAY_MS);

      expect(session.getState()).toMatchObject({
        callStatus: 'ringing',
        remoteNumber: '+15550100101',
      });
    });
  });

  describe('outgoing calls', () => {
    test('asks for a grant to call from the chosen line, dials on it, and connects when Twilio accepts', async () => {
      const { device, session, deps } = await startedSession();
      const call = device.nextCall;

      await session.makeCall('+15550100199', line);

      expect(deps.requestOutboundGrant).toHaveBeenCalledWith(
        '+15550100199',
        line,
      );
      // The grant is all Twilio is told: the number and the line are its.
      expect(device.connect).toHaveBeenCalledWith({
        params: { type: 'outbound-pstn', grant: 'a-grant-token' },
      });
      expect(session.getState()).toMatchObject({
        callStatus: 'connecting',
        remoteNumber: '+15550100199',
      });

      call.emit('ringing');
      expect(session.getState().callStatus).toBe('ringing');

      call.accept();
      expect(session.getState().callStatus).toBe('connected');
    });

    test('shows the call as connecting while the grant is asked for', async () => {
      const { device, session, deps } = await startedSession();
      const grant = deferred<string>();
      vi.mocked(deps.requestOutboundGrant).mockReturnValueOnce(grant.promise);

      const dialing = session.makeCall('+15550100199', line);

      expect(session.getState()).toMatchObject({
        callStatus: 'connecting',
        remoteNumber: '+15550100199',
      });
      expect(device.connect).not.toHaveBeenCalled();

      grant.resolve('a-grant-token');
      await dialing;
      expect(device.connect).toHaveBeenCalledOnce();
    });

    test('a refused grant ends the attempt with the reason the controller gave, and dials nothing', async () => {
      const { device, session, deps } = await startedSession();
      vi.mocked(deps.requestOutboundGrant).mockRejectedValueOnce(
        refusal(
          'line-not-allowed',
          'You are not allowed to call from that number',
        ),
      );

      await session.makeCall('+15550100199', line);

      expect(device.connect).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        remoteNumber: null,
        error: 'You are not allowed to call from that number',
      });
    });

    test('a grant that could not be asked for reads as a call that could not start', async () => {
      const { device, session, deps } = await startedSession();
      vi.mocked(deps.requestOutboundGrant).mockRejectedValueOnce(new Error(''));

      await session.makeCall('+15550100199', line);

      expect(device.connect).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        error: 'The call could not be started',
      });
    });

    test('a second dial while the grant is asked for is refused; one grant, one call', async () => {
      const { device, session, deps } = await startedSession();
      const grant = deferred<string>();
      vi.mocked(deps.requestOutboundGrant).mockReturnValueOnce(grant.promise);

      const first = session.makeCall('+15550100199', line);
      await session.makeCall('+15550100198', line);

      expect(session.getState()).toMatchObject({
        remoteNumber: '+15550100199',
        error: 'A call is already in progress',
      });

      grant.resolve('a-grant-token');
      await first;
      expect(deps.requestOutboundGrant).toHaveBeenCalledOnce();
      expect(device.connect).toHaveBeenCalledOnce();
    });

    test('a call that rings while the grant is asked for keeps the phone; the grant is not used', async () => {
      const { device, session, deps } = await startedSession();
      const grant = deferred<string>();
      vi.mocked(deps.requestOutboundGrant).mockReturnValueOnce(grant.promise);

      const dialing = session.makeCall('+15550100199', line);
      device.emit('incoming', new FakeCall({ From: '+15550100101' }));
      grant.resolve('a-grant-token');
      await dialing;

      expect(device.connect).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        callStatus: 'ringing',
        remoteNumber: '+15550100101',
      });
    });

    test('refuses to dial before the device is ready', async () => {
      const { session, deps } = setup();

      await session.makeCall('+15550100199', line);

      expect(deps.createDevice).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        error: 'The phone is not ready',
      });
    });

    test('never asks for a call that has no line to leave from', async () => {
      const { device, session, deps } = await startedSession();

      await session.makeCall('+15550100199', '');

      expect(deps.requestOutboundGrant).not.toHaveBeenCalled();
      expect(device.connect).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        error: 'Choose a number to call from',
      });
    });

    test('reports a call the device could not start', async () => {
      const { device, session } = await startedSession();
      device.connect.mockRejectedValueOnce(
        new Error('31002: Connection failed'),
      );

      await session.makeCall('+15550100199', line);

      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        remoteNumber: null,
        error: '31002: Connection failed',
      });
    });

    test('asks the controller to end the call, then drops the leg', async () => {
      const { device, session, deps } = await startedSession();
      const call = device.nextCall;
      call.parameters.CallSID = 'CA_out';
      await session.makeCall('+15550100199', line);
      call.accept();

      await session.hangUp();

      expect(deps.requestHangup).toHaveBeenCalledWith('CA_out');
      expect(call.disconnect).toHaveBeenCalledOnce();
      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        isEndingCall: false,
      });
    });

    test('drops the leg even when the controller cannot be reached', async () => {
      const { device, session, deps } = await startedSession();
      const call = device.nextCall;
      call.parameters.CallSID = 'CA_out';
      vi.mocked(deps.requestHangup).mockRejectedValueOnce(
        new Error('Request failed with status 502'),
      );
      await session.makeCall('+15550100199', line);
      call.accept();

      await session.hangUp();

      expect(call.disconnect).toHaveBeenCalledOnce();
      expect(session.getState().error).toBe('Request failed with status 502');
    });

    test('drops a leg Twilio has not named yet without asking the controller', async () => {
      const { device, session, deps } = await startedSession();
      const call = device.nextCall;
      await session.makeCall('+15550100199', line);

      await session.hangUp();

      expect(deps.requestHangup).not.toHaveBeenCalled();
      expect(call.disconnect).toHaveBeenCalledOnce();
    });

    test('ignores a second hangup while one is in flight', async () => {
      const { device, session, deps } = await startedSession();
      const call = device.nextCall;
      call.parameters.CallSID = 'CA_out';
      let release: () => void = () => {};
      vi.mocked(deps.requestHangup).mockImplementationOnce(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      await session.makeCall('+15550100199', line);
      call.accept();

      const first = session.hangUp();
      await session.hangUp();
      release();
      await first;

      expect(deps.requestHangup).toHaveBeenCalledOnce();
      expect(call.disconnect).toHaveBeenCalledOnce();
    });
  });

  describe('during a call', () => {
    async function connectedCall() {
      const context = await startedSession();
      const call = context.device.nextCall;
      await context.session.makeCall('+15550100199', line);
      call.accept();
      return { ...context, call };
    }

    test('mutes and unmutes through the call', async () => {
      const { session, call } = await connectedCall();

      session.toggleMute();
      expect(call.mute).toHaveBeenLastCalledWith(true);
      expect(session.getState().isMuted).toBe(true);

      session.toggleMute();
      expect(call.mute).toHaveBeenLastCalledWith(false);
      expect(session.getState().isMuted).toBe(false);
    });

    test('sends keypad digits to the call', async () => {
      const { session, call } = await connectedCall();

      session.sendDigits('1#');

      expect(call.sendDigits).toHaveBeenCalledWith('1#');
    });

    test('does nothing with digits or mute when no call is connected', async () => {
      const { session, device } = await startedSession();
      const call = new FakeCall({ CallSid: 'CA_in' });
      device.emit('incoming', call);

      session.toggleMute();
      session.sendDigits('1');

      expect(call.mute).not.toHaveBeenCalled();
      expect(call.sendDigits).not.toHaveBeenCalled();
    });

    test('keeps the error of a call that stays up and ends one that closed', async () => {
      const { session, call } = await connectedCall();

      call.emit('error', new Error('31003: Media issue'));
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        error: '31003: Media issue',
      });

      call.disconnect();
      expect(session.getState().callStatus).toBe('disconnected');
    });
  });

  describe('holding a call', () => {
    async function connectedCall(
      overrides: Partial<TelephonySessionDeps> = {},
    ) {
      const context = await startedSession(overrides);
      const call = context.device.nextCall;
      call.parameters = { CallSID: 'CAleg1' };
      await context.session.makeCall('+15555550123', line);
      call.accept();
      return { ...context, call };
    }

    test('asks the controller, and shows the hold once it answers', async () => {
      const answer = deferred<boolean>();
      const { session, deps } = await connectedCall({
        requestHold: vi.fn(() => answer.promise),
      });

      const holding = session.toggleHold();
      expect(deps.requestHold).toHaveBeenCalledWith('CAleg1', true);
      expect(session.getState()).toMatchObject({
        isOnHold: false,
        isHoldPending: true,
      });

      answer.resolve(true);
      await holding;
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        isOnHold: true,
        isHoldPending: false,
      });
    });

    test('takes a held call off hold', async () => {
      const { session, deps } = await connectedCall();

      await session.toggleHold();
      await session.toggleHold();

      expect(deps.requestHold).toHaveBeenLastCalledWith('CAleg1', false);
      expect(session.getState().isOnHold).toBe(false);
    });

    test('a second press while the first is in flight asks nothing more', async () => {
      const answer = deferred<boolean>();
      const { session, deps } = await connectedCall({
        requestHold: vi.fn(() => answer.promise),
      });

      const first = session.toggleHold();
      const second = session.toggleHold();
      answer.resolve(true);
      await Promise.all([first, second]);

      expect(deps.requestHold).toHaveBeenCalledOnce();
      expect(session.getState().isOnHold).toBe(true);
    });

    test('shows what the controller says, not what was pressed', async () => {
      const { session } = await connectedCall({
        requestHold: vi.fn(async () => false),
      });

      await session.toggleHold();

      expect(session.getState().isOnHold).toBe(false);
    });

    test('reports a hold that failed, leaves the call as it was and can try again', async () => {
      const requestHold = vi
        .fn<TelephonySessionDeps['requestHold']>()
        .mockRejectedValueOnce(
          refusal('provider-error', 'The phone provider refused'),
        )
        .mockResolvedValueOnce(true);
      const { session } = await connectedCall({ requestHold });

      await session.toggleHold();
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        isOnHold: false,
        isHoldPending: false,
        error: 'The phone provider refused',
      });

      await session.toggleHold();
      expect(session.getState()).toMatchObject({
        isOnHold: true,
        error: null,
      });
    });

    test('reports a resume that failed and keeps the call held', async () => {
      const requestHold = vi
        .fn<TelephonySessionDeps['requestHold']>()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce('unreachable');
      const { session } = await connectedCall({ requestHold });

      await session.toggleHold();
      await session.toggleHold();

      expect(session.getState()).toMatchObject({
        isOnHold: true,
        isHoldPending: false,
        error: 'The call could not be taken off hold',
      });
    });

    test('does nothing while the call is still ringing', async () => {
      const { session, device, deps } = await startedSession();
      device.emit('incoming', new FakeCall({ CallSid: 'CA_in' }));

      await session.toggleHold();

      expect(deps.requestHold).not.toHaveBeenCalled();
      expect(session.getState().isHoldPending).toBe(false);
    });

    test('hold and mute do not touch each other', async () => {
      const { session } = await connectedCall();

      session.toggleMute();
      await session.toggleHold();
      expect(session.getState()).toMatchObject({
        isMuted: true,
        isOnHold: true,
      });

      session.toggleMute();
      expect(session.getState()).toMatchObject({
        isMuted: false,
        isOnHold: true,
      });

      await session.toggleHold();
      session.toggleMute();
      expect(session.getState()).toMatchObject({
        isMuted: true,
        isOnHold: false,
      });
    });

    test('hanging up a held call ends it like any other', async () => {
      const { session, deps, call } = await connectedCall();
      await session.toggleHold();

      await session.hangUp();

      expect(deps.requestHangup).toHaveBeenCalledWith('CAleg1');
      expect(call.disconnect).toHaveBeenCalledOnce();
      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        endReason: 'ended',
        isOnHold: false,
      });
    });

    test('the held party hanging up ends the call and the hold with it', async () => {
      const { session, call } = await connectedCall();
      await session.toggleHold();

      call.emit('disconnect');

      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        isOnHold: false,
        isHoldPending: false,
      });
    });

    test('an answer that comes after the call ended changes nothing', async () => {
      const answer = deferred<boolean>();
      const { session, call } = await connectedCall({
        requestHold: vi.fn(() => answer.promise),
      });

      const holding = session.toggleHold();
      call.emit('disconnect');
      answer.resolve(true);
      await holding;

      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        isOnHold: false,
        isHoldPending: false,
      });
    });
  });

  describe('transferring a call', () => {
    const morgan = { id: 'user-9', name: 'Morgan Reyes' };
    const avery = { id: 'user-8', name: 'Avery Stone' };
    const answered = {
      conversationUuid: 'CAcall1',
      targetUserId: 'user-9',
      status: 'completed',
    } as const;
    const failed = {
      conversationUuid: 'CAcall1',
      targetUserId: 'user-9',
      status: 'failed',
    } as const;

    async function connectedCall(
      overrides: Partial<TelephonySessionDeps> = {},
    ) {
      const context = await startedSession(overrides);
      const call = context.device.nextCall;
      call.parameters = { CallSID: 'CAleg1' };
      await context.session.makeCall('+15555550123', line);
      call.accept();
      return { ...context, call };
    }

    /** Morgan's softphone is ringing for the call. */
    async function transferringCall(
      overrides: Partial<TelephonySessionDeps> = {},
    ) {
      const context = await connectedCall(overrides);
      await context.session.transferTo(morgan);
      return context;
    }

    test('shows the transfer while the controller rings the teammate', async () => {
      const answer = deferred<{ conversationUuid: string }>();
      const { session, deps } = await connectedCall({
        requestTransfer: vi.fn(() => answer.promise),
      });

      const transferring = session.transferTo(morgan);
      expect(deps.requestTransfer).toHaveBeenCalledWith('CAleg1', 'user-9');
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        isOnHold: false,
        transfer: {
          targetUserId: 'user-9',
          targetName: 'Morgan Reyes',
          status: 'requesting',
        },
      });

      answer.resolve({ conversationUuid: 'CAcall1' });
      await transferring;
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        isOnHold: true,
        transfer: { targetUserId: 'user-9', status: 'ringing' },
      });
    });

    test('a leg released after the teammate answered reads as transferred, not ended', async () => {
      const { session, call } = await transferringCall();

      session.applyTransferOutcome(answered);
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        transfer: { status: 'answered' },
      });

      call.emit('disconnect');
      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        endReason: 'transferred',
        transfer: null,
        isOnHold: false,
      });

      vi.advanceTimersByTime(ENDED_DISPLAY_MS);
      expect(session.getState().callStatus).toBe('idle');
    });

    test('the call after a transferred one ends as ended', async () => {
      const { session, device, call } = await transferringCall();
      session.applyTransferOutcome(answered);
      call.emit('disconnect');
      vi.advanceTimersByTime(ENDED_DISPLAY_MS);

      const next = new FakeCall({ CallSID: 'CAleg7' });
      device.nextCall = next;
      await session.makeCall('+15555550123', line);
      next.accept();
      next.emit('disconnect');

      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        endReason: 'ended',
      });
    });

    test('an outcome that arrives after the leg dropped still reads as transferred', async () => {
      const { session, call } = await transferringCall();

      call.emit('disconnect');
      expect(session.getState().endReason).toBe('ended');

      vi.advanceTimersByTime(ENDED_DISPLAY_MS - 100);
      session.applyTransferOutcome(answered);
      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        endReason: 'transferred',
      });

      // "Call transferred" gets its own moment on screen.
      vi.advanceTimersByTime(ENDED_DISPLAY_MS - 100);
      expect(session.getState().callStatus).toBe('disconnected');
      vi.advanceTimersByTime(100);
      expect(session.getState().callStatus).toBe('idle');
    });

    test('an outcome that arrives once the call has left the screen is ignored', async () => {
      const { session, call, states } = await transferringCall();
      call.emit('disconnect');
      vi.advanceTimersByTime(ENDED_DISPLAY_MS);
      const reported = states.length;

      session.applyTransferOutcome(answered);
      session.applyTransferOutcome(failed);

      expect(states).toHaveLength(reported);
      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        endReason: 'ended',
      });
    });

    test.each([
      ['declined', 'Morgan Reyes declined the call'],
      ['no-answer', 'Morgan Reyes did not answer'],
      ['unavailable', 'Morgan Reyes could not be reached'],
      [undefined, 'Morgan Reyes could not be reached'],
    ] as const)(
      'a transfer that failed as %s brings the call back and says why',
      async (reason, notice) => {
        const { session } = await transferringCall();

        session.applyTransferOutcome({ ...failed, reason });

        expect(session.getState()).toMatchObject({
          callStatus: 'connected',
          transfer: null,
          isOnHold: false,
          notice,
        });
      },
    );

    test('the next hold or transfer clears what the last transfer said', async () => {
      const { session } = await transferringCall();
      session.applyTransferOutcome({ ...failed, reason: 'declined' });

      await session.toggleHold();

      expect(session.getState()).toMatchObject({
        isOnHold: true,
        notice: null,
      });
    });

    test('a failure that overtakes the controller answer is not undone by it', async () => {
      const answer = deferred<{ conversationUuid: string }>();
      const { session } = await connectedCall({
        requestTransfer: vi.fn(() => answer.promise),
      });
      const transferring = session.transferTo(morgan);

      session.applyTransferOutcome({ ...failed, reason: 'declined' });
      answer.resolve({ conversationUuid: 'CAcall1' });
      await transferring;

      expect(session.getState()).toMatchObject({
        transfer: null,
        isOnHold: false,
        notice: 'Morgan Reyes declined the call',
      });
    });

    test('a refusal that follows the outcome does not replace what it said', async () => {
      const answer = deferred<{ conversationUuid: string }>();
      const { session } = await connectedCall({
        requestTransfer: vi.fn(() => answer.promise),
      });
      const transferring = session.transferTo(morgan);

      session.applyTransferOutcome({ ...failed, reason: 'declined' });
      answer.reject(
        refusal('no-transfer-pending', 'No transfer is ringing for this call'),
      );
      await transferring;

      expect(session.getState()).toMatchObject({
        transfer: null,
        notice: 'Morgan Reyes declined the call',
      });
    });

    test.each([
      [
        'target-offline',
        'That teammate is not online',
        'Morgan Reyes is not online',
      ],
      [
        'target-on-call',
        'That teammate is already on the call',
        'Morgan Reyes is already on this call',
      ],
      [
        'not-connected',
        'The call is not connected',
        'The call is not connected',
      ],
    ])(
      'a transfer refused as %s says so with the teammate named',
      async (code, message, notice) => {
        const { session } = await connectedCall({
          requestTransfer: vi.fn(async () => {
            throw refusal(code, message);
          }),
        });

        await session.transferTo(morgan);

        expect(session.getState()).toMatchObject({
          callStatus: 'connected',
          transfer: null,
          notice,
        });
      },
    );

    test('a refused transfer leaves a call that was held on hold', async () => {
      const { session } = await connectedCall({
        requestTransfer: vi.fn(async () => {
          throw refusal('target-offline', 'That teammate is not online');
        }),
      });
      await session.toggleHold();

      await session.transferTo(morgan);

      expect(session.getState()).toMatchObject({
        isOnHold: true,
        transfer: null,
      });
    });

    test('a refusal from a controller that had already touched the hold ends the hold here too', async () => {
      const { session } = await connectedCall({
        requestTransfer: vi.fn(async () => {
          throw refusal(
            'provider-error',
            'The phone provider did not accept the request',
          );
        }),
      });
      await session.toggleHold();

      await session.transferTo(morgan);
      // The failed outcome comes second and finds the attempt settled.
      session.applyTransferOutcome({ ...failed, reason: 'unavailable' });

      expect(session.getState()).toMatchObject({
        isOnHold: false,
        transfer: null,
        notice: 'The phone provider did not accept the request',
      });
    });

    test('a refusal that comes before the outcome leaves it to the outcome to say why', async () => {
      const { session } = await connectedCall({
        requestTransfer: vi.fn(async () => {
          throw refusal(
            'no-transfer-pending',
            'No transfer is ringing for this call',
          );
        }),
      });

      await session.transferTo(morgan);
      expect(session.getState()).toMatchObject({
        transfer: null,
        isOnHold: false,
        notice: 'Morgan Reyes could not be reached',
      });

      session.applyTransferOutcome({ ...failed, reason: 'declined' });
      expect(session.getState()).toMatchObject({
        transfer: null,
        notice: 'Morgan Reyes declined the call',
      });
    });

    describe('when the controller answer was lost', () => {
      const unconfirmed =
        'The transfer could not be confirmed. Cancel it to take the call back.';

      async function unconfirmedTransfer(
        overrides: Partial<TelephonySessionDeps> = {},
      ) {
        const context = await connectedCall({
          requestTransfer: vi.fn(async () => {
            throw new Error('Failed to fetch');
          }),
          ...overrides,
        });
        await context.session.transferTo(morgan);
        return context;
      }

      test('the transfer stays on screen, where it can be called off', async () => {
        const { session } = await unconfirmedTransfer();

        expect(session.getState()).toMatchObject({
          callStatus: 'connected',
          transfer: { targetUserId: 'user-9', status: 'ringing' },
          error: unconfirmed,
        });
      });

      test('a server error leaves it open as well', async () => {
        const { session } = await unconfirmedTransfer({
          requestTransfer: vi.fn(async () => {
            throw Object.assign(new Error('Internal Server Error'), {
              status: 500,
            });
          }),
        });

        expect(session.getState()).toMatchObject({
          transfer: { status: 'ringing' },
          error: unconfirmed,
        });
      });

      test('an answer that turns the request down without a reason settles it', async () => {
        const { session } = await connectedCall({
          requestTransfer: vi.fn(async () => {
            throw Object.assign(new Error('The session has expired'), {
              status: 401,
            });
          }),
        });

        await session.transferTo(morgan);
        expect(session.getState()).toMatchObject({
          transfer: null,
          notice: 'The session has expired',
          error: null,
        });

        // Nothing is left waiting for an outcome.
        session.applyTransferOutcome({ ...failed, reason: 'declined' });
        expect(session.getState().notice).toBe('The session has expired');
      });

      test('the teammate answering hands the call over', async () => {
        const { session, call } = await unconfirmedTransfer();

        session.applyTransferOutcome(answered);
        expect(session.getState()).toMatchObject({
          transfer: { status: 'answered' },
          error: null,
        });

        call.emit('disconnect');
        expect(session.getState()).toMatchObject({
          callStatus: 'disconnected',
          endReason: 'transferred',
        });
      });

      test('the transfer failing says why in place of the warning', async () => {
        const { session } = await unconfirmedTransfer();

        session.applyTransferOutcome({ ...failed, reason: 'no-answer' });

        expect(session.getState()).toMatchObject({
          transfer: null,
          isOnHold: false,
          notice: 'Morgan Reyes did not answer',
          error: null,
        });
      });

      test('cancelling calls off a transfer that did go through', async () => {
        const { session, deps } = await unconfirmedTransfer();

        await session.cancelTransfer();

        expect(deps.requestTransferCancel).toHaveBeenCalledWith('CAleg1');
        expect(session.getState()).toMatchObject({
          transfer: null,
          isOnHold: false,
          error: null,
        });
      });

      test('cancelling one that never began leaves a held call on hold', async () => {
        const { session } = await connectedCall({
          requestTransfer: vi.fn(async () => {
            throw 'offline';
          }),
          requestTransferCancel: vi.fn(async () => {
            throw refusal(
              'no-transfer-pending',
              'No transfer is ringing for this call',
            );
          }),
        });
        await session.toggleHold();
        await session.transferTo(morgan);

        await session.cancelTransfer();

        expect(session.getState()).toMatchObject({
          transfer: null,
          isOnHold: true,
          error: null,
        });
      });
    });

    test('an outcome for another teammate or another call is not this one', async () => {
      const { session } = await transferringCall();

      session.applyTransferOutcome({ ...failed, targetUserId: 'user-8' });
      session.applyTransferOutcome({
        ...answered,
        conversationUuid: 'CAother',
      });

      expect(session.getState()).toMatchObject({
        transfer: { targetUserId: 'user-9', status: 'ringing' },
        isOnHold: true,
      });
    });

    test('an outcome delivered twice does not settle the transfer that came next', async () => {
      const { session } = await transferringCall();
      session.applyTransferOutcome({ ...failed, reason: 'no-answer' });
      await session.transferTo(avery);

      session.applyTransferOutcome({ ...failed, reason: 'no-answer' });

      expect(session.getState()).toMatchObject({
        transfer: { targetUserId: 'user-8', status: 'ringing' },
        notice: null,
      });
    });

    test('one transfer at a time, and no hold while it rings', async () => {
      const { session, deps } = await transferringCall();

      await session.transferTo(avery);
      await session.toggleHold();

      expect(deps.requestTransfer).toHaveBeenCalledOnce();
      expect(deps.requestHold).not.toHaveBeenCalled();
      expect(session.getState().transfer).toMatchObject({
        targetUserId: 'user-9',
      });
    });

    test('does nothing when no call is connected', async () => {
      const { session, deps } = await startedSession();

      await session.transferTo(morgan);
      await session.cancelTransfer();

      expect(deps.requestTransfer).not.toHaveBeenCalled();
      expect(deps.requestTransferCancel).not.toHaveBeenCalled();
      expect(session.getState().transfer).toBeNull();
    });

    test('cancelling gives the call back', async () => {
      const answer = deferred<void>();
      const { session, deps } = await transferringCall({
        requestTransferCancel: vi.fn(() => answer.promise),
      });

      const cancelling = session.cancelTransfer();
      expect(deps.requestTransferCancel).toHaveBeenCalledWith('CAleg1');
      expect(session.getState().transfer).toMatchObject({
        status: 'cancelling',
      });

      answer.resolve();
      await cancelling;
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        transfer: null,
        isOnHold: false,
        notice: null,
      });
    });

    test('a transfer the controller has not confirmed yet cannot be cancelled', async () => {
      const answer = deferred<{ conversationUuid: string }>();
      const { session, deps } = await connectedCall({
        requestTransfer: vi.fn(() => answer.promise),
      });
      const transferring = session.transferTo(morgan);

      await session.cancelTransfer();
      expect(deps.requestTransferCancel).not.toHaveBeenCalled();
      expect(session.getState().transfer).toMatchObject({
        status: 'requesting',
      });

      answer.resolve({ conversationUuid: 'CAcall1' });
      await transferring;
      await session.cancelTransfer();
      expect(deps.requestTransferCancel).toHaveBeenCalledOnce();
    });

    test('a second cancel while one is in flight asks nothing more', async () => {
      const answer = deferred<void>();
      const { session, deps } = await transferringCall({
        requestTransferCancel: vi.fn(() => answer.promise),
      });

      const first = session.cancelTransfer();
      const second = session.cancelTransfer();
      answer.resolve();
      await Promise.all([first, second]);

      expect(deps.requestTransferCancel).toHaveBeenCalledOnce();
    });

    test('the cancelled outcome and the controller answer settle it once, in either order', async () => {
      const answer = deferred<void>();
      const { session, states } = await transferringCall({
        requestTransferCancel: vi.fn(() => answer.promise),
      });
      const cancelling = session.cancelTransfer();

      session.applyTransferOutcome({ ...failed, reason: 'cancelled' });
      expect(session.getState()).toMatchObject({
        transfer: null,
        isOnHold: false,
        notice: null,
      });
      const reported = states.length;

      answer.resolve();
      await cancelling;
      expect(states).toHaveLength(reported);
    });

    test('a cancel that did not get through goes back to ringing and says so', async () => {
      const { session } = await transferringCall({
        requestTransferCancel: vi.fn(async () => {
          throw new Error('Failed to fetch');
        }),
      });

      await session.cancelTransfer();

      expect(session.getState()).toMatchObject({
        transfer: { targetUserId: 'user-9', status: 'ringing' },
        isOnHold: true,
        error: 'Failed to fetch',
      });
    });

    test('a cancel that found nothing ringing leaves it to the outcome to say what happened', async () => {
      const { session, call } = await transferringCall({
        requestTransferCancel: vi.fn(async () => {
          throw refusal(
            'no-transfer-pending',
            'No transfer is ringing for this call',
          );
        }),
      });

      await session.cancelTransfer();
      expect(session.getState()).toMatchObject({
        callStatus: 'connected',
        transfer: null,
        isOnHold: false,
        error: null,
      });

      session.applyTransferOutcome(answered);
      call.emit('disconnect');
      expect(session.getState().endReason).toBe('transferred');
    });

    test('an answered transfer can no longer be cancelled', async () => {
      const { session, deps } = await transferringCall();
      session.applyTransferOutcome(answered);

      await session.cancelTransfer();

      expect(deps.requestTransferCancel).not.toHaveBeenCalled();
    });

    test('hanging up while the teammate rings leaves the transfer to go on', async () => {
      const { session, deps } = await transferringCall();

      await session.hangUp();
      expect(deps.requestHangup).toHaveBeenCalledWith('CAleg1');
      expect(deps.requestTransferCancel).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        endReason: 'ended',
        transfer: null,
      });

      session.applyTransferOutcome(answered);
      expect(session.getState().endReason).toBe('transferred');
    });

    test('a transfer that fails after the user left has nobody to tell', async () => {
      const { session, states } = await transferringCall();
      await session.hangUp();
      const reported = states.length;

      session.applyTransferOutcome({ ...failed, reason: 'no-answer' });

      expect(states).toHaveLength(reported);
      expect(session.getState().notice).toBeNull();
    });

    test('an outcome from the last call does not mark the next one', async () => {
      const { session, device, call } = await transferringCall();
      call.emit('disconnect');

      // Dialling again before "Call ended" left the screen.
      const next = new FakeCall({ CallSID: 'CAleg7' });
      device.nextCall = next;
      await session.makeCall('+15555550123', line);
      next.accept();

      session.applyTransferOutcome(answered);
      next.emit('disconnect');

      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        endReason: 'ended',
      });
    });

    test('the controller answer for a call that has ended changes nothing', async () => {
      const answer = deferred<{ conversationUuid: string }>();
      const { session, call } = await connectedCall({
        requestTransfer: vi.fn(() => answer.promise),
      });
      const transferring = session.transferTo(morgan);

      call.emit('disconnect');
      answer.resolve({ conversationUuid: 'CAcall1' });
      await transferring;

      expect(session.getState()).toMatchObject({
        callStatus: 'disconnected',
        isOnHold: false,
        transfer: null,
      });
    });
  });

  describe('dispose', () => {
    test('destroys the device and stops reporting', async () => {
      const { session, device, states } = await startedSession();
      const reported = states.length;

      session.dispose();
      device.emit('unregistered');

      expect(device.destroy).toHaveBeenCalledOnce();
      expect(states).toHaveLength(reported);
    });

    test('does not create a device when disposed while starting', async () => {
      let resolveMicrophone: () => void = () => {};
      const context = setup({
        requestMicrophone: vi.fn(
          () => new Promise<void>((resolve) => (resolveMicrophone = resolve)),
        ),
      });

      const starting = context.session.start();
      context.session.dispose();
      resolveMicrophone();
      await starting;

      expect(context.deps.createDevice).not.toHaveBeenCalled();
    });
  });
});
