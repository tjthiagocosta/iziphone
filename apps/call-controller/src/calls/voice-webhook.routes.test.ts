import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createControllerRouteApp } from '../test/route-test-helpers.js';
import {
  type VoiceWebhookFlow,
  voiceWebhookRoutes,
} from './voice-webhook.routes.js';

const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

function buildFlow() {
  return {
    startOutboundCall: vi.fn(async () => '<Response><Dial/></Response>'),
    acceptInboundCall: vi.fn(async () => '<Response><Dial/></Response>'),
    handleRecordingReady: vi.fn(async () => undefined),
    handleTranscriptionReady: vi.fn(async () => undefined),
    handleConferenceEvent: vi.fn(async () => undefined),
    handleCallStatus: vi.fn(async () => undefined),
  } satisfies VoiceWebhookFlow;
}

const telephony = {
  buildVoicemailCompletionTwiml: () =>
    '<Response><Say>Thank you for your message. Goodbye.</Say></Response>',
  buildFallbackTwiml: () =>
    '<Response><Say>We could not complete your call.</Say></Response>',
};

describe('voiceWebhookRoutes', () => {
  let app: FastifyInstance;
  let flow: ReturnType<typeof buildFlow>;

  beforeEach(async () => {
    flow = buildFlow();
    app = await createControllerRouteApp(voiceWebhookRoutes, {
      config: { nodeEnv: 'development' },
      registerOptions: { flow, telephony },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, payload: string) =>
    app.inject({ method: 'POST', url, headers: formHeaders, payload });

  describe('inbound', () => {
    test('rejects a payload without a CallSid', async () => {
      const response = await post(
        '/webhooks/twilio/voice/inbound',
        'From=%2B15555550101&To=%2B15555550102',
      );

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Invalid webhook payload' });
      expect(flow.acceptInboundCall).not.toHaveBeenCalled();
    });

    test('rejects an inbound call without both numbers', async () => {
      const response = await post(
        '/webhooks/twilio/voice/inbound',
        'CallSid=CAcall1&From=%2B15555550101',
      );

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Inbound call payload is incomplete',
      });
    });

    test('answers an inbound call with the TwiML the flow decides on', async () => {
      const response = await post(
        '/webhooks/twilio/voice/inbound',
        'CallSid=CAcall1&From=%2B15555550101&To=%2B15555550102',
      );

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/xml');
      expect(response.body).toBe('<Response><Dial/></Response>');
      expect(flow.acceptInboundCall).toHaveBeenCalledWith({
        callSid: 'CAcall1',
        from: '+15555550101',
        to: '+15555550102',
      });
    });

    test('starts an outbound call from the softphone with the number in E.164', async () => {
      const response = await post(
        '/webhooks/twilio/voice/inbound',
        'CallSid=CAagent1&From=client%3Auser-1&type=outbound-pstn&to=%28555%29%20555-0199',
      );

      expect(response.statusCode).toBe(200);
      expect(flow.startOutboundCall).toHaveBeenCalledWith({
        callSid: 'CAagent1',
        agentUserId: 'user-1',
        targetNumber: '+15555550199',
      });
    });

    test('rejects an outbound call to a number that cannot be dialed', async () => {
      const response = await post(
        '/webhooks/twilio/voice/inbound',
        'CallSid=CAagent1&From=client%3Auser-1&type=outbound-pstn&to=12',
      );

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Outbound call context is incomplete',
      });
    });
  });

  describe('status', () => {
    test('ignores callbacks it cannot tie to a call', async () => {
      const response = await post(
        '/webhooks/twilio/voice/status',
        'CallSid=CAleg1&RecordingStatus=in-progress',
      );

      expect(response.statusCode).toBe(204);
      expect(flow.handleCallStatus).not.toHaveBeenCalled();
      expect(flow.handleRecordingReady).not.toHaveBeenCalled();
    });

    test('treats a status callback without a conversation as the leg that started the call', async () => {
      const response = await post(
        '/webhooks/twilio/voice/status',
        'CallSid=CAcall1&CallStatus=completed&CallDuration=42',
      );

      expect(response.statusCode).toBe(204);
      expect(flow.handleCallStatus).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        legUuid: 'CAcall1',
        participantLabel: undefined,
        status: 'completed',
        duration: 42,
      });
    });

    test('hands a completed voicemail recording to the flow', async () => {
      const response = await post(
        '/webhooks/twilio/voice/status?conversationUuid=CAcall1&context=closed-hours',
        'RecordingStatus=completed&RecordingUrl=https%3A%2F%2Fapi.twilio.example.com%2FRE1&RecordingDuration=18',
      );

      expect(response.statusCode).toBe(204);
      expect(flow.handleRecordingReady).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        recordingUrl: 'https://api.twilio.example.com/RE1',
        duration: 18,
        context: 'closed-hours',
      });
    });

    test('hands a transcription to the flow', async () => {
      await post(
        '/webhooks/twilio/voice/status?conversationUuid=CAcall1&context=closed-hours',
        'TranscriptionStatus=completed&TranscriptionText=Call%20me%20back',
      );

      expect(flow.handleTranscriptionReady).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        transcript: 'Call me back',
        recordingUrl: undefined,
        context: 'closed-hours',
      });
    });

    test('reads the conversation from the conference name of a conference event', async () => {
      await post(
        '/webhooks/twilio/voice/status',
        'FriendlyName=call-CAcall1&ConferenceSid=CFconf1&StatusCallbackEvent=participant-join&CallSid=CAleg1&ParticipantLabel=agent%7Cuser-1%7Cnonce',
      );

      expect(flow.handleConferenceEvent).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        conferenceSid: 'CFconf1',
        event: 'participant-join',
        legUuid: 'CAleg1',
        participantLabel: 'agent|user-1|nonce',
        duration: undefined,
      });
    });

    test('hands a leg status change to the flow', async () => {
      await post(
        '/webhooks/twilio/voice/status?conversationUuid=CAcall1&source=participant',
        'CallSid=CAleg1&CallStatus=no-answer&CallDuration=0',
      );

      expect(flow.handleCallStatus).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        participantLabel: undefined,
        status: 'no-answer',
        duration: 0,
      });
    });

    test('treats a duration that is not a number as unknown', async () => {
      await post(
        '/webhooks/twilio/voice/status?conversationUuid=CAcall1',
        'CallSid=CAleg1&CallStatus=completed&CallDuration=abc',
      );

      expect(flow.handleCallStatus).toHaveBeenCalledWith(
        expect.objectContaining({ duration: undefined }),
      );
    });
  });

  test('closes a voicemail with a goodbye', async () => {
    const response = await post(
      '/webhooks/twilio/voice/voicemail/completed?conversationUuid=CAcall1',
      'RecordingUrl=https%3A%2F%2Fapi.twilio.example.com%2FRE1',
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(response.body).toContain('Thank you for your message');
  });

  test('answers the fallback route with an apology', async () => {
    const response = await post('/webhooks/twilio/voice/fallback', '');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('We could not complete your call');
  });

  test('requires a Twilio signature outside development', async () => {
    const production = await createControllerRouteApp(voiceWebhookRoutes, {
      registerOptions: { flow, telephony },
    });

    const response = await production.inject({
      method: 'POST',
      url: '/webhooks/twilio/voice/inbound',
      headers: formHeaders,
      payload: 'CallSid=CAcall1&From=%2B15555550101&To=%2B15555550102',
    });

    expect(response.statusCode).toBe(403);
    expect(flow.acceptInboundCall).not.toHaveBeenCalled();
    await production.close();
  });
});
