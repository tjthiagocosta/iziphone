/**
 * Up to two letters for an avatar. Uses the first and last word of the name;
 * callers pass what to fall back to when there is no name (an email for a
 * signed-in user, the phone number for a contact).
 */
export function initialsOf(
  name: string | null | undefined,
  fallback: string,
): string {
  const parts = (name ?? '').split(' ').filter(Boolean);
  const first = parts[0];

  if (first) {
    const last = parts.length >= 2 ? parts[parts.length - 1] : undefined;
    const letters = last ? `${first[0]}${last[0]}` : first.slice(0, 2);
    return letters.toUpperCase();
  }

  return fallback.slice(0, 2).toUpperCase();
}
