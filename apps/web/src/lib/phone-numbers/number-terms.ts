import type {
  AttachedApplication,
  ImportedPhoneNumber,
  MonthlyPrice,
  OwnedPhoneNumber,
  PhoneNumberAssignment,
  PhoneNumberType,
  PurchasedPhoneNumber,
  ReconnectReason,
  ReleasedPhoneNumber,
  TelephonyProvider,
  TextingNote,
} from '@repo/dto';

/*
 * What each change to a number means for the bill and for the people on it,
 * in the words the confirmations show. Every sentence here states a fact of
 * how Twilio bills or how this app routes; change it when that changes.
 */

/** How a number's type reads wherever the console names it. */
export const NUMBER_TYPE_LABELS: Record<PhoneNumberType, string> = {
  LOCAL: 'Local',
  TOLL_FREE: 'Toll-free',
};

/** `$1.15`, or the amount and code when the browser does not know the currency. */
export function formatPrice(price: MonthlyPrice): string {
  const amount = Number(price.amount);

  if (!Number.isFinite(amount)) {
    return `${price.amount} ${price.currency}`;
  }

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: price.currency,
    }).format(amount);
  } catch {
    // An unknown currency code is still worth showing as Twilio sent it.
    return `${price.amount} ${price.currency}`;
  }
}

/** What buying a number commits the account to. */
export function purchaseTerms(
  price: MonthlyPrice | null,
  type: PhoneNumberType,
): string[] {
  const billing = price
    ? `Twilio charges ${formatPrice(price)} a month for this number, starting today. The first month is billed in full when you buy it, not prorated.`
    : 'The price could not be read from Twilio just now; check it in the Twilio Console first. The first month is billed in full when you buy it, not prorated.';
  const texting =
    type === 'TOLL_FREE'
      ? 'Calls work at once. Texts from a toll-free number are blocked until the number is verified in the Twilio Console.'
      : 'Calls work at once. Texts from a US local number need an approved A2P 10DLC registration in the Twilio Console, or carriers block them.';

  return [billing, texting];
}

/**
 * What giving a number to someone, or taking it away into the reserve, does.
 * Conversations stay with the owner they were written under, so the one
 * losing the line keeps reading them and the one getting it starts without
 * them.
 */
export function moveTerms(
  from: PhoneNumberAssignment | null,
  to: PhoneNumberAssignment | null,
): string[] {
  const terms: string[] = [];

  if (to) {
    terms.push(`Calls and texts to this number go to ${holderName(to)}.`);
  } else {
    terms.push(
      'Nobody answers it while it is in the reserve: callers hear that the number is not configured, and texts reach nobody.',
      'It stays on your Twilio account and keeps costing its monthly fee until you release it.',
    );
  }

  if (from) {
    terms.push(
      `Conversations ${holderName(from)} had on this number stay with ${holderName(from)}: they can still be read, but no longer answered from this number.${to ? ` ${holderName(to)} does not see them.` : ''}`,
    );
  }

  return terms;
}

/**
 * What releasing a number in the reserve does. A number imported from the
 * previous provider may never have reached Twilio, and releasing it here
 * cancels nothing there.
 */
export function releaseTerms(provider: TelephonyProvider): string[] {
  const history = 'Its call and message history stays here.';

  if (provider !== 'TWILIO') {
    return [
      'It leaves this list, and calls and texts to it are no longer handled here.',
      'It came from the previous provider. If Twilio has it, it goes back to Twilio; if the previous provider still has it, cancel it there to stop paying for it.',
      history,
    ];
  }

  return [
    'The number goes back to Twilio at once, and calls and texts to it stop.',
    'Twilio stops charging for it. The month already billed is not refunded.',
    'This cannot be undone here. For about 10 days Twilio keeps the number for your account and can give it back from the Twilio Console, as a new purchase; after that anyone may get it.',
    history,
  ];
}

/**
 * What the admin must know after a purchase that bought the number but could
 * not set it up, or null when there is nothing to add.
 */
