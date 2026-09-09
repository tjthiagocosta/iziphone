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
    requestHangup: vi.fn(async () => {}),
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

async function startedSession() {
  const context = setup();
  await context.session.start();
  return context;
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
    test('dials through the device and connects when Twilio accepts', async () => {
      const { device, session } = await startedSession();
      const call = device.nextCall;

      await session.makeCall('+15550100199');

      expect(device.connect).toHaveBeenCalledWith({
        params: { type: 'outbound-pstn', to: '+15550100199' },
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

    test('refuses to dial before the device is ready', async () => {
      const { session, deps } = setup();

      await session.makeCall('+15550100199');

      expect(deps.createDevice).not.toHaveBeenCalled();
      expect(session.getState()).toMatchObject({
        callStatus: 'idle',
        error: 'The phone is not ready',
      });
    });

    test('reports a call the device could not start', async () => {
      const { device, session } = await startedSession();
      device.connect.mockRejectedValueOnce(
        new Error('31002: Connection failed'),
      );

      await session.makeCall('+15550100199');

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
      await session.makeCall('+15550100199');
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
      await session.makeCall('+15550100199');
      call.accept();

      await session.hangUp();

      expect(call.disconnect).toHaveBeenCalledOnce();
      expect(session.getState().error).toBe('Request failed with status 502');
    });

    test('drops a leg Twilio has not named yet without asking the controller', async () => {
      const { device, session, deps } = await startedSession();
      const call = device.nextCall;
      await session.makeCall('+15550100199');

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
      await session.makeCall('+15550100199');
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
      await context.session.makeCall('+15550100199');
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
