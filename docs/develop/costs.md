# Costs

For whoever pays the bill. Covers what is free and what is not.

iziphone is free to run, but Twilio is not. You pay Twilio for phone numbers,
voice minutes, recordings, transcription and messages. Check
[Twilio's pricing](https://www.twilio.com/pricing) for your country before
putting real traffic through the system, and watch your account during
development. A misconfigured routing loop can generate charges quickly.

Object storage is billed by whoever hosts your bucket. Because the API copies
each recording into the bucket and deletes it at Twilio, the audio you keep is
charged by your storage provider rather than by Twilio — see
[0003. Twilio records, we own the file](../decisions/0003-twilio-records-we-own-the-file.md)
and [Recording retention](../admin/recording-retention.md).

## Related

- [Object storage](../operate/object-storage.md)
- [Twilio configuration](../operate/twilio.md)
