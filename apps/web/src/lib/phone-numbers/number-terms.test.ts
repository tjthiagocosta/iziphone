import type { OwnedPhoneNumber, PurchasedPhoneNumber } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  attachedToday,
  formatPrice,
  importNotice,
  importTerms,
  moveTerms,
  purchaseFailureFrom,
  purchaseNotice,
  purchaseTerms,
  reconnectReasonText,
  releaseNotice,
  releaseTerms,
  textingNoteText,
} from './number-terms';

const ALEX = { type: 'user', id: 'user-alex', name: 'Alex Example' } as const;
const SALES = { type: 'department', id: 'dept-sales', name: 'Sales' } as const;

const NOTHING_ATTACHED: OwnedPhoneNumber['attached'] = {
  voiceUrlHost: null,
  smsUrlHost: null,
  voiceApplication: null,
  smsApplication: null,
  sipTrunkSid: null,
  messagingService: null,
};

function owned(overrides: Partial<OwnedPhoneNumber> = {}): OwnedPhoneNumber {
  return {
    phoneNumber: '+15555550101',
    friendlyName: '(555) 555-0101',
    type: 'LOCAL',
    capabilities: { voice: true, sms: true, mms: false, fax: false },
    releasedHere: false,
    attached: NOTHING_ATTACHED,
    texting: null,
    ...overrides,
  };
}

const CUSTOMER_CARE = { sid: 'MGaaaa', friendlyName: 'Customer Care' };

describe('attachedToday', () => {
  test('names the TwiML App instead of the voice webhook it overrides', () => {
    expect(
      attachedToday(
        owned({
          attached: {
            ...NOTHING_ATTACHED,
            voiceUrlHost: 'demo.example.com',
            voiceApplication: { sid: 'APaaaa', friendlyName: 'Old IVR' },
            smsUrlHost: 'agent.example.com',
          },
        }),
      ),
    ).toEqual(['calls: the TwiML App “Old IVR”', 'texts: agent.example.com']);
  });

  test('falls back to the sid of an app it could not name', () => {
    expect(
      attachedToday(
        owned({
          attached: {
            ...NOTHING_ATTACHED,
            voiceApplication: { sid: 'APaaaa', friendlyName: null },
          },
        }),
      ),
    ).toEqual(['calls: the TwiML App APaaaa']);
  });

  test('names the messaging service, not the webhook, when the service keeps the texts', () => {
    expect(
      attachedToday(
        owned({
          attached: {
            ...NOTHING_ATTACHED,
            smsUrlHost: 'agent.example.com',
            messagingService: CUSTOMER_CARE,
          },
          texting: { kind: 'service-takes-texts', service: CUSTOMER_CARE },
        }),
      ),
    ).toEqual(['texts: the messaging service “Customer Care”']);
  });
});

describe('importTerms', () => {
  test('says the calls and texts move here and what is detached', () => {
    const [moves, detached, removal] = importTerms(
      owned({
        attached: {
          ...NOTHING_ATTACHED,
          voiceApplication: { sid: 'APaaaa', friendlyName: 'Old IVR' },
        },
      }),
    );

    expect(moves).toContain('moves its calls and texts to iziphone');
    expect(detached).toContain('detached');
    expect(detached).toContain('“Old IVR”');
    expect(removal).toContain('nothing puts the old settings back');
  });

  test('adds the texting note, the service it stays in, and a returning history', () => {
    const terms = importTerms(
      owned({
        releasedHere: true,
        attached: {
          ...NOTHING_ATTACHED,
          voiceUrlHost: 'demo.example.com',
          smsUrlHost: 'agent.example.com',
          messagingService: CUSTOMER_CARE,
        },
        texting: { kind: 'service-takes-texts', service: CUSTOMER_CARE },
      }),
    );

    // The service goes on taking the texts, so only the calls move.
    expect(terms[0]).toContain('moves its calls to iziphone');
    expect(terms[1]).toContain('(calls: demo.example.com)');
    expect(terms.join(' ')).toContain('stays a sender');
    expect(terms.join(' ')).toContain('defer to the sender’s webhook');
    expect(terms.at(-1)).toContain('history comes back');
  });

  test('ends with who answers it once a holder is chosen', () => {
    const number = owned({});

    expect(importTerms(number)).not.toContain(
      'Calls and texts to this number go to Alex Example.',
    );
    expect(importTerms(number, ALEX).at(-1)).toBe(
      'Calls and texts to this number go to Alex Example.',
    );
  });

  test('gives the holder only the calls when a messaging service keeps the texts', () => {
    const number = owned({
      attached: { ...NOTHING_ATTACHED, messagingService: CUSTOMER_CARE },
      texting: { kind: 'service-takes-texts', service: CUSTOMER_CARE },
    });

    expect(importTerms(number, SALES).at(-1)).toBe(
      'Calls to this number go to the Sales department. Its texts stay with the messaging service.',
    );
    expect(importTerms(number, null).join(' ')).not.toContain(
      'texts reach nobody',
    );
  });
});

