import {
  type Campaign,
  type CampaignStatus,
  defaultRefusal,
  joinRefusal,
  type MessagingServiceJoin,
  type MessagingServiceName,
  type MessagingServiceOption,
  type MessagingServicesResponse,
  type OwnedPhoneNumber,
  type PhoneNumberConnection,
  type PhoneNumberType,
} from '@repo/dto';

/*
 * Which messaging service a local number texts through, in the words the
 * pickers, the number's page and the settings show. A US local number's
 * texts are registered by being a sender of a messaging service whose A2P
 * 10DLC campaign is approved; Twilio holds that, so everything here reads
 * what the API reported a moment ago.
 */

/** A campaign's state in a word or two. */
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  approved: 'Approved',
  'in-review': 'In review',
  'not-approved': 'Not approved',
};

/** `CUSTOMER_CARE` as "Customer care"; Twilio names use cases in capitals. */
export function campaignUseCaseLabel(useCase: string): string {
  const words = useCase.trim().toLowerCase().replaceAll('_', ' ');

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown';
}

/**
 * "Customer Care · Campaign: Customer care · Approved", as a picker lists a
 * service. Twilio does not keep names unique, so a service named like
 * another in `among` also shows the end of its sid.
 */
export function serviceOptionLabel(
  service: MessagingServiceOption,
  among: readonly MessagingServiceOption[] = [],
): string {
  const named = among.some(
    (other) =>
      other.sid !== service.sid && other.friendlyName === service.friendlyName,
  )
    ? `${service.friendlyName} (…${service.sid.slice(-6)})`
    : service.friendlyName;

  return [named, ...campaignParts(service.campaign)].join(' · ');
}

/** What a number or the default would choose between. */
export type ServicePurpose = 'number' | 'default';

/**
 * Why the service cannot be chosen, in a few words, or null when it can. A
 * number may join a service that keeps its incoming texts, with a warning;
 * the default may not, since every number after would lose them.
 */
export function optionRefusal(
  service: MessagingServiceOption,
  purpose: ServicePurpose,
): string | null {
  const refusal =
    purpose === 'default' ? defaultRefusal(service) : joinRefusal(service);

  switch (refusal) {
    case 'no-campaign':
      return 'no campaign';
    case 'campaign-not-approved':
      return 'campaign not approved';
    case 'keeps-incoming-texts':
      return 'keeps incoming texts';
    case null:
      return null;
  }
}

/**
 * The service a number about to be bought or added joins: one the admin
 * picked, none, or, when the services could not be read, whatever default
 * the deployment has, which the API applies and reports afterwards.
 */
export type JoinChoice =
  | { kind: 'service'; service: MessagingServiceOption }
  | { kind: 'none' }
  | { kind: 'default' };

/** The picker's value for "none"; a service's is its sid. */
export const NO_SERVICE = 'none';

/**
 * What the picker starts on: the default when this number may join it,
 * none otherwise. Null while the services are unread or unreadable, when
 * there is nothing to pick from.
 */
export function presetValue(
  response: MessagingServicesResponse | null,
): string | null {
  if (!response?.services) {
    return null;
  }

  const preset = response.services.find(
    (service) => service.sid === response.defaultSid,
  );

  return preset && !joinRefusal(preset) ? preset.sid : NO_SERVICE;
}

/**
 * Whether the account has a service the number could join other than the
 * one it is in (`currentSid`, null for none). False while the services are
 * unread, when the picker says so instead.
 */
export function hasServiceToJoin(
  response: MessagingServicesResponse | null,
  currentSid: string | null,
): boolean {
  return (
    response?.services?.some(
      (service) => service.sid !== currentSid && !joinRefusal(service),
    ) ?? false
  );
}

/** The choice a picker value stands for. */
export function choiceOf(
  response: MessagingServicesResponse | null,
  value: string | null,
): JoinChoice {
  if (!response?.services || value === null) {
    return { kind: 'default' };
  }

  const service = response.services.find(
    (candidate) => candidate.sid === value,
  );

  return service ? { kind: 'service', service } : { kind: 'none' };
}

/**
 * The request's `messagingServiceSid`: left out lets the API apply the
 * default, null asks for none.
 */
export function requestFieldOf(choice: JoinChoice): string | null | undefined {
  switch (choice.kind) {
    case 'service':
      return choice.service.sid;
    case 'none':
      return null;
    case 'default':
      return undefined;
  }
}

/**
 * Whether adding this account number lets the admin pick its messaging
 * service: a local number that can text and is in none. One already in a
 * service stays in it, and one whose service could not be read is left to
 * the default, which the API applies only to a number in none.
 */
export function mayChooseServiceOnImport(number: OwnedPhoneNumber): boolean {
  return (
    number.type === 'LOCAL' &&
    number.capabilities.sms &&
    !number.attached.messagingService &&
    number.texting?.kind !== 'unknown'
  );
}

/** What the choice means for the number's texts, as Buy and Add confirm it. */
export function joinTerms(choice: JoinChoice): string[] {
  switch (choice.kind) {
    case 'default':
      return [
        'The messaging services on your Twilio account could not be read just now. It joins the default messaging service set in Settings, if there is one, and you see whether it did once it is added.',
      ];
    case 'none':
      return [
        'It joins no messaging service: US carriers block its texts until it joins one with an approved A2P 10DLC campaign, which its page can do later. Calls are not affected.',
      ];
    case 'service':
      return serviceTerms(choice.service);
  }
}

