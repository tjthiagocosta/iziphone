import type { GreetingProbeOutcome } from './inbound-plan.js';

/*
 * Whether a configured voicemail greeting is something Twilio's <Play> verb
 * can actually play, checked with a HEAD request right before the voicemail
 * TwiML is rendered. A failed or non-audio <Play> fetch aborts the whole
 * TwiML document instead of skipping the verb, so an API or bucket outage
 * must never reach <Play> unconfirmed (see
 * .claude/research/2026-09-18/twilio-play-failure.md, Q1/Q3/Q5).
 *
 * `fetch` is a dependency, not the global, so a test can inject a fake
 * instead of reaching the network.
 */

const PROBE_TIMEOUT_MS = 2000;

/** The exact content types Twilio's <Play> verb accepts. */
const PLAYABLE_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/aiff',
  'audio/x-aifc',
  'audio/x-aiff',
  'audio/x-gsm',
  'audio/gsm',
  'audio/ulaw',
]);

export interface GreetingProbeDependencies {
  fetch: typeof fetch;
}

/**
 * `reachable` only for a 2xx response whose `content-type` is one of the
 * types `<Play>` supports. Anything else — a non-2xx, a non-audio type, a
 * network failure, or the 2 s bound running out — degrades the greeting
 * rather than the call.
 */
export async function probeGreetingUrl(
  url: string,
  deps: GreetingProbeDependencies,
): Promise<GreetingProbeOutcome> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return error instanceof Error && error.name === 'TimeoutError'
      ? 'timed-out'
      : 'unreachable';
  }

  if (!response.ok) {
    return 'unreachable';
  }

  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();

  return contentType && PLAYABLE_CONTENT_TYPES.has(contentType)
    ? 'reachable'
    : 'not-audio';
}
