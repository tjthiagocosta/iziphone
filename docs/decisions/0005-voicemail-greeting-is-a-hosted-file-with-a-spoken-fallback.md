# 0005. The voicemail greeting is a hosted file with a spoken fallback

Date: 2026-09-18 · Status: Accepted

## Context

A department's voicemail should be able to open with the company's own greeting,
which means a `<Play>` in the voicemail TwiML pointing at an audio file.

That verb is unforgiving. A `<Play>` whose file cannot be fetched, or which
turns out not to be audio, is fatal in Twilio: it aborts the document, plays "an
application error has occurred" and ends the call. The `<Record>` after it never
runs, so a greeting that has gone missing does not degrade the voicemail — it
deletes it, silently, for every caller. Twilio also sends no parameters with a
`<Play>` fetch, so the URL cannot be signature-protected.

## Decision

The greeting is an audio file the admin uploads. It is stored in the
deployment's bucket and served by the API at a URL that is immutable per upload,
so a new upload gets a new id rather than changing a file in place. A random id
is the only access control the URL can have.

Right before rendering the voicemail TwiML, the call controller probes that URL
with a `HEAD` request and a 2-second timeout. It emits the `<Play>` only if the
probe answers 2xx with an audio content type; otherwise it speaks the built-in
fallback greeting and goes on to the `<Record>`.

## Consequences

- A greeting that is missing, corrupt, or served by an API that is down costs the caller the built-in greeting, not the call.
- Up to about 2 seconds are added to the inbound webhook in the worst case, on the voicemail path only and only when a greeting is configured.
- A Voice Fallback URL on each number is still worth configuring: it is the only recovery when the call controller itself is down, which no probe inside the controller can help with.

## Alternatives considered

- **An external URL the admin pastes.** No storage and no upload screen, but the deployment has no control over the availability or content type of somebody else's host, and `<Play>` punishes both.
- **Twilio Assets as the greeting origin.** Effectively failure-proof, since Twilio would fetch from itself. Rejected because the greeting would then live outside the deployment.
