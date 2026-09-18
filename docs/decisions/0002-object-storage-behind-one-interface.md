# 0002. Object storage behind one interface

Date: 2026-09-17 · Status: Accepted

## Context

The system accumulates files: MMS attachments in and out, the slots an upload
occupies before a message is sent, call recordings, and department voicemail
greetings. Each was arriving with its own storage story, and the first landed on
the API container's local disk — ephemeral, and invisible to a second instance.
Deployments are one stack per customer, so the provider is the deployer's choice
rather than ours, and the common denominator is the S3 API.

## Decision

Every stored file goes to one S3-compatible bucket the deployer chooses: AWS S3,
Cloudflare R2, Backblaze B2, IDrive e2, or MinIO in development. It is
configured by `STORAGE_*` environment variables validated at boot, not by an
admin screen.

The bucket sits behind the `MediaStore` interface in
`apps/api/src/media-store/`: features own their keys, the store owns every S3
detail. Only the API talks to the bucket. Media is served through the API's own
routes rather than by presigned URL, because Twilio fetches outbound MMS media
and greetings by URL and the bucket stays private. The client is
`@aws-sdk/client-s3`, the one every listed provider documents.

## Consequences

- The dev compose file runs MinIO and creates the bucket, so a checkout has working storage.
- The operator documentation carries a provider table, because the endpoint, region and path-style settings are the only thing that differs between providers.
- Every byte of media passes through the API: simple and private, but it puts the API on the serving path.
- A feature that wants storage adds a key convention, not an S3 call.

## Alternatives considered

- **Local disk.** No configuration at all, but ephemeral in a container and invisible to a second instance.
- **Hand-written SigV4 over `fetch`.** No dependency, but signing is the part that is tedious to get right and easy to get subtly wrong across five providers.
