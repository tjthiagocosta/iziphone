/** What became of a send the API refused. */
export interface SendFailure {
  /**
   * The API stored the message as failed, so the thread already shows it. The
   * draft has to be cleared, or the same text sits in the box and in the
   * thread at once.
   */
  persisted: boolean;
  message: string;
}

/**
 * Reads a failed send from its status rather than a code: the failure bodies
 * carry no machine-readable code, and the client's error mapping keeps only
 * the status and the message.
 *
 * 409 (the contact opted out), 422 (the provider rejected it) and 502 (the
 * provider could not be reached) each answer with a stored, failed message.
 * The refusals — an unknown conversation or sender, a destination the
 * provider will not take — store nothing, so the draft is all there is.
 */
export function sendFailureFrom(status: number, message: string): SendFailure {
  return {
    persisted: status === 409 || status === 422 || status === 502,
    message,
  };
}
