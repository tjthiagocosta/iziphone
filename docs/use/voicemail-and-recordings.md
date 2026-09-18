# Voicemail and recordings

For agents and supervisors. Covers where audio from a call appears, who can play
it, and what the messages mean when it is gone.

## Where they are

A call appears as a card in the conversation with the other party, saying what
kind of call it was and how long it lasted. Any audio kept for it — a voicemail
the caller left, or the recording of the conversation — shows as a player on
that card. The inbox also has a **Voicemails** tab that lists just the
voicemails.

Nothing downloads until you press play.

When a transcript exists for the call, it appears under a **Transcript** heading
on the same card.

## Who can play what

A voicemail is a message left on a line, so anyone who can see the call can play
it.

The recording of a conversation is for the roles holding `recordings:listen`,
which is supervisors and admins. An agent's call history does not mention it at
all. Deleting a recording by hand is an admin action.

## When there is no audio

- "This voicemail was deleted by the retention policy" — it outlived the deployment's retention period. The call still records that there was one.
- "This voicemail was deleted" / "This call recording was deleted" — an admin deleted it. The audio is gone for everyone and cannot be recovered.
- "No audio was kept for this voicemail" — the call knows about a voicemail but no audio was stored.
- "This recording is no longer available" or "This recording could not be loaded" — the audio could not be fetched. The player offers **Try again**.

## Related

- [Recording retention](../admin/recording-retention.md) — how long audio is kept, and who sets that
- [Permissions and roles](../admin/permissions-and-roles.md)
