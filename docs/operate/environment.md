# Environment variables

Reference for whoever configures a stack. One row per variable: which services
read it and what it is for.

All services and the Prisma CLI read the root `.env`. `.env.example` documents
every variable with local defaults.

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | api, db | PostgreSQL connection string |
| `REDIS_URL` | api, call-controller | Redis connection string |
| `NODE_ENV` | all | `development` or `production`. Controls webhook signature validation and secure cookies |
| `LOG_LEVEL` | api, call-controller | Pino log level |
| `API_PORT`, `API_HOST` | api | Listen address (default `3001`) |
| `CALL_CONTROLLER_PORT`, `CALL_CONTROLLER_HOST` | call-controller | Listen address (default `3002`) |
| `BETTER_AUTH_SECRET` | api, call-controller | Session signing secret. Also signs the socket JWT. Generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | api | Public URL of the API. Auth callbacks, Twilio messaging webhooks and media links are built on it |
| `INTERNAL_API_TOKEN` | api, call-controller | Shared secret the call controller presents on the API's `/internal` routes. Generate with `openssl rand -base64 32` |
| `CORS_ORIGIN` | api, call-controller | Allowed browser origin (the web app URL). Its first entry is also where invite and reset links point |
| `TRUST_PROXY` | api | Whom to believe about `X-Forwarded-For` when deciding a client's address. `false` (the default), `true`, or the proxies' addresses or CIDR ranges. See [Deploying](deploy.md) |
| `SMTP_URL` | api | Optional. Where to send mail, as `smtp://user:pass@host:587` or `smtps://…`. Set it together with `EMAIL_FROM` |
| `EMAIL_FROM` | api | Optional. The `From` header, e.g. `Phone system <no-reply@example.com>`. Without these two the API sends no mail and the admin console shows every link to copy |
| `NEXT_PUBLIC_API_URL` | web | API URL the browser calls |
| `NEXT_PUBLIC_CALL_CONTROLLER_URL` | web | Call controller URL for Socket.IO and voice tokens |
| `WEBHOOK_BASE_URL` | api, call-controller | Public HTTPS base URL of the call controller that Twilio can reach |
| `INTERNAL_API_URL` | call-controller | Where the call controller reaches the API's internal routes (default `http://localhost:3001`) |
| `DEPARTMENT_CACHE_TTL_SECONDS` | api | Routing cache TTL in Redis (default 24 hours) |
| `STORAGE_ENDPOINT` | api | S3-compatible endpoint URL. Leave unset only for AWS S3 itself |
| `STORAGE_REGION`, `STORAGE_BUCKET` | api | Region value the provider expects (`auto` for R2) and the bucket name |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | api | Key pair with read, write and delete rights on the bucket |
| `STORAGE_FORCE_PATH_STYLE` | api | `true` or `false`. Defaults to `true` when `STORAGE_ENDPOINT` is set, `false` otherwise |
| `STORAGE_KEY_PREFIX` | api | Optional prefix in front of every object key |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | api, call-controller | Account credentials and webhook signature validation. Set both or neither |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET` | call-controller | Voice token minting |
| `TWILIO_TWIML_APP_SID` | call-controller | TwiML app for outbound browser calls |
| `TWILIO_HOLD_AUDIO_URL` | call-controller | Optional hold music URL |

In production, session cookies are set with the `__Secure-` prefix and require
HTTPS.

## Related

- [Object storage](object-storage.md) — which `STORAGE_*` values each provider wants
- [Twilio configuration](twilio.md) — where the `TWILIO_*` values come from
- [Email](email.md) — the optional SMTP pair
- [Deploying](deploy.md) — `TRUST_PROXY` and the reverse proxy
