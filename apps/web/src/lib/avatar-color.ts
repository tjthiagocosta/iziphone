/** Tailwind background classes an avatar can take, in a fixed order. */
export const AVATAR_COLORS = [
  'bg-green-500',
  'bg-blue-500',
  'bg-purple-500',
  'bg-pink-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-teal-500',
  'bg-indigo-500',
  'bg-red-500',
  'bg-cyan-500',
] as const;

const FALLBACK_COLOR = AVATAR_COLORS[0];

/**
 * Picks a stable colour for an identifier. Key it on an id rather than a
 * display name so the colour does not change when someone is renamed.
 */
export function avatarColorFor(identifier: string): string {
  const hash = identifier
    .split('')
    .reduce((acc, char) => char.charCodeAt(0) + ((acc << 5) - acc), 0);

  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? FALLBACK_COLOR;
}
