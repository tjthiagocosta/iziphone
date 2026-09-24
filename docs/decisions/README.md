# Decision records

For developers and for anyone wondering why something works the way it does.

A decision record is a short, numbered, immutable note about a decision that is
not obvious from the code: the context it was made in, the decision itself, and
the consequences that follow. It is written once and left alone. When a
decision changes, it gets a new record that supersedes the old one rather than
an edit, so the reasoning that was true at the time stays readable.

Not every choice needs one. A record earns its place when a reader of the code
would otherwise ask "why not the obvious way?".

| # | Decision | Date |
|---|---|---|
| [0001](0001-two-services-one-database.md) | Two services, one database | 2026-09-08 |
| [0002](0002-object-storage-behind-one-interface.md) | Object storage behind one interface | 2026-09-17 |
| [0003](0003-twilio-records-we-own-the-file.md) | Twilio records, we own the file | 2026-09-17 |
| [0004](0004-outbound-calls-carry-a-per-call-grant.md) | Outbound calls carry a per-call grant | 2026-09-17 |
| [0005](0005-voicemail-greeting-is-a-hosted-file-with-a-spoken-fallback.md) | The voicemail greeting is a hosted file with a spoken fallback | 2026-09-18 |
| [0006](0006-recordings-are-kept-until-deleted-by-default.md) | Recordings are kept until deleted by default | 2026-09-18 |
| [0007](0007-closed-system-with-invite-links.md) | A closed system with invite links | 2026-09-18 |
| [0008](0008-a-sender-is-not-always-a-phone-number.md) | A sender is not always a phone number | 2026-09-20 |
| [0009](0009-declining-a-call-stops-your-ring-only.md) | Declining a call stops your ring only | 2026-09-21 |
| [0010](0010-the-controller-relays-a-notification-it-does-not-understand.md) | The controller relays a notification it does not understand | 2026-09-22 |
| [0011](0011-a-lines-history-stays-with-the-owner-it-was-written-under.md) | A line's history stays with the owner it was written under | 2026-09-23 |
| [0012](0012-call-availability-belongs-to-the-controller.md) | Call availability belongs to the controller | 2026-09-23 |

## Writing one

Copy the shape of an existing record: `# NNNN. Title`, a date line, then
Status, Context, Decision, Consequences and Alternatives considered. Number it
one above the highest, name the file `NNNN-kebab-case-title.md`, and add a row
here.
