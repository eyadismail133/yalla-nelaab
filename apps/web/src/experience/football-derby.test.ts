import { describe, expect, it } from 'vitest';
import { generatePlaylist } from '@game/rounds';
import { buildPresetConfig } from './MatchPresets.js';

describe('football derby preset', () => {
  it('selects football content and restricts mixed matches to its four supported mechanics', () => {
    const config = buildPresetConfig('football_derby', ['football', 'general']);
    expect(config.categoryIds).toEqual(['football']);
    const playlist = generatePlaylist({ ...config, playerCount: 4, availableShapes: ['mcq', 'numeric', 'progressive', 'open_answer'], rng: () => 0.5 });
    expect(playlist.every((round) => ['mcq_race', 'numeric_guess', 'who_am_i', 'fibbing'].includes(round.roundTypeId))).toBe(true);
    expect(new Set(playlist.map((round) => round.roundTypeId)).size).toBe(4);
  });
});
