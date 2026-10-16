/**
 * One colour per seat, used everywhere a player is drawn.
 *
 * With five players a nickname was enough to tell people apart. With eight it is not: the
 * scoreboard is a wall of Arabic names in the same weight, and قطع الأرض asks you to read
 * ownership off a grid at a glance while a timer runs. A stable colour per seat turns both
 * into something you recognise instead of read.
 *
 * Keyed by position in `view.players`, which the server sends in join order and never
 * reshuffles — so a player keeps their colour for the whole match, on every screen.
 */
const TINTS = [
  'emerald',
  'sky',
  'rose',
  'amber',
  'violet',
  'lime',
  'fuchsia',
  'orange',
] as const;

export function playerTint(players: Array<{ id: string }>, playerId: string | null): string {
  if (!playerId) return 'var(--color-surface-2)';
  const index = players.findIndex((p) => p.id === playerId);
  // An id that is not in the list is a player who has left mid-match; a neutral swatch is
  // better than colouring them as whoever happens to sit at index 0.
  if (index < 0) return 'var(--color-surface-2)';
  return `var(--color-accent-${TINTS[index % TINTS.length]})`;
}
