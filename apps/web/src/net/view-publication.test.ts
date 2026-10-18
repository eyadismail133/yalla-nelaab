import { describe, expect, it } from 'vitest';
import { prepareViewPublication } from './view-publication.js';

const projection = (serverNowMs: number, choice: number | null = null) => ({
  slot: '1', json: JSON.stringify({ serverNowMs, round: { myChoice: choice } }),
  version: serverNowMs, updatedAtMs: serverNowMs, leaseOwnerId: 'runtime',
});

describe('view publication', () => {
  it('omits unchanged views while retaining canonical snapshot and acknowledgement writes', () => {
    const committed = new Map<string, string>();
    const first = prepareViewPublication({ 'views/player': projection(1) }, committed);
    for (const [path, signature] of first.signatures) committed.set(path, signature);
    const next = prepareViewPublication({
      'views/player': projection(2), snapshot: { version: 2 }, 'responses/player': { ok: true },
    }, committed);
    expect(next.updates).toEqual({ snapshot: { version: 2 }, 'responses/player': { ok: true } });
    expect(prepareViewPublication({ 'views/player': projection(3, 0) }, committed).updates)
      .toHaveProperty('views/player');
  });

  it('does not cache failed writes and republishes when lease fencing changes', () => {
    const committed = new Map<string, string>();
    prepareViewPublication({ 'views/player': projection(1) }, committed);
    expect(committed.size).toBe(0);
    const retry = prepareViewPublication({ 'views/player': projection(2) }, committed);
    expect(retry.updates).toHaveProperty('views/player');
    for (const [path, signature] of retry.signatures) committed.set(path, signature);
    const takeover = { ...projection(3), leaseOwnerId: 'successor' };
    expect(prepareViewPublication({ 'views/player': takeover }, committed).updates).toHaveProperty('views/player');
  });
});
