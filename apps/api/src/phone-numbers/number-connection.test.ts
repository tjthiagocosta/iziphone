import type { Campaign } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  campaignFrom,
  connectingUpdate,
  describeReconnect,
  describeTextingNote,
  keepsIncomingTexts,
  type NumberSettings,
  reconnectReasons,
  textingNote,
  type WebhookAddresses,
} from './number-connection.js';

const EXPECTED: WebhookAddresses = {
  messagesInbound: 'https://api.example.com/webhooks/twilio/messages/inbound',
  voice: 'https://calls.example.com/webhooks/twilio/voice/inbound',
  voiceFallback: 'https://calls.example.com/webhooks/twilio/voice/fallback',
  voiceStatus: 'https://calls.example.com/webhooks/twilio/voice/status',
};

const POINTED_HERE: NumberSettings = {
  voiceUrl: EXPECTED.voice,
  voiceMethod: 'POST',
  voiceFallbackUrl: EXPECTED.voiceFallback,
  voiceFallbackMethod: 'POST',
  statusCallback: EXPECTED.voiceStatus,
  statusCallbackMethod: 'POST',
  smsUrl: EXPECTED.messagesInbound,
  smsMethod: 'POST',
  voiceApplicationSid: null,
  smsApplicationSid: null,
  trunkSid: null,
};

const CUSTOMER_CARE = {
  sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  friendlyName: 'Customer Care',
};
const ELSEWHERE = 'https://agent.example.com/sms';
const APPROVED: Campaign = {
  status: 'approved',
  twilioStatus: 'VERIFIED',
  useCase: 'CUSTOMER_CARE',
  description: 'Replies to customers who wrote first',
};

