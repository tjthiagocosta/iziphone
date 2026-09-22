/*
 * What the browser does when the call controller says a conversation changed.
 * The rules are here so they can be tested without a browser; the effects that
 * fetch on them are thin edges over them.
 */

/**
 * How long a listener waits after an event before it reads. Each event resets
 * the wait, so a contact sending three messages, or a send whose status moves
 * twice, costs one request instead of one each. Short enough that the agent
 * sees it as immediate.
 */
export const ACTIVITY_REFRESH_DELAY_MS = 500;
