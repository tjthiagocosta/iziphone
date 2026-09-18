# Object storage

For whoever chooses and configures the bucket. Covers what is stored there, the
settings each provider wants, and how to check the bucket is reachable.

The API keeps MMS attachments and department voicemail greetings in one
S3-compatible bucket and is the only service that talks to it. Six `STORAGE_*`
variables select the provider; nothing else changes between them. The bucket
does not need to be public: media is served through the API's `/media` routes,
and Twilio fetches outbound attachments and greetings from there.

## Providers

| Provider | `STORAGE_ENDPOINT` | `STORAGE_REGION` | `STORAGE_FORCE_PATH_STYLE` |
|---|---|---|---|
| MinIO (dev compose) | `http://localhost:9000` | `us-east-1` (any value) | `true` (the default with an endpoint; MinIO only answers path-style unless `MINIO_DOMAIN` is set) |
| AWS S3 | leave unset | the bucket's region, e.g. `us-east-1` | `false` (the default without an endpoint) |
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | either; the default `true` works |
| Backblaze B2 | the bucket's endpoint, `https://s3.<region>.backblazeb2.com` | the `<region>` part of the endpoint, e.g. `us-west-004` | either; the default `true` works |
| IDrive e2 | the endpoint shown for the bucket's region, `https://s3.<region>.idrivee2.com` | the `<region>` part of the endpoint, e.g. `us-west-1` | `true` |

## Credentials and permissions

`STORAGE_BUCKET` names the bucket, `STORAGE_ACCESS_KEY_ID` and
`STORAGE_SECRET_ACCESS_KEY` are the key pair, and the optional
`STORAGE_KEY_PREFIX` puts every object under a prefix so a bucket can be
shared. The key needs `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on
the bucket's objects and `s3:ListBucket` on the bucket itself: the health check
asks the bucket with a `HeadBucket`, which AWS S3 and MinIO gate on that
bucket-level permission, so a key with object rights alone stores media fine
but reports storage as down. On another provider, confirm with
`GET /health/storage` after the first deploy that the key's scope covers the
bucket call too. The API validates these at boot and refuses to start without
them. `GET /health/storage` and `GET /health/all` (admin only) report whether
the bucket answers; the public `/health` does not depend on it.

## Provider references

[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) and its
[AWS SDK JS v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/),
[B2 S3-compatible API endpoints](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api)
and its [AWS SDK JS v3 guide](https://www.backblaze.com/docs/cloud-storage-use-the-aws-sdk-for-javascript-v3-with-backblaze-b2),
[IDrive e2 endpoint URLs](https://www.idrive.com/s3-storage-e2/e2-endpoint-urls)
and its [developer guide](https://www.idrive.com/s3-storage-e2/guides/create_objects),
[MinIO `MINIO_DOMAIN`](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/settings/core/).

## Related

- [Environment variables](environment.md) — the `STORAGE_*` reference rows
- [Recording retention](../admin/recording-retention.md) — how long the bucket keeps audio
- [0002. Object storage behind one interface](../decisions/0002-object-storage-behind-one-interface.md)