describe('importNotice', () => {
  const imported = {
    id: 'phone-1',
    phoneNumber: '+15555550101',
    friendlyName: null,
    type: 'LOCAL',
    label: null,
    provider: 'TWILIO',
    locality: null,
    region: null,
    country: 'US',
    voiceEnabled: true,
    smsEnabled: true,
    mmsEnabled: false,
    faxEnabled: false,
    status: 'RESERVED',
    isPrimary: false,
    assignedTo: null,
    createdAt: '2026-04-21T12:00:00.000Z',
    updatedAt: '2026-04-21T12:00:00.000Z',
  } as const;

  test('sends the admin to Reconnect only when Twilio did not take the settings', () => {
    expect(importNotice({ ...imported, connected: true })).toBeNull();
    expect(importNotice({ ...imported, connected: false })).toContain(
      'Reconnect',
    );
  });
});

describe('connection wording', () => {
  test('names what Reconnect fixes', () => {
    expect(reconnectReasonText('voice-application')).toContain('TwiML App');
  });

  test('names the registration a local number in no service lacks', () => {
    expect(textingNoteText({ kind: 'unregistered' })).toContain('A2P 10DLC');
  });
});

describe('formatPrice', () => {
  test('shows a known currency the usual way', () => {
    expect(formatPrice({ amount: '1.15', currency: 'USD' })).toBe('$1.15');
  });

  test('shows what Twilio sent when it cannot be formatted', () => {
    expect(formatPrice({ amount: '1.15', currency: 'NOPE' })).toBe('1.15 NOPE');
    expect(formatPrice({ amount: 'n/a', currency: 'USD' })).toBe('n/a USD');
  });
});

describe('purchaseTerms', () => {
  test('states the monthly price and that the first month is not prorated', () => {
    const [billing] = purchaseTerms(
      { amount: '1.15', currency: 'USD' },
      'LOCAL',
    );

    expect(billing).toContain('$1.15 a month');
    expect(billing).toContain('not prorated');
  });

  test('says so when the price is unknown instead of guessing', () => {
    const [billing] = purchaseTerms(null, 'LOCAL');

    expect(billing).toContain('could not be read');
    expect(billing).not.toMatch(/\$\d/);
  });

  test('names the texting registration each number type needs', () => {
    expect(purchaseTerms(null, 'LOCAL')[1]).toContain('A2P 10DLC');
    expect(purchaseTerms(null, 'TOLL_FREE')[1]).toContain('verified');
  });
});

describe('moveTerms', () => {
  test('tells where calls and texts go when a reserved number is assigned', () => {
    expect(moveTerms(null, SALES)).toEqual([
      'Calls and texts to this number go to the Sales department.',
    ]);
  });

  test('keeps conversations with the holder they were written under on a move', () => {
    const [routing, history] = moveTerms(SALES, ALEX);

    expect(routing).toBe('Calls and texts to this number go to Alex Example.');
    expect(history).toContain(
      'Conversations the Sales department had on this number stay with the Sales department',
    );
    expect(history).toContain('Alex Example does not see them.');
  });

  test('warns that a number in the reserve reaches nobody and still costs money', () => {
    const terms = moveTerms(ALEX, null).join(' ');

    expect(terms).toContain('Nobody answers it');
    expect(terms).toContain('keeps costing its monthly fee');
    expect(terms).toContain('Conversations Alex Example had on this number');
  });
});

