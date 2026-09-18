# 0003. Twilio records, we own the file

Date: 2026-09-17 · Status: Accepted

## Context

Calls and voicemails are recorded, and two things follow: something captures the
audio, and something holds it afterwards. They need not be the same party.

On 2026-09-17 Twilio charged $0.0025 per minute to record a call. Recording it
ourselves would mean a Media Streams connection at $0.0044 per minute, plus a
WebSocket service to run and scale. Leaving the file at Twilio is cheaper still,
but it makes retention, access control and the choice of transcription provider
Twilio's decision rather than the deployment's.

## Decision

Twilio keeps making the recordings; we own the resulting file. On the
recording-completed callback the API copies the file from Twilio into the
deployment's bucket, records it on the call, and deletes it at Twilio.

If the copy fails — Twilio not ready yet, the bucket down — playback falls back
to the Twilio-proxied audio, and a later attempt completes the copy and the
deletion.

## Consequences

- Retention is the deployment's decision, because the deployment holds the file. See [0006](0006-recordings-are-kept-until-deleted-by-default.md).
- Transcription can run on our copy with any provider, not only the recorder's.
- Twilio's storage cost stops at the copy: it bills recording minutes, not a growing archive.
- A bucket outage becomes deferred work rather than lost audio, but the work has to be picked up later and a recording is briefly readable in two places.

## Alternatives considered

- **Record ourselves over Media Streams.** Full control from the first packet, and no provider copy to delete. Rejected on cost and on the WebSocket service it would add to every deployment.
- **Leave the files at Twilio.** No copy step and no bucket. Rejected because retention, access control and transcription would all become Twilio's.
