/*
 * The response headers every page carries.
 *
 * This app is worth framing: its buttons place calls on the customer's Twilio
 * account, and the admin console creates users and buys phone numbers. It is
 * also worth keeping quiet about, since conversation and call ids sit in the
 * path and would otherwise travel in the `Referer` header.
 *
 * The policy is built from the same URLs the browser is configured to call, so
 * a deployment that moves the API or the call controller does not also have to
 * remember to widen the policy.
 */

export interface SecurityHeaderOptions {
  /** Where the browser reaches the business API. */
  apiUrl: string;
  /** Where the browser reaches the call controller, over HTTP and a socket. */
  callControllerUrl: string;
  /** `next dev` evaluates code for its error overlay and reloads over a socket. */
  isDevelopment: boolean;
}

export interface HttpHeader {
  key: string;
  value: string;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    // A misconfigured URL leaves the app broken either way; it is not this
    // module's job to report it, only to avoid widening the policy for it.
    return null;
  }
}

function socketOriginOf(url: string): string | null {
  const origin = originOf(url);
  return origin === null ? null : origin.replace(/^http/, 'ws');
}

function isSource(source: string | null): source is string {
  return source !== null;
}

function isPlainHttp(origin: string): boolean {
  return origin.startsWith('http://') || origin.startsWith('ws://');
}

/** The Content-Security-Policy, serialized. */
export function contentSecurityPolicy({
  apiUrl,
  callControllerUrl,
  isDevelopment,
}: SecurityHeaderOptions): string {
  const backends = [
    originOf(apiUrl),
    originOf(callControllerUrl),
    socketOriginOf(callControllerUrl),
  ].filter(isSource);

  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    /*
     * Next.js inlines its bootstrap and the flight payload without a nonce.
     * Adding one would mean rendering every page per request, which is why
     * the login form reads its query string at submit time rather than with
     * `useSearchParams`. The rest of the policy is what carries the weight.
     */
    [
      'script-src',
      [
        "'self'",
        "'unsafe-inline'",
        ...(isDevelopment ? ["'unsafe-eval'"] : []),
      ],
    ],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    // `next/font` self-hosts Inter at build time.
    ['font-src', ["'self'"]],
    /*
     * The Twilio SDK plays its ringtones from its own CDN and hands the
     * remote audio track to an `<audio>` element as a blob. A voicemail is
     * played as a blob too: it is downloaded from the API under `connect-src`,
     * so the API needs no place here.
     */
    ['media-src', ["'self'", 'blob:', 'https://sdk.twilio.com']],
    [
      'connect-src',
      [
        "'self'",
        ...backends,
        /*
         * Twilio's signaling socket is per edge (`voice-js.<edge>.twilio.com`)
         * and call quality events go to `eventgw.<region>.twilio.com`, so the
         * host is only known once the SDK has picked a region.
         */
        'https://*.twilio.com',
        'wss://*.twilio.com',
        // The dev server pushes reloads over its own socket.
        ...(isDevelopment ? ['ws://localhost:*'] : []),
      ],
    ],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    /*
     * Only when there is nothing left to upgrade. A deployment that reaches
     * its API over plain http would otherwise have the browser rewrite the
     * requests this very policy allows, and every call would fail.
     */
    ...(isDevelopment || backends.some(isPlainHttp)
      ? []
      : ([['upgrade-insecure-requests', []]] as [string, string[]][])),
  ];

  return directives
    .map(([name, sources]) =>
      sources.length > 0 ? `${name} ${sources.join(' ')}` : name,
    )
    .join('; ');
}

/** Every security header the app sends, for `headers()` in `next.config.ts`. */
export function securityHeaders(options: SecurityHeaderOptions): HttpHeader[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(options) },
    // What `frame-ancestors` says, for anything that does not read CSP.
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // Ids in the path stay on this origin.
    { key: 'Referrer-Policy', value: 'same-origin' },
    // The softphone needs the microphone, and nothing else needs anything.
    {
      key: 'Permissions-Policy',
      value: 'camera=(), geolocation=(), microphone=(self), payment=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
}
