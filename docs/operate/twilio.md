# Twilio configuration

For whoever connects a stack to a Twilio account. Covers the API key, the TwiML
application, the per-number webhooks, exposing the services over HTTPS during
development, and the account-level settings the system expects.

## Steps

1. Create an **API key and secret** in the Twilio console. The call controller uses them to mint browser voice tokens.
2. Create a **TwiML application** and copy its SID into `TWILIO_TWIML_APP_SID`. Set its Voice request URL to the call controller's voice webhook (`${WEBHOOK_BASE_URL}/webhooks/twilio/voice/inbound`) with the HTTP POST method; the route accepts nothing else. The application is for the softphone's outgoing calls only: do not attach it to a phone number, whose own webhooks below must take its calls. Before the softphone dials, it asks the call controller for a grant to call that number from the line the user chose, and starts the call with the grant as its only parameter besides the `outbound-pstn` type. The webhook reads who is calling, whom and from where from the grant, because Twilio lets the browser set every other parameter of the call, `From` included. There is no deployment-wide caller ID: a call leaves from one of the caller's own lines (their number, or a number of a department they belong to) and is refused when it names no line they may use.
3. For each **phone number** you add through the admin console, point its Voice webhook at the call controller and its Messaging webhooks at the API:
   - Voice: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/inbound`
   - Status callback: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/status`. A number has one status callback, and Twilio sends it for the calls to the number; the API asks for each text's status when it sends the text, at `<api url>/webhooks/twilio/messages/status`, so nothing points the number there.
   - Messaging: `<api url>/webhooks/twilio/messages/inbound`

   A number bought in **Admin → Phone Numbers**, or added there with **Add a number you own** because the account already holds it, gets its webhooks at once, and **Reconnect** on its page writes them again (see [Phone numbers](../admin/phone-numbers.md)); there is no need to set them by hand. All three also detach a TwiML App, an SMS application or a SIP trunk attached to the number, because Twilio sends the number's calls or texts to those instead of its webhooks, and the audit log records what the number had before. None of them changes a messaging service.

   `GET /health/twilio` (admin only) checks the numbers in the list, not every number on the account; the others are only counted, so numbers the account keeps for other systems do not turn it red. It reports as an issue every listed number that needs Reconnect, with the reason: a webhook pointing elsewhere (including a status callback that earlier versions left on the API's messaging status route) or set to GET, since every webhook route takes POST only and a trailing slash is a different route, or an attached TwiML App, SMS application or SIP trunk. While one does, `GET /health/all` reports Twilio as disconnected. It also warns, without changing the status, about a listed number the account does not hold, and about texting:

   - A number that is a sender of a **messaging service** whose incoming messages go to the service's own address rather than "Defer to sender's webhook" (`useInboundWebhookOnNumber=false`), unless that address is exactly the API's messaging webhook and is called with POST: its texts go there and never reach the API. The warning names the service. Change the service's integration setting in the Twilio Console, or take the number out of it; Reconnect does not.
   - A local number in **no messaging service**: it can call, but US carriers block its texts until it joins the service of an approved A2P 10DLC campaign.
   - A local number in a service with **no campaign**, a campaign **in review**, or one **not approved**: its texts are blocked until the campaign is approved, or until the number moves to a service whose campaign is. The warning names the service.

   Twilio names no service on the number itself, so the check lists the account's messaging services once and each service's senders: one request plus one per service, whatever the number of numbers, plus one campaign read for each service that holds a listed local number. An account with more than 20 services is not checked for texting, and the report says so.
4. Expose the call controller and API over HTTPS. One Nouva.sh session carries both, and each `-R` names the alias it answers on (up to five per session):

   ```bash
   ssh -R izi-calls:80:localhost:3002 \
       -R izi-api:80:localhost:3001 \
       tunnel@ssh.nouva.cloud
   ```

   That serves `https://izi-calls.nouva.cloud` and `https://izi-api.nouva.cloud` while the terminal stays open. Set `WEBHOOK_BASE_URL` to the calls alias; voice-only work needs only that first `-R`.

   Messaging and MMS need the API public as well, because Twilio fetches media from it. Point `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` at the API alias — the session cookie is issued for the API's own origin, so they must agree. Add a third `-R` for the web app on 3000 and set `CORS_ORIGIN` to it; keeping every origin under `nouva.cloud` keeps the cookie same-site.
5. Optionally set `TWILIO_HOLD_AUDIO_URL` to a public MP3 or WAV for hold music. A Twilio-hosted classical track is used when it is empty.
6. Turn on **Enforce HTTP Auth on Media URLs** in the console's Voice settings, as Twilio recommends. The API fetches every recording with the account's credentials, keeps its own copy and serves the audio to the softphone itself, so nothing here relies on recording URLs being public; while the setting is off, anyone who holds a recording's URL can download it from Twilio without signing in, until the API has deleted it there.

## Numbers and caller ID

Every line must be a voice-capable number on this Twilio account, because
Twilio accepts only the account's own (or verified) numbers as caller ID. For
US calls to be signed with full STIR/SHAKEN attestation, the account also needs
an approved Business Profile and a SHAKEN/STIR trust product in Trust Hub with
the numbers assigned to it.

## Webhook signatures

Twilio signs every webhook, and both services refuse one without a valid
signature with a 403 (a 500 while the Twilio credentials are not set), in
every environment unless `TWILIO_SIGNATURE_CHECK` is `off` (below). Twilio signs the exact public URL it
called, so the check works behind a proxy or a tunnel only when
`BETTER_AUTH_URL` (texts) and `WEBHOOK_BASE_URL` (calls) are the addresses
Twilio was given, scheme and host included.

`TWILIO_SIGNATURE_CHECK=off` turns the check off, so a developer can post a
webhook by hand with `curl`. It is for a development stack only: unless
`NODE_ENV=development`, the services refuse to start with it off, and they log
a warning at boot when it is. Never leave it off on a stack Twilio, or anybody
else, can reach. See
[0015](../decisions/0015-twilio-signatures-are-checked-unless-a-development-stack-says-otherwise.md).

## Related

- [Environment variables](environment.md) — every `TWILIO_*` and `WEBHOOK_BASE_URL` setting
- [0004. Outbound calls carry a per-call grant](../decisions/0004-outbound-calls-carry-a-per-call-grant.md)
- [Costs](../develop/costs.md) — what Twilio charges for
