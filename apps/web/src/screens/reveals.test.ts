import { describe, expect, it } from 'vitest';
import { ROUND_TYPES } from '@game/rounds';
import { REVEALS } from './reveals.js';

/**
 * The result screen used to dispatch through a chain of `if (typeId === ...)`, and it fell
 * behind: six of the twelve round types reached the end of the chain and rendered nothing, so
 * players sat looking at an empty card under the heading "الإجابة الصح" for the full six
 * seconds of every one of those rounds.
 *
 * Nothing about that failure was loud — no error, no warning, no failing test. This is the
 * guard that makes it loud, and it reads from the round-type registry so it covers types that
 * do not exist yet.
 */
describe('reveal registry', () => {
  it('renders a reveal for every registered round type', () => {
    const missing = ROUND_TYPES.filter((type) => !REVEALS[type.id]).map((t) => t.id);
    expect(missing).toEqual([]);
  });

  it('has no renderer for a round type that no longer exists', () => {
    const registered = new Set(ROUND_TYPES.map((t) => t.id));
    const orphans = Object.keys(REVEALS).filter((id) => !registered.has(id));
    expect(orphans).toEqual([]);
  });
});
