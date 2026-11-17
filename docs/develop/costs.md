# Costs

For whoever pays the bill. Covers what is free and what is not.

iziphone is free to run, but Twilio is not. You pay Twilio for phone numbers,
voice minutes, recordings, transcription and messages. Check
[Twilio's pricing](https://www.twilio.com/pricing) for your country before
putting real traffic through the system, and watch your account during
development. A misconfigured routing loop can generate charges quickly.

Each phone number costs a monthly fee from the moment it is bought, and Twilio
bills the first month in full, not prorated. The fee runs while a user or a
department holds the number and while it sits in the reserve; only releasing it
stops it. Texting from a US local number needs an A2P 10DLC registration, which
Twilio charges for separately, and a toll-free number needs toll-free
verification. The brand and the campaign are registered once in the Twilio
Console, under Twilio's fees; the requests the admin console makes to read
the messaging services and their campaigns, and to put a number in one, are
not billed. See [Phone numbers](../admin/phone-numbers.md).

Object storage is billed by whoever hosts your bucket. Because the API copies
each recording into the bucket and deletes it at Twilio, the audio you keep is
charged by your storage provider rather than by Twilio — see
[0003. Twilio records, we own the file](../decisions/0003-twilio-records-we-own-the-file.md)
and [Recording retention](../admin/recording-retention.md).

## Related

- [Phone numbers](../admin/phone-numbers.md)
- [Object storage](../operate/object-storage.md)
- [Twilio configuration](../operate/twilio.md)