export function purchaseNotice(bought: PurchasedPhoneNumber): string | null {
  return bought.connected
    ? null
    : 'The number is bought and in the list, but Twilio did not take its call and text settings, so calls and texts to it do not arrive yet. Open it and choose Reconnect; do not buy it again.';
}

/**
 * What takes the number's calls and texts today, each in a few words, in
 * the order an administrator would look for them.
 */
export function attachedToday(number: OwnedPhoneNumber): string[] {
  const { calls, texts } = takersToday(number);

  return [
    ...calls.map((taker) => `calls: ${taker}`),
    ...(texts ? [`texts: ${texts}`] : []),
  ];
}

/**
 * What adding a number the Twilio account already holds does, ending with
 * who answers it once `holder` is chosen (null for the reserve). It moves the
 * number's calls and texts here and takes off whatever answered them, which
 * the audit log keeps; nothing puts it back on its own. A messaging service
 * that keeps its senders' texts goes on getting them, which only the Twilio
 * Console changes.
 */
export function importTerms(
  number: OwnedPhoneNumber,
  holder?: PhoneNumberAssignment | null,
): string[] {
  const { calls, texts } = takersToday(number);
  const serviceKeepsTexts = number.texting?.kind === 'service-takes-texts';
  const moving = serviceKeepsTexts ? 'calls' : 'calls and texts';
  const replaced = [
    ...calls.map((taker) => `calls: ${taker}`),
    ...(texts && !serviceKeepsTexts ? [`texts: ${texts}`] : []),
  ];
  const terms = [
    `Adding it moves its ${moving} to iziphone: Twilio sends them here from then on, instead of where they go today.`,
    replaced.length > 0
      ? `What takes them now stops getting them (${replaced.join('; ')}), and any TwiML App, application or SIP trunk on the number is detached. The audit log keeps what it had, so it can be put back by hand in the Twilio Console.`
      : `Nothing on Twilio takes its ${moving} today.`,
    'Removing it from this list later leaves its calls and texts pointed here; nothing puts the old settings back.',
    'Nothing is bought: it keeps costing what it costs on your Twilio account today.',
  ];

  if (number.attached.messagingService) {
    terms.push(
      `It stays a sender of the messaging service “${number.attached.messagingService.friendlyName}”, which carries its texting registration; that is changed in the Twilio Console only.`,
    );
  }
  if (number.texting) {
    terms.push(textingNoteText(number.texting));
  }
  if (number.releasedHere) {
    terms.push(
      'It was released here before: its call and message history comes back with it, still with the owners it was written under.',
    );
  }
  if (holder !== undefined) {
    terms.push(
      ...(serviceKeepsTexts ? callsOnlyTo(holder) : moveTerms(null, holder)),
    );
  }

  return terms;
}

/** Who answers a number whose texts a messaging service keeps. */
function callsOnlyTo(holder: PhoneNumberAssignment | null): string[] {
  return holder
    ? [
        `Calls to this number go to ${holderName(holder)}. Its texts stay with the messaging service.`,
      ]
    : [
        'Nobody answers its calls while it is in the reserve: callers hear that the number is not configured.',
        'It stays on your Twilio account and keeps costing its monthly fee until you release it.',
      ];
}

/** Who takes the number's calls (Twilio's order of precedence) and its texts today. */
function takersToday(number: OwnedPhoneNumber): {
  calls: string[];
  texts: string | null;
} {
  const { attached, texting } = number;
  const app = (kind: string, application: AttachedApplication) =>
    application.friendlyName
      ? `the ${kind} “${application.friendlyName}”`
      : `the ${kind} ${application.sid}`;

  const calls = [
    attached.sipTrunkSid ? `the SIP trunk ${attached.sipTrunkSid}` : null,
    attached.voiceApplication
      ? app('TwiML App', attached.voiceApplication)
      : null,
    !attached.sipTrunkSid && !attached.voiceApplication && attached.voiceUrlHost
      ? attached.voiceUrlHost
      : null,
  ].filter((taker): taker is string => taker !== null);

  const texts =
    texting?.kind === 'service-takes-texts'
      ? `the messaging service “${texting.service.friendlyName}”`
      : attached.smsApplication
        ? app('application', attached.smsApplication)
        : attached.smsUrlHost;

  return { calls, texts };
}

