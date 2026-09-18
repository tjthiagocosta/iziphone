# Voicemail greeting

For the administrator of a deployment. Covers uploading the audio a caller hears
before the beep, and what happens when there is none.

Each department has its own greeting, on
**Admin → Departments → the department → Routing**, under **Voicemail Greeting**.

## Uploading one

With no greeting uploaded, the field says "Callers hear the built-in greeting."
and offers **Upload**. Once one is in place the field plays it back and offers
**Replace** and **Remove**. The greeting saves as soon as you pick the file; it
is not waiting on "Save Settings".

Accepted: **MP3, WAV or AIFF, up to 5 MB.** A file of another kind, an empty
file, or one over the cap is refused before it is uploaded.

The file is kept in this deployment's bucket and served by the API. Every upload
gets its own URL, so replacing a greeting never leaves a caller hearing a cached
copy of the old one.

## When the greeting cannot be played

Right before it answers a call going to voicemail, the call controller checks
that the greeting is still fetchable and still audio. If it is not — the API is
down, the object is gone — the caller hears the built-in spoken greeting and the
voicemail goes ahead as normal. A greeting that has gone missing costs the
greeting, not the call.

Why it works this way, and what it costs on the inbound path, is
[0005. The voicemail greeting is a hosted file with a spoken
fallback](../decisions/0005-voicemail-greeting-is-a-hosted-file-with-a-spoken-fallback.md).

## Related

- [Departments and routing](departments-and-routing.md) — when a call reaches voicemail
- [Object storage](../operate/object-storage.md) — where the file is kept
- [Recording retention](recording-retention.md) — how long the voicemails callers leave are kept