describe('releaseTerms', () => {
  test('says the fee stops, nothing is refunded, and how long it can come back', () => {
    const terms = releaseTerms('TWILIO').join(' ');

    expect(terms).toContain('stops charging');
    expect(terms).toContain('not refunded');
    expect(terms).toContain('10 days');
    expect(terms).toContain('history stays');
  });

  test('does not promise the fee stops for a number from the previous provider', () => {
    const terms = releaseTerms('VONAGE').join(' ');

    expect(terms).not.toContain('stops charging');
    expect(terms).toContain('cancel it there');
    expect(terms).toContain('history stays');
  });
});

describe('purchaseNotice', () => {
  const bought: PurchasedPhoneNumber = {
    id: 'phone-1',
    phoneNumber: '+15555550101',
    friendlyName: null,
    type: 'LOCAL',
    label: null,
    provider: 'TWILIO',
    locality: null,
    region: null,
    country: 'US',
    voiceEnabled: true,
    smsEnabled: true,
    mmsEnabled: false,
    faxEnabled: false,
    status: 'RESERVED',
    isPrimary: false,
    assignedTo: null,
    createdAt: '2026-04-21T12:00:00.000Z',
    updatedAt: '2026-04-21T12:00:00.000Z',
    connected: true,
  };

  test('has nothing to add when the number is set up', () => {
    expect(purchaseNotice(bought)).toBeNull();
  });

  test('says the number is bought and needs Reconnect, not a second purchase', () => {
    const notice = purchaseNotice({ ...bought, connected: false });

    expect(notice).toContain('is bought');
    expect(notice).toContain('Reconnect');
    expect(notice).toContain('do not buy it again');
  });
});

describe('purchaseFailureFrom', () => {
  test('lets the admin try again after a refusal', () => {
    expect(
      purchaseFailureFrom(409, 'That number is no longer available.'),
    ).toEqual({
      message: 'That number is no longer available.',
      mayRetry: true,
    });
  });

  test('lets the admin try again when the purchase could not start', () => {
    expect(
      purchaseFailureFrom(
        503,
        'Twilio could not be asked whether your account already has this number, so nothing was bought.',
      ),
    ).toEqual({
      message:
        'Twilio could not be asked whether your account already has this number, so nothing was bought.',
      mayRetry: true,
    });
  });

  test('stops a second purchase when the number may have been sold already', () => {
    const failure = purchaseFailureFrom(500, 'Local persistence failed.');

    expect(failure.mayRetry).toBe(false);
    expect(failure.message).toContain('check this list');
  });

  test('stops a second purchase when no answer arrived', () => {
    const failure = purchaseFailureFrom(undefined, 'Failed to fetch');

    expect(failure.mayRetry).toBe(false);
    expect(failure.message).toContain('check this list');
  });

  test('stops a second purchase when something other than the API answered', () => {
    expect(
      purchaseFailureFrom(502, 'Request failed with status 502').mayRetry,
    ).toBe(false);
  });

  test('stops a second purchase when Twilio did not confirm the first', () => {
    const failure = purchaseFailureFrom(
      504,
      'Twilio did not confirm the purchase.',
    );

    expect(failure.mayRetry).toBe(false);
    expect(failure.message).toContain('check this list');
  });
});

describe('releaseNotice', () => {
  test('has nothing to add when Twilio took the number back', () => {
    expect(releaseNotice({ cancelledAtTwilio: true }, 'TWILIO')).toBeNull();
  });

  test('warns that a number Twilio did not have may be billed elsewhere', () => {
    expect(releaseNotice({ cancelledAtTwilio: false }, 'TWILIO')).toContain(
      'nothing was cancelled at Twilio',
    );
  });

  test('sends a number from the previous provider back there, not to another Twilio account', () => {
    const notice = releaseNotice({ cancelledAtTwilio: false }, 'VONAGE');

    expect(notice).toContain('previous provider');
    expect(notice).not.toContain('Twilio Console');
  });
});
