# 0017. Adding a number the account holds takes it over

Date: 2026-10-02 · Status: Accepted

## Context

A stack runs on the customer's own Twilio account, and a migration brings
numbers the account already holds: bought in the Twilio Console, restored
there after a release, or serving another system until the day of the move.
Until now the admin console could only buy a number, and a number added any
other way had to be set up by hand and stayed invisible to the list.

Such a number usually has something attached. Twilio routes a number's calls
to a SIP trunk when it has one, then to a TwiML App when it has one, and only
then to the number's voice webhook; its texts go to an SMS application when
it has one, and to the messaging service it is a sender of when that service
does not defer to the sender's webhook. So a number whose webhooks point here
can still send its calls and texts elsewhere. Reconnect and the readiness
check looked at the webhooks only, and both said a number with a TwiML App
attached was fine.

The readiness check also judged every number on the account. An account that
holds numbers for other systems, as a customer's often does during a
migration, kept it red for numbers that were never this deployment's to fix.

## Decision

- **A number is added by its E.164 number.** The request names the number the
  way a purchase does and the way the list keys it: the unique key, the
  conflict checks, the audit log and the routing cache all use it, and the
  list keeps no Twilio sid. The API reads the number from the account, with
  its real capabilities, type and friendly name, and refuses one the account
  does not hold. Only `+1` numbers are offered, since number management is US
  only and Twilio does not say which country a held number is in.
- **Adding records first, then takes the number over.** The row and its audit
  entry are written before Twilio is touched, so a failure there changes
  nothing at Twilio. Then the number's voice, fallback, status and messaging
  webhooks are set exactly as a purchase sets them. A number Twilio does not
  take the settings for stays in the list, answered as not connected, and
  Reconnect finishes the job. A number already in the list is refused with a
  409; one released here before revives its row, as a purchase does, with the
  same holder model and primary rule.
- **The audit entry keeps what the number had.** `phone_number.imported`
  records every setting the import replaced or cleared (each webhook and its
  method, the TwiML App, the SMS application, the SIP trunk), so an operator
  can put the number back by hand. Reconnect records the same in
  `phone_number.reconnected`, written once the number is read and before
  Twilio is asked to change it, so a Reconnect that fails half-way, or whose
  answer is lost, still leaves the record; when the record cannot be written,
  Twilio is not asked.
- **Pointing a number here detaches what would win over its webhooks.**
  Purchase, import and Reconnect clear a TwiML App, an SMS application and a
  SIP trunk, and only the ones that are set. A SIP trunk is cleared too,
  although nobody asked for it, because it wins over both the webhooks and the
  app, and leaving it would make Reconnect report success for a number whose
  calls still go elsewhere. Twilio's answer to the update is checked with the
  same rule as the readiness check, and anything still in the way fails the
  request instead of being reported as connected. A webhook counts as pointed
  here only at its exact address (a trailing slash is another route) and with
  POST, the only method the routes take.
- **Messaging services are only reported.** A messaging service carries the
  number's A2P registration, and taking a number out of one would stop its
  texts for a different reason. Nothing here changes services: a number in a
  service that keeps its senders' inbound texts gets a warning naming the
  service (unless the service itself posts to this deployment's messaging
  webhook, which works as well), and a local number in no service
  gets a note that US carriers block its texts until it joins a registered
  campaign's service. Both are changed in the Twilio Console.
- **Readiness checks the listed numbers only.** `GET /health/twilio` reads the
  list's numbers (leaving out a release that did not finish) and checks those
  on the account. A number that needs Reconnect, with its reasons, is an issue
  and turns the report red. A texting warning, a listed number the account
  does not hold, and texting that could not be checked are warnings and leave
  the status as it is. Numbers on the account that are not in the list are
  counted, not judged.
- **A number's messaging service is found from the services' side.** Nothing
  on a number names the service it sends for, so the check lists the
  account's services once and then the senders of each: one call plus one per
  service, for every number at once. Asking each service about one number
  would cost a call per service for every number. Past twenty services the
  answer is "unknown" rather than a burst of calls.
- **Buy never takes over a number the account held before the last ten
  minutes.** Twilio
  answers a purchase of a number the account holds as a success, with that
  number, so Buy reads the account for the number before buying and checks
  the number Twilio answers with; a purchase that fails, or that Twilio
  answers with "taken", is checked against the account afterwards. Each time
  the number counts as bought only when Twilio dates it within ten minutes
  before the purchase started: an earlier purchase whose answer was lost, or
  another tab's a moment earlier, allowing for clock skew. The number Twilio
  answers a successful purchase with may be dated up to a day before, since
  the read just before found the account without it and a narrow window
  there would refuse a real, billed purchase on a host whose clock runs
  fast. A number bought in the Twilio Console or by another system within
  those ten minutes is still taken for this purchase. Such a number,
  found before buying, is recorded without a second purchase. A number the
  account held before is refused with a 409 pointing at **Add a number you
  own**, and nothing is written or changed at Twilio, because Buy would
  point it here without recording what it served. When the account cannot
  be read before buying, nothing is bought (503): buying blind is the case
  that took numbers over.
- **Removing an added number leaves its webhooks.** Releasing gives the number
  back to Twilio as before; nothing restores what it had before it was added.
  Whether to offer that is an open question for the owner.

## Consequences

- An administrator can bring every number of a migration into the list from
  the console, and sees what each one is attached to before choosing it.
- Adding a number moves its calls and texts here at once. Whatever answered
  them before stops getting them, and the confirmation says so.
- A number whose webhooks are right but that has a TwiML App or SIP trunk
  attached now shows as needing Reconnect, and the readiness check is red
  until it is fixed.
- A health check costs more Twilio calls: one listing of the account's numbers
  (up to 1000), plus one listing of the messaging services and one per service
  when a listed number can text. An account with more than 1000 numbers is
  checked only for the first 1000, and the report says so.
- A Canadian `+1` number held by the account is offered and can be added.

## Alternatives considered

- **Add by Twilio sid.** Unambiguous at Twilio, but nothing here stores it,
  every other request names the number, and an administrator reads numbers,
  not sids. Rejected.
- **Configure first, then record.** A failure to record would leave the
  number taken over at Twilio and missing from the list. Rejected: recording
  first leaves a visible number to reconnect, and the audit entry exists
  before anything at Twilio changes.
- **Take the number out of its messaging service.** Would make the texts
  reach here, and would also drop the number from the registered campaign
  that lets it text at all. Rejected; the warning says what to change in the
  Console.
- **Ask each service whether it has the number.** Fewer results per call, the
  same number of calls for one number, and many more for the readiness check.
  Rejected.
- **Keep judging every number on the account.** A deployment sharing an
  account with other systems could never be green. Rejected: the others are
  counted.
