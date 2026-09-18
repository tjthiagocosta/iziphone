# 0006. Recordings are kept until deleted by default

Date: 2026-09-18 · Status: Accepted

## Context

Because the deployment owns the recording files
([0003](0003-twilio-records-we-own-the-file.md)), it also owns the question of
how long to keep them. A voicemail and the recording of a conversation are not
the same kind of thing — one is a message somebody is waiting to hear, the other
is a record of a conversation — and they are kept for different reasons and
different lengths of time. Deployments are single-organization, so there is no
tenant to vary this per.

## Decision

Recordings are kept until an admin deletes them, unless a retention period is
chosen. Periods are named rather than free-form: 30, 60, 90 or 180 days, or 1,
2, 3, 5 or 7 years. Two policies are set separately, one for voicemails and one
for the recordings of calls, in one deployment-wide settings row.

A sweep inside the API runs hourly, under a Redis lock so only one instance
sweeps at a time, and deletes the audio of everything that has outlived the
policy covering it. The database row outlives the audio: the call's history
keeps saying there was a recording, and records when and why it was deleted.

## Consequences

- There is no undo window and no legal hold. Once the sweep has run, the audio is gone from the bucket and from Twilio.
- Shortening a policy deletes everything already older than it on the next sweep.
- Playing a swept recording answers `410` with the reason, so the history stays honest instead of showing a broken player.
- Conference recordings remain visible only to the roles holding the listen permission, independently of retention.

## Alternatives considered

- **A free number of days.** Maximum flexibility, but an unreviewable value: a typo is a deletion policy, and nobody can tell at a glance whether `45` was intended.
- **Per-department periods.** Plausible for a team with different obligations per line. Not needed yet, and it multiplies the sweep's work and the settings an admin has to keep straight.
