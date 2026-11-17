# 0018. An admin chooses the campaign a number texts through

Date: 2026-11-17 · Status: Accepted. Supersedes the "Messaging services are
only reported" point of
[0017](0017-adding-a-number-the-account-holds-takes-it-over.md).

## Context

US carriers deliver the texts of a local number only when it is registered
for A2P 10DLC. The registration is a brand and a campaign, made once in the
Twilio Console and reviewed by the carriers, and a campaign belongs to
exactly one messaging service. A number is covered by a campaign by being a
sender of that campaign's service, and Twilio lets a number be a sender of
one service only.

Under 0017 iziphone only reported this. A number bought here joined no
service, so every purchase was followed by a trip to the Twilio Console
before the number could text, and the warnings said "in no messaging service"
without saying which campaign was there to join. A service whose campaign
was still in review, or had been rejected, passed silently: a number in it
looked registered and its texts were blocked.

A customer's account typically holds one approved campaign, sometimes a few
(customer care, appointment reminders, marketing), alongside services that
serve other systems on the same account.

## Decision

- **iziphone adds a number to a messaging service, and moves it between
  them. Nothing else at Twilio's messaging side changes.** It never changes a
  service's own settings (its inbound address, whether it defers to the
  sender's webhook, its campaign), because other senders share them,
  including numbers of other systems on the account. It never creates or
  edits brands or campaigns: those are a business registration the carriers
  review, made in the Twilio Console.
- **Twilio is the record of a number's service.** Nothing is stored per
  number, since the Console can change it at any time, and every screen reads
  it from Twilio. The only thing stored is the deployment's default,
  `SystemSettings.defaultMessagingServiceSid`, set in **Settings → Texting**
  and audited (`settings.default_messaging_service_updated`, with the old and
  the new value).
- **A campaign's state is read with its service.** Each service's
  `usAppToPerson` campaign is read; Twilio's `VERIFIED` is approved,
  `PENDING` and `IN_PROGRESS` are in review, and anything else is not
  approved. A service without a campaign registers nothing.
- **A number may join a service whose campaign is approved or in review.**
  One in review is allowed, with a warning that texts stay blocked until the
  carriers approve it, because registering numbers while the review runs is
  how an account gets ready for the day it passes. A service with no
  campaign, or with one that was not approved, is listed and cannot be
  chosen. The rule is one function in `@repo/dto` (`joinRefusal`), shared by
  the API, which enforces it, and the web, which explains it.
- **The default must also pass incoming texts on.** A service that sends its
  senders' incoming texts to an address of its own, other than this
  deployment's messaging webhook, would make every new number deaf to
  replies, so it cannot be the default (`defaultRefusal`). A single number
  may still join one, with the warning 0017 already gives, because that is a
  choice about one number made with the warning in view.
- **Buy and Add take `messagingServiceSid`.** Left out, the default applies;
  `null` asks for none; a sid names a service. A named service is checked
  against Twilio before anything is bought, so a bad pick costs nothing. An
  unusable default, one deleted in the Console or whose campaign was
  rejected since it was set, never blocks a purchase: the number is bought
  and the answer says it did not join. Only a local number that can text may
  name one; a toll-free number is registered by its own verification.
- **Joining after Buy or Add is best effort and reported**, as the webhook
  setup is. The answer carries `messagingService`: `joined`, `kept` (a number
  added from the account that is a sender of a service already stays in it;
  moving it is a choice made on its page, not a side effect of adding it),
  `none`, or `failed` with the reason. A failed join leaves the number listed
  and connected, and the notice sends the admin to its page. A join is
  audited as `phone_number.messaging_service_joined`.
- **A move removes, then adds, and puts back on failure.** Twilio refuses a
  number that is a sender of another service, so it is taken out of the old
  one first. The request names the service the admin saw it in
  (`expectedMessagingServiceSid`); a number Twilio shows in another one is
  refused with 409 before anything changes. The audit entry
  `phone_number.messaging_service_changed`, naming both services, is written
  once the old service is known and before Twilio is asked to change
  anything, as Reconnect's is. When the new service refuses the number, it is
  put back in the old one, and the answer says whether that worked. An add
  whose answer is lost is checked against the service before it counts as a
  failure.
- **Readiness and the number's page warn about the campaign.** A listed
  local number in a service with no campaign, a campaign in review or one
  not approved gets a texting note naming the service, which the readiness
  report counts as a warning. Campaigns are read only for the services that
  hold listed local numbers.

## Consequences

- A number bought here can text as soon as the carriers take the
  registration, usually within minutes, with no trip to the Console. The
  first campaign still has to be registered there once.
- An admin sees on the number's page which campaign covers it and whether
  the carriers approved it, and can move it to another campaign of the
  account. During a move the number is briefly in no service, and a text
  sent in that moment may be blocked; the confirmation says so.
- A number can end up in no service: when the new service refuses it and the
  old one refuses it back. The answer says so, and its page offers to add it
  again.
- Listing the services for a picker or the settings costs one Twilio request
  plus one campaign read per service, up to 20 services; a number's page and
  the readiness check add one campaign read per service holding a listed
  local number. Past 20 services nothing is chosen and the pickers say the
  services could not be read.
- An account with no approved campaign gets nothing out of this until one is
  registered in the Console; the pickers list its services as unusable and
  say why.

## Alternatives considered

- **Store each number's service here.** Simpler screens, and a record that
  goes stale the moment someone changes the number in the Console. Rejected:
  Twilio decides where the texts go, so Twilio is read.
- **Create a messaging service and a campaign for the deployment.** A
  campaign is a business registration with use-case wording, sample messages
  and opt-in evidence the carriers review, and it is rejected for weak
  wording. Rejected: it stays in the Console, where the customer owns it.
- **Set a service's inbound handling to defer to the sender's webhook.** It
  would make incoming texts reach here and would change them for every other
  sender of the service, some of which may belong to another system.
  Rejected: the warning says what to change and who decides.
- **Only one campaign per deployment, applied without a choice.** Fits the
  common account, and fails an account with a reminders campaign beside a
  customer-care one. Rejected: the default covers the common case and the
  picker the other.
- **Register numbers in bulk.** Useful for a migration of many numbers, and a
  partial failure across many numbers is hard to report and undo. Left out
  for now: numbers are registered one at a time from Buy, Add and their page.
