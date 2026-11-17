import {
  type Campaign,
  type CampaignStatus,
  defaultRefusal,
  joinRefusal,
  type MessagingServiceOption,
} from '@repo/dto';

/*
 * Which messaging service a local number texts through, in the words the
 * picker and the settings show. A US local number's texts are registered by
 * being a sender of a messaging service whose A2P 10DLC campaign is approved;
 * Twilio holds that, so everything here reads what the API reported a moment
 * ago.
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

/** The picker's value for "none"; a service's is its sid. */
export const NO_SERVICE = 'none';

function campaignParts(campaign: Campaign | null): string[] {
  return campaign
    ? [
        `Campaign: ${campaignUseCaseLabel(campaign.useCase)}`,
        CAMPAIGN_STATUS_LABELS[campaign.status],
      ]
    : ['No campaign'];
}
