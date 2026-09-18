# Twilio configuration

For whoever connects a stack to a Twilio account. Covers the API key, the TwiML
application, the per-number webhooks, exposing the services over HTTPS during
development, and the account-level settings the system expects.

## Steps

1. Create an **API key and secret** in the Twilio console. The call controller uses them to mint browser voice tokens.
2. Create a **TwiML application** and copy its SID into `TWILIO_TWIML_APP_SID`. Set its Voice request URL to the call controller's voice webhook (`${WEBHOOK_BASE_URL}/webhooks/twilio/voice/inbound`) with the HTTP POST method; the route accepts nothing else. Before the softphone dials, it asks the call controller for a grant to call that number from the line the user chose, and starts the call with the grant as its only parameter besides the `outbound-pstn` type. The webhook reads who is calling, whom and from where from the grant, because Twilio lets the browser set every other parameter of the call, `From` included. There is no deployment-wide caller ID: a call leaves from one of the caller's own lines (their number, or a number of a department they belong to) and is refused when it names no line they may use.
3. For each **phone number** you add through the admin console, point its Voice webhook at the call controller and its Messaging webhooks at the API:
   - Voice: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/inbound`
   - Voice status callback: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/status`
   - Messaging: `<api url>/webhooks/twilio/messages/inbound`
   - Messaging status callback: `<api url>/webhooks/twilio/messages/status`
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

Twilio signs every webhook. Signature validation is enforced when `NODE_ENV` is
anything other than `development`, and skipped in development so local tunnels
are easy to work with. Never run with `NODE_ENV=development` on a public host.

## Related

- [Environment variables](environment.md) — every `TWILIO_*` and `WEBHOOK_BASE_URL` setting
- [0004. Outbound calls carry a per-call grant](../decisions/0004-outbound-calls-carry-a-per-call-grant.md)
- [Costs](../develop/costs.md) — what Twilio charges for