/**
 * What the admin must know after adding a number that is in the list but
 * that Twilio did not point here, or null when there is nothing to add.
 */
export function importNotice(imported: ImportedPhoneNumber): string | null {
  return imported.connected
    ? null
    : 'The number is in the list, but Twilio did not take its call and text settings, so its calls and texts do not reach iziphone yet. Open it and choose Reconnect.';
}

/** Why a number needs Reconnect, as the number's page lists it. */
export function reconnectReasonText(reason: ReconnectReason): string {
  return RECONNECT_REASON_TEXT[reason];
}

const RECONNECT_REASON_TEXT: Record<ReconnectReason, string> = {
  'voice-url':
    'Its voice webhook points somewhere else or is not called with POST.',
  'voice-fallback-url':
    'Its voice fallback points somewhere else or is not called with POST.',
  'status-callback':
    'Its call status callback points somewhere else or is not called with POST.',
  'sms-url':
    'Its messaging webhook points somewhere else or is not called with POST.',
  'voice-application': 'A TwiML App is attached and takes its calls.',
  'sms-application': 'An application is attached and takes its texts.',
  'sip-trunk': 'A SIP trunk takes its calls.',
};

/**
 * Why texts may not arrive although the number is connected. Reconnect does
 * not change messaging services; they are managed in the Twilio Console.
 */
export function textingNoteText(note: TextingNote): string {
  switch (note.kind) {
    case 'service-takes-texts':
      return `Texts to it do not reach iziphone: the messaging service “${note.service.friendlyName}” sends its senders’ incoming texts to its own address. In the Twilio Console, set the service to defer to the sender’s webhook, or take the number out of it.`;
    case 'unregistered':
      return 'It is in no messaging service, and US carriers block texts from an unregistered local number (A2P 10DLC): it can call, but not text, until it joins the messaging service of a registered campaign in the Twilio Console.';
    case 'unknown':
      return 'The messaging services on the Twilio account could not be read, so whether its texts arrive was not checked.';
  }
}

/** What a failed purchase tells the admin, and whether Buy may be pressed again. */
export interface PurchaseFailure {
  message: string;
  mayRetry: boolean;
}

/**
 * The API refuses with a 4xx before anything is bought, and with a 503 when
 * it cannot start one: Twilio is not configured, or the account could not be
 * asked whether it already holds the number. Any other failure (a 500 after
 * Twilio sold the number, a 504 when Twilio did not confirm it, a proxy's
 * answer, or no answer at all, `status` undefined) may come after the sale.
 * A second Buy soon after is recorded as that sale, but one after a while is
 * refused as a number the account held before, so Buy stays off until the
 * admin has looked at the list and the Twilio Console.
 */
export function purchaseFailureFrom(
  status: number | undefined,
  message: string,
): PurchaseFailure {
  const refusedBeforeBuying =
    status !== undefined && ((status >= 400 && status < 500) || status === 503);

  return !refusedBeforeBuying
    ? {
        message: `${message} Twilio may have sold the number already: check this list and the Twilio Console before buying again.`,
        mayRetry: false,
      }
    : { message, mayRetry: true };
}

/**
 * What the admin must know after a release that found nothing to cancel at
 * Twilio, or null when Twilio took the number back. A number from the
 * previous provider that Twilio never had is most likely still there.
 */
export function releaseNotice(
  released: ReleasedPhoneNumber,
  provider: TelephonyProvider,
): string | null {
  if (released.cancelledAtTwilio) {
    return null;
  }

  return provider === 'TWILIO'
    ? 'The number is released here, but this Twilio account did not have it, so nothing was cancelled at Twilio. If you are still billed for it, it is on another account: release it in the Twilio Console there.'
    : 'The number is released here. Twilio did not have it, so it may still be with the previous provider: cancel it there to stop paying for it.';
}

function holderName(holder: PhoneNumberAssignment): string {
  return holder.type === 'department'
    ? `the ${holder.name} department`
    : holder.name;
}