/**
 * What moving a number from `from` (null for none) into `to` does, as the
 * number's page confirms it.
 */
export function changeServiceTerms(
  from: MessagingServiceName | null,
  to: MessagingServiceOption,
): string[] {
  if (!from) {
    return serviceTerms(to);
  }

  return [
    `It leaves “${from.friendlyName}” and joins “${to.friendlyName}”. Twilio lets a number send for one messaging service only, so for a moment it is in neither, and a text sent then may be blocked.`,
    ...serviceTerms(to),
    `The other numbers in “${from.friendlyName}”, and the service’s own settings, do not change. If “${to.friendlyName}” refuses the number, it is put back in “${from.friendlyName}”.`,
  ];
}

/**
 * What the admin must know after a number was bought or added, about the
 * messaging service it was meant to join, or null when there is nothing to
 * add: it joined, kept its own, or was meant to join none.
 */
export function joinNotice(join: MessagingServiceJoin): string | null {
  if (join.state !== 'failed') {
    return null;
  }

  const service = join.service
    ? `the messaging service “${join.service.friendlyName}”`
    : 'a messaging service';

  return `It did not join ${service}: ${join.message} Until it joins one with an approved campaign, which its page can do, US carriers block its texts.`;
}

/** The Texting card on a number's page. */
export interface TextingStatus {
  headline: string;
  details: string[];
  /** Whether its texts are delivered, blocked, or this card cannot tell. */
  tone: 'registered' | 'blocked' | 'neutral';
  /** What the card offers: moving it, adding it, or nothing. */
  action: 'change' | 'add' | null;
  /** The service the number is in now, as the move must name it. */
  current: MessagingServiceName | null;
}

/**
 * The Texting card for a number Twilio could be asked about: its campaign,
 * and whether it can join or move. A toll-free number is verified on its own
 * and never joins a service here.
 */
export function textingStatus(
  number: { type: PhoneNumberType; smsEnabled: boolean },
  connection: Extract<PhoneNumberConnection, { state: 'checked' }>,
): TextingStatus {
  if (!number.smsEnabled) {
    return {
      headline: 'This number cannot text.',
      details: [],
      tone: 'neutral',
      action: null,
      current: null,
    };
  }
  if (number.type === 'TOLL_FREE') {
    return {
      headline: 'Verified in the Twilio Console',
      details: [
        'A toll-free number’s texts are registered by verifying the number itself in the Twilio Console; iziphone does not change it.',
      ],
      tone: 'neutral',
      action: null,
      current: null,
    };
  }
  if (connection.texting?.kind === 'unknown') {
    return {
      headline: 'Could not check',
      details: [
        'The messaging services on your Twilio account could not be read, so its registration was not checked.',
      ],
      tone: 'neutral',
      action: null,
      current: null,
    };
  }

  const service = connection.messagingService;

  if (!service) {
    return {
      headline: 'Not registered: US carriers block its texts',
      details: [
        'It is in no messaging service. Add it to one whose A2P 10DLC campaign is approved for its texts to be delivered; calls are not affected.',
      ],
      tone: 'blocked',
      action: 'add',
      current: null,
    };
  }

  const current = { sid: service.sid, friendlyName: service.friendlyName };
  // A service that keeps the incoming texts is a matter of where they go,
  // which the Connection card says.
  const consequence = campaignConsequence(service.campaign);

  return {
    headline: `${consequence ? 'In' : 'Registered through'} “${service.friendlyName}” · ${campaignParts(service.campaign).join(' · ')}`,
    details: consequence ? [consequence] : [],
    tone: consequence ? 'blocked' : 'registered',
    action: 'change',
    current,
  };
}

function serviceTerms(service: MessagingServiceOption): string[] {
  const campaign = service.campaign;
  const joins =
    campaign?.status === 'approved'
      ? `It joins “${service.friendlyName}”, whose approved campaign (${campaignUseCaseLabel(campaign.useCase)}) registers its texts with US carriers. It can take a few minutes to reach the carriers.`
      : `It joins “${service.friendlyName}”. ${campaignConsequence(campaign) ?? ''}`.trim();

  return [
    joins,
    ...(service.keepsIncomingTexts ? [keepsTextsWarning(service)] : []),
  ];
}

/** What the campaign means for the texts, or null when it registers them. */
function campaignConsequence(campaign: Campaign | null): string | null {
  if (!campaign) {
    return 'The service has no A2P 10DLC campaign, so US carriers block its texts.';
  }

  switch (campaign.status) {
    case 'approved':
      return null;
    case 'in-review':
      return 'Its campaign is still in review: its texts stay blocked until the carriers approve it.';
    case 'not-approved':
      return 'Its campaign was not approved, so its texts are blocked.';
  }
}

function keepsTextsWarning(service: MessagingServiceName): string {
  return `“${service.friendlyName}” sends its senders’ incoming texts to an address of its own, so texts to this number do not reach iziphone. In the Twilio Console, set the service’s incoming messages to “Defer to sender’s webhook”.`;
}

function campaignParts(campaign: Campaign | null): string[] {
  return campaign
    ? [
        `Campaign: ${campaignUseCaseLabel(campaign.useCase)}`,
        CAMPAIGN_STATUS_LABELS[campaign.status],
      ]
    : ['No campaign'];
}