describe('reconnectReasons', () => {
  test('finds nothing to fix on a number pointed here', () => {
    expect(reconnectReasons(POINTED_HERE, EXPECTED)).toEqual([]);
  });

  test('counts a trailing slash as pointing elsewhere, since no route answers it', () => {
    expect(
      reconnectReasons(
        { ...POINTED_HERE, voiceFallbackUrl: `${EXPECTED.voiceFallback}/` },
        EXPECTED,
      ),
    ).toEqual(['voice-fallback-url']);
  });

  test('names each webhook that points elsewhere', () => {
    expect(
      reconnectReasons(
        {
          ...POINTED_HERE,
          voiceUrl: 'https://demo.example.com/welcome/voice',
          smsUrl: null,
        },
        EXPECTED,
      ),
    ).toEqual(['voice-url', 'sms-url']);
  });

  test('counts a webhook at the right address that Twilio calls with GET', () => {
    expect(
      reconnectReasons(
        { ...POINTED_HERE, voiceMethod: 'GET', smsMethod: 'get' },
        EXPECTED,
      ),
    ).toEqual(['voice-url', 'sms-url']);
    // Twilio calls with POST when no method is set.
    expect(
      reconnectReasons(
        { ...POINTED_HERE, statusCallbackMethod: null },
        EXPECTED,
      ),
    ).toEqual([]);
  });

  test('counts an attached TwiML App, application or SIP trunk although the webhooks are right', () => {
    expect(
      reconnectReasons(
        {
          ...POINTED_HERE,
          voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          smsApplicationSid: 'APbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        EXPECTED,
      ),
    ).toEqual(['voice-application', 'sms-application']);
    expect(
      reconnectReasons(
        { ...POINTED_HERE, trunkSid: 'TKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        EXPECTED,
      ),
    ).toEqual(['sip-trunk']);
  });

  test('leaves a messaging service sid to the texting note, since Reconnect does not change services', () => {
    expect(
      reconnectReasons(
        { ...POINTED_HERE, smsApplicationSid: CUSTOMER_CARE.sid },
        EXPECTED,
      ),
    ).toEqual([]);
  });
});

describe('connectingUpdate', () => {
  test('points every webhook here with POST', () => {
    expect(connectingUpdate(POINTED_HERE, EXPECTED)).toEqual({
      smsUrl: EXPECTED.messagesInbound,
      smsMethod: 'POST',
      statusCallback: EXPECTED.voiceStatus,
      statusCallbackMethod: 'POST',
      voiceUrl: EXPECTED.voice,
      voiceMethod: 'POST',
      voiceFallbackUrl: EXPECTED.voiceFallback,
      voiceFallbackMethod: 'POST',
    });
  });

  test('clears only what is attached', () => {
    const update = connectingUpdate(
      {
        ...POINTED_HERE,
        voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        trunkSid: 'TKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      EXPECTED,
    );

    expect(update).toMatchObject({ voiceApplicationSid: '', trunkSid: '' });
    expect(update).not.toHaveProperty('smsApplicationSid');
  });

  test('never takes a number out of its messaging service', () => {
    expect(
      connectingUpdate(
        { ...POINTED_HERE, smsApplicationSid: CUSTOMER_CARE.sid },
        EXPECTED,
      ),
    ).not.toHaveProperty('smsApplicationSid');
    expect(
      connectingUpdate(
        {
          ...POINTED_HERE,
          smsApplicationSid: 'APbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        EXPECTED,
      ),
    ).toMatchObject({ smsApplicationSid: '' });
  });
});

describe('textingNote', () => {
  const local = { local: true, texts: true };

  test('warns when the number’s service sends its texts to its own address', () => {
    expect(
      textingNote(
        local,
        {
          ...CUSTOMER_CARE,
          useInboundWebhookOnNumber: false,
          inboundRequestUrl: ELSEWHERE,
          inboundMethod: 'POST',
        },
        APPROVED,
        EXPECTED.messagesInbound,
      ),
    ).toEqual({ kind: 'service-takes-texts', service: CUSTOMER_CARE });
  });

  test('says nothing once the service lets the number’s webhook take its texts', () => {
    expect(
      textingNote(
        local,
        {
          ...CUSTOMER_CARE,
          useInboundWebhookOnNumber: true,
          inboundRequestUrl: ELSEWHERE,
          inboundMethod: 'POST',
        },
        APPROVED,
        EXPECTED.messagesInbound,
      ),
    ).toBeNull();
  });

  test('says nothing when the service posts to this deployment itself', () => {
    expect(
      textingNote(
        local,
        {
          ...CUSTOMER_CARE,
          useInboundWebhookOnNumber: false,
          inboundRequestUrl: EXPECTED.messagesInbound,
          inboundMethod: null,
        },
        APPROVED,
        EXPECTED.messagesInbound,
      ),
    ).toBeNull();
  });

  test.each([
    ['with GET', EXPECTED.messagesInbound, 'GET'],
    ['with a trailing slash', `${EXPECTED.messagesInbound}/`, 'POST'],
  ])(
    'warns when the service calls this deployment %s, which no route answers',
    (_how, inboundRequestUrl, inboundMethod) => {
      expect(
        textingNote(
          local,
          {
            ...CUSTOMER_CARE,
            useInboundWebhookOnNumber: false,
            inboundRequestUrl,
            inboundMethod,
          },
          APPROVED,
          EXPECTED.messagesInbound,
        ),
      ).toEqual({ kind: 'service-takes-texts', service: CUSTOMER_CARE });
    },
  );

  test('notes that a local number in no service cannot text yet', () => {
    expect(textingNote(local, null, null, EXPECTED.messagesInbound)).toEqual({
      kind: 'unregistered',
    });
  });

  test('leaves toll-free and text-less numbers in no service alone', () => {
    expect(
      textingNote(
        { local: false, texts: true },
        null,
        null,
        EXPECTED.messagesInbound,
      ),
    ).toBeNull();
    expect(
      textingNote(
        { local: true, texts: false },
        null,
        null,
        EXPECTED.messagesInbound,
      ),
    ).toBeNull();
  });

  test('says when the services could not be read', () => {
    expect(
      textingNote(local, 'unknown', 'unknown', EXPECTED.messagesInbound),
    ).toEqual({ kind: 'unknown' });
  });

  const servedHere = {
    ...CUSTOMER_CARE,
    useInboundWebhookOnNumber: true,
    inboundRequestUrl: null,
    inboundMethod: null,
  };

  test.each([
    ['no campaign', null, 'no-campaign'],
    [
      'a campaign in review',
      { ...APPROVED, status: 'in-review' },
      'campaign-in-review',
    ],
    [
      'a campaign that was not approved',
      { ...APPROVED, status: 'not-approved' },
      'campaign-not-approved',
    ],
  ] as const)(
    'warns about a local number whose service has %s',
    (_what, campaign, kind) => {
      expect(
        textingNote(local, servedHere, campaign, EXPECTED.messagesInbound),
      ).toEqual({ kind, service: CUSTOMER_CARE });
    },
  );

  test('puts the campaign before the service’s own inbound address', () => {
    expect(
      textingNote(
        local,
        {
          ...servedHere,
          useInboundWebhookOnNumber: false,
          inboundRequestUrl: ELSEWHERE,
        },
        null,
        EXPECTED.messagesInbound,
      ),
    ).toEqual({ kind: 'no-campaign', service: CUSTOMER_CARE });
  });

  test('says it could not tell when the campaign could not be read', () => {
    expect(
      textingNote(local, servedHere, 'unknown', EXPECTED.messagesInbound),
    ).toEqual({ kind: 'unknown' });
  });

  test('does not hold a toll-free number to its service’s campaign', () => {
    expect(
      textingNote(
        { local: false, texts: true },
        servedHere,
        null,
        EXPECTED.messagesInbound,
      ),
    ).toBeNull();
  });
});

describe('campaignFrom', () => {
  test.each([
    ['VERIFIED', 'approved'],
    ['verified', 'approved'],
    ['IN_PROGRESS', 'in-review'],
    ['PENDING', 'in-review'],
    ['FAILED', 'not-approved'],
    ['SUSPENDED', 'not-approved'],
    [null, 'not-approved'],
  ] as const)('reads a campaign Twilio reports as %s as %s', (raw, status) => {
    expect(campaignFrom({ campaignStatus: raw }).status).toBe(status);
  });

  test('keeps what Twilio says and fills what it leaves out', () => {
    expect(
      campaignFrom({
        campaignStatus: ' in_progress ',
        usAppToPersonUsecase: 'CUSTOMER_CARE',
        description: ' Replies to customers ',
      }),
    ).toEqual({
      status: 'in-review',
      twilioStatus: 'IN_PROGRESS',
      useCase: 'CUSTOMER_CARE',
      description: 'Replies to customers',
    });
    expect(campaignFrom({})).toEqual({
      status: 'not-approved',
      twilioStatus: 'UNKNOWN',
      useCase: 'UNKNOWN',
      description: '',
    });
  });
});

describe('keepsIncomingTexts', () => {
  const service = {
    ...CUSTOMER_CARE,
    useInboundWebhookOnNumber: false,
    inboundRequestUrl: ELSEWHERE,
    inboundMethod: 'POST',
  };

  test('is true for a service that sends its senders’ texts elsewhere', () => {
    expect(keepsIncomingTexts(service, EXPECTED.messagesInbound)).toBe(true);
  });

  test('is false once the service defers to each number’s webhook', () => {
    expect(
      keepsIncomingTexts(
        { ...service, useInboundWebhookOnNumber: true },
        EXPECTED.messagesInbound,
      ),
    ).toBe(false);
  });

  test('is false for a service that posts them to this deployment', () => {
    expect(
      keepsIncomingTexts(
        { ...service, inboundRequestUrl: EXPECTED.messagesInbound },
        EXPECTED.messagesInbound,
      ),
    ).toBe(false);
  });
});

describe('readiness wording', () => {
  test('names every reason a number needs Reconnect', () => {
    expect(
      describeReconnect('+15555550101', ['voice-url', 'voice-application']),
    ).toBe(
      '+15555550101 needs Reconnect: its voice URL points elsewhere or is not called with POST, a TwiML App takes its calls',
    );
  });

  test('names the service that takes the texts', () => {
    expect(
      describeTextingNote('+15555550101', {
        kind: 'service-takes-texts',
        service: CUSTOMER_CARE,
      }),
    ).toContain('"Customer Care"');
    expect(
      describeTextingNote('+15555550101', { kind: 'unregistered' }),
    ).toContain('A2P 10DLC');
  });

  test.each([
    ['no-campaign', 'has no A2P 10DLC campaign'],
    ['campaign-in-review', 'not approved yet'],
    ['campaign-not-approved', 'was not approved'],
  ] as const)('says what a %s note means for the number', (kind, says) => {
    const line = describeTextingNote('+15555550101', {
      kind,
      service: CUSTOMER_CARE,
    });

    expect(line).toContain('"Customer Care"');
    expect(line).toContain(says);
  });
});
