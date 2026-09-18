# Recording retention

For the administrator of a deployment. Covers how long recordings are kept, who
sets that, what the sweep does, and who can hear what.

Call recordings and voicemails are copied into the bucket and deleted at
Twilio, so how long they are kept is this deployment's decision, not the
provider's.

## Setting a policy

**Admin → Settings → Recording retention** sets two policies, one for
voicemails and one for the recordings of calls themselves: *keep until deleted*
(the default) or 30, 60, 90, 180 days, 1, 2, 3, 5 or 7 years. There is no
free-form number of days, and there are no per-department overrides; changing a
policy writes an audit entry with what it was and what it became.

Shortening a policy deletes everything already older than it on the next sweep.

## The sweep

A sweep inside the API runs a minute after boot and then hourly, under a Redis
lock so only one instance sweeps at a time. It deletes the audio of every
recording older than the policy covering it, and picks up the work earlier
attempts left owed: copies that never completed and deletions Twilio refused,
each bounded per run so a backlog drains over several hours.

The row survives its audio: the call's history keeps saying there was a
recording and that the retention policy deleted it, and playing it answers
`410` with that reason. An admin can delete one recording from its player on
the call, with the same result; the reply says what is stored, so a manual
delete that raced the sweep reports the policy's deletion rather than its own.

Each run that changed something writes one audit entry
(`recording.retention_swept`) with the counts and the policies in force, never
one entry per recording; a run with nothing to do writes none and logs one
line. Nothing about a recording's provider URL is logged or stored in the
entry.

## Who is told what

A voicemail belongs to whoever works the line, so it appears for anyone who may
see the call. The recording of the conversation itself is for the roles that
hold `recordings:listen` (supervisors and admins) — an agent's call history
does not mention it at all, and its audio is refused.

## Related

- [Permissions and roles](permissions-and-roles.md)
- [Voicemail and recordings](../use/voicemail-and-recordings.md) — the agent's view
- [Object storage](../operate/object-storage.md)
- [0006. Recordings are kept until deleted by default](../decisions/0006-recordings-are-kept-until-deleted-by-default.md)
