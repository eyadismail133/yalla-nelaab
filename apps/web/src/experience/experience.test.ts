import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEAMS, type RoomView } from '@game/shared';
import { ROUND_TYPES, getRoundType } from '@game/rounds';
import { CATEGORIES } from '../content/index.js';
import { ar } from '../i18n/ar.js';
import {
  GAME_EXAMPLES,
  GameDiscovery,
  buildDiscoveryCatalog,
  evaluateGameEligibility,
  getDiscoveryCategories,
} from './GameDiscovery.js';
import {
  MATCH_PRESETS,
  MatchPresets,
  buildPresetConfig,
  isPresetActive,
} from './MatchPresets.js';
import {
  ResultShare,
  sanitizeShareUrl,
  summarizeMatchResult,
} from './ResultShare.js';

function makePodiumView(overrides: Partial<RoomView> = {}): RoomView {
  return {
    code: 'KX7QM',
    phase: 'podium',
    phaseEndsAtMs: null,
    serverNowMs: 1_700_000_000_000,
    you: { id: 'p1', nickname: 'أحمد', isHost: true },
    players: [
      {
        id: 'p1',
        nickname: 'أحمد',
        connected: true,
        isHost: true,
        total: 640,
        rank: 1,
        leftEarly: false,
        teamId: null,
      },
      {
        id: 'p2',
        nickname: 'سارة',
        connected: true,
        isHost: false,
        total: 520,
        rank: 2,
        leftEarly: false,
        teamId: null,
      },
      {
        id: 'p3',
        nickname: 'كريم',
        connected: true,
        isHost: false,
        total: 390,
        rank: 3,
        leftEarly: false,
        teamId: null,
      },
    ],
    config: {
      format: 'mixed',
      categoryIds: CATEGORIES.map((c) => c.id),
      roundCount: 10,
      teams: false,
    },
    round: null,
    reveal: null,
    standings: [
      { playerId: 'p1', total: 640, correctCount: 5, totalMs: 18_000, rank: 1, rankDelta: 0 },
      { playerId: 'p2', total: 520, correctCount: 4, totalMs: 21_000, rank: 2, rankDelta: 0 },
      { playerId: 'p3', total: 390, correctCount: 3, totalMs: 25_000, rank: 3, rankDelta: 0 },
    ],
    teamStandings: [],
    teams: TEAMS,
    lastRoundScores: null,
    suddenDeath: null,
    winnerId: 'p1',
    winningTeamId: null,
    endReason: 'completed',
    availableCategories: CATEGORIES.map((c) => ({ ...c })),
    availableRoundTypes: ROUND_TYPES.map((t) => ({
      id: t.id,
      nameAr: t.nameAr,
      taglineAr: t.taglineAr,
      accent: t.accent,
    })),
    ...overrides,
  };
}

describe('GameDiscovery catalog and eligibility', () => {
  it('provides complete canonical metadata and concrete Arabic examples for all 18 round types', () => {
    const catalog = buildDiscoveryCatalog();
    expect(catalog.map((item) => item.id)).toEqual(ROUND_TYPES.map((t) => t.id));
    expect(catalog).toHaveLength(18);

    const registeredIds = new Set(ROUND_TYPES.map((t) => t.id));
    const exampleIds = Object.keys(GAME_EXAMPLES);
    expect(exampleIds.filter((id) => !registeredIds.has(id))).toEqual([]);

    for (const entry of catalog) {
      const canonical = getRoundType(entry.id);
      expect(entry.nameAr).toBe(canonical.nameAr);
      expect(entry.taglineAr).toBe(canonical.taglineAr);
      expect(entry.scoringHintAr).toBe(canonical.scoringHintAr);
      expect(entry.minPlayers).toBe(canonical.minPlayers);
      expect(entry.requiresTeams).toBe(canonical.requiresTeams);
      expect(entry.example.promptAr.trim().length).toBeGreaterThan(10);
      expect(entry.example.playAr.trim().length).toBeGreaterThan(10);
      expect(entry.example.outcomeAr.trim().length).toBeGreaterThan(10);
      expect(entry.example.promptAr).not.toMatch(/todo|placeholder|tbd/i);
      expect(entry.example.playAr).not.toMatch(/todo|placeholder|tbd/i);
      expect(entry.example.outcomeAr).not.toMatch(/todo|placeholder|tbd/i);
    }

    // Regressions from Task3a independent review:
    // Relay exposes question to the whole team and scores rung-based points
    expect(GAME_EXAMPLES['relay']!.promptAr).toContain('أعضاء الفريق كلهم');
    expect(GAME_EXAMPLES['relay']!.outcomeAr).toContain('٢٠٠ نقطة كاملة للفريق');

    // Ladder auto-banks on fifth correct rung
    expect(GAME_EXAMPLES['ladder']!.outcomeAr).toContain('الدرجة الخامسة');
    expect(GAME_EXAMPLES['ladder']!.outcomeAr).toContain('تلقائيًا');
  });

  it('exposes the 14 canonical topic categories from metadata without mutating the registry', () => {
    const categories = getDiscoveryCategories();
    expect(categories).toHaveLength(14);
    expect(categories.map((c) => c.id)).toEqual(CATEGORIES.map((c) => c.id));
  });

  it('explains player-count and team requirements accurately while keeping all 18 games browsable', () => {
    const mcq = getRoundType('mcq_race');
    const fibbing = getRoundType('fibbing');
    const describeIt = getRoundType('describe_it');

    const soloTwoPlayersMcq = evaluateGameEligibility(mcq, { playerCount: 2, teams: false });
    expect(soloTwoPlayersMcq.eligible).toBe(true);
    expect(soloTwoPlayersMcq.reasonsAr).toEqual([]);

    const soloTwoPlayersFibbing = evaluateGameEligibility(fibbing, { playerCount: 2, teams: false });
    expect(soloTwoPlayersFibbing.eligible).toBe(false);
    expect(soloTwoPlayersFibbing.reasonsAr.join(' ')).toContain('3');

    const soloTwoPlayersDescribe = evaluateGameEligibility(describeIt, {
      playerCount: 2,
      teams: false,
    });
    expect(soloTwoPlayersDescribe.eligible).toBe(false);
    expect(soloTwoPlayersDescribe.reasonsAr).toHaveLength(2);
    expect(soloTwoPlayersDescribe.reasonsAr.join(' ')).toContain('4');
    expect(soloTwoPlayersDescribe.reasonsAr.join(' ')).toContain('فرق');

    const teamTwoPlayersDescribe = evaluateGameEligibility(describeIt, {
      playerCount: 2,
      teams: true,
    });
    expect(teamTwoPlayersDescribe.eligible).toBe(false);
    expect(teamTwoPlayersDescribe.reasonsAr).toHaveLength(1);
    expect(teamTwoPlayersDescribe.reasonsAr[0]).toContain('4');

    const teamFourPlayersDescribe = evaluateGameEligibility(describeIt, {
      playerCount: 4,
      teams: true,
    });
    expect(teamFourPlayersDescribe.eligible).toBe(true);
    expect(teamFourPlayersDescribe.reasonsAr).toEqual([]);

    // All 18 remain in the default catalog even when the room only has 2 solo players
    const fullCatalogForTwo = buildDiscoveryCatalog({ playerCount: 2, teams: false }, 'all');
    expect(fullCatalogForTwo).toHaveLength(18);

    const eligibleOnlyForTwo = buildDiscoveryCatalog({ playerCount: 2, teams: false }, 'eligible');
    expect(eligibleOnlyForTwo.every((item) => item.eligibility.eligible)).toBe(true);
    expect(eligibleOnlyForTwo.length).toBeLessThan(18);
  });
});

describe('MatchPresets pure helper and preset definitions', () => {
  const allIds = CATEGORIES.map((c) => c.id);

  it('builds fresh configs for quick_mixed, football_night, and team_party without stale roundTypeId', () => {
    const inputIds = [...allIds];
    const quick = buildPresetConfig('quick_mixed', inputIds);
    expect(quick).toEqual({
      format: 'mixed',
      roundCount: 5,
      teams: false,
      categoryIds: allIds,
    });
    expect('roundTypeId' in quick).toBe(false);
    expect(quick.roundTypeId).toBeUndefined();

    const football = buildPresetConfig('football_night', inputIds);
    expect(football).toEqual({
      format: 'mixed',
      roundCount: 10,
      teams: false,
      categoryIds: ['football'],
    });
    expect('roundTypeId' in football).toBe(false);
    expect(football.roundTypeId).toBeUndefined();

    const party = buildPresetConfig('team_party', inputIds);
    expect(party).toEqual({
      format: 'mixed',
      roundCount: 10,
      teams: true,
      categoryIds: allIds,
    });
    expect('roundTypeId' in party).toBe(false);
    expect(party.roundTypeId).toBeUndefined();

    // Mutating returned categoryIds does not mutate subsequent calls or input array
    quick.categoryIds.push('extra');
    expect(buildPresetConfig('quick_mixed', inputIds).categoryIds).toEqual(allIds);
  });

  it('identifies active presets only when format is mixed and no focused roundTypeId is set', () => {
    const footballConfig = buildPresetConfig('football_night', allIds);
    expect(isPresetActive('football_night', footballConfig, allIds)).toBe(true);
    expect(isPresetActive('quick_mixed', footballConfig, allIds)).toBe(false);

    // A focused config or one carrying a stale roundTypeId does not match a mixed preset
    expect(
      isPresetActive(
        'football_night',
        { ...footballConfig, format: 'focused', roundTypeId: 'mcq_race' },
        allIds,
      ),
    ).toBe(false);
    expect(
      isPresetActive(
        'football_night',
        { ...footballConfig, roundTypeId: 'mcq_race' },
        allIds,
      ),
    ).toBe(false);
  });

  it('avoids exact minute claims in preset copy and explains the 4-player requirement for cooperative team games', () => {
    expect(MATCH_PRESETS.map((p) => p.id)).toEqual([
      'football_derby',
      'quick_mixed',
      'football_night',
      'team_party',
    ]);

    for (const preset of MATCH_PRESETS) {
      const combinedCopy = `${preset.titleAr} ${preset.subtitleAr} ${preset.badgeAr} ${preset.noteAr ?? ''}`;
      expect(combinedCopy).not.toMatch(/دقيقة|دقايق|دقائق|min|minute/i);
    }

    const teamPreset = MATCH_PRESETS.find((p) => p.id === 'team_party')!;
    expect(teamPreset.noteAr).toContain('4');
  });
});

describe('ResultShare summary and URL privacy', () => {
  it('summarizes a standard solo winner and strips room codes and tokens from the share URL', () => {
    const view = makePodiumView();
    const summary = summarizeMatchResult(
      view,
      'https://yalla-nelaab.web.app/room?code=KX7QM&token=sec_987654321#podium',
    );

    expect(summary.outcome).toBe('solo_winner');
    expect(summary.headlineAr).toBe('أحمد');
    expect(summary.wonByTieBreak).toBe(false);
    expect(summary.standings[0]?.isWinner).toBe(true);
    expect(summary.standings[0]?.total).toBe(640);
    expect(summary.siteUrl).toBe('https://yalla-nelaab.web.app');

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('KX7QM');
    expect(serialized).not.toContain('sec_987654321');
  });

  it('crowns the sudden-death winner when top standings are tied on points', () => {
    const view = makePodiumView({
      winnerId: 'p2',
      suddenDeath: {
        contenders: ['p1', 'p2'],
        attempt: 1,
        resolvedWinner: 'p2',
      },
      standings: [
        { playerId: 'p1', total: 640, correctCount: 5, totalMs: 18_000, rank: 1, rankDelta: 0 },
        { playerId: 'p2', total: 640, correctCount: 5, totalMs: 18_000, rank: 1, rankDelta: 0 },
        { playerId: 'p3', total: 390, correctCount: 3, totalMs: 25_000, rank: 3, rankDelta: 0 },
      ],
    });

    const summary = summarizeMatchResult(view, 'https://yalla-nelaab.web.app');
    expect(summary.outcome).toBe('solo_winner');
    expect(summary.headlineAr).toBe('سارة');
    expect(summary.wonByTieBreak).toBe(true);
    expect(summary.subtitleAr).toContain(ar.suddenDeath);
    expect(summary.standings.find((s) => s.playerId === 'p1')?.total).toBe(640);
    expect(summary.standings.find((s) => s.playerId === 'p2')?.total).toBe(640);
    expect(summary.standings.find((s) => s.playerId === 'p2')?.isWinner).toBe(true);
    expect(summary.standings.find((s) => s.playerId === 'p1')?.isWinner).toBe(false);
  });

  it('summarizes a winning team alongside team standings and member names', () => {
    const view = makePodiumView({
      config: {
        format: 'mixed',
        categoryIds: CATEGORIES.map((c) => c.id),
        roundCount: 10,
        teams: true,
      },
      players: [
        {
          id: 'p1',
          nickname: 'أحمد',
          connected: true,
          isHost: true,
          total: 500,
          rank: 2,
          leftEarly: false,
          teamId: 'team-a',
        },
        {
          id: 'p2',
          nickname: 'سارة',
          connected: true,
          isHost: false,
          total: 680,
          rank: 1,
          leftEarly: false,
          teamId: 'team-b',
        },
        {
          id: 'p3',
          nickname: 'كريم',
          connected: true,
          isHost: false,
          total: 420,
          rank: 3,
          leftEarly: false,
          teamId: 'team-a',
        },
        {
          id: 'p4',
          nickname: 'ندى',
          connected: true,
          isHost: false,
          total: 600,
          rank: 2,
          leftEarly: false,
          teamId: 'team-b',
        },
      ],
      winnerId: null,
      winningTeamId: 'team-b',
      teamStandings: [
        { teamId: 'team-b', total: 640, rank: 1, memberIds: ['p2', 'p4'] },
        { teamId: 'team-a', total: 460, rank: 2, memberIds: ['p1', 'p3'] },
      ],
    });

    const summary = summarizeMatchResult(view, 'https://yalla-nelaab.web.app');
    expect(summary.outcome).toBe('team_winner');
    expect(summary.badgeAr).toBe(ar.winningTeam);
    expect(summary.headlineAr).toContain('الفريق الأزرق');
    expect(summary.teamStandings).toHaveLength(2);
    expect(summary.teamStandings[0]?.isWinner).toBe(true);
    expect(summary.teamStandings[0]?.memberNames).toEqual(['سارة', 'ندى']);
  });

  it('distinguishes tied and abandoned matches accurately', () => {
    const tiedView = makePodiumView({
      winnerId: null,
      winningTeamId: null,
      endReason: 'completed',
      standings: [
        { playerId: 'p1', total: 500, correctCount: 4, totalMs: 20_000, rank: 1, rankDelta: 0 },
        { playerId: 'p2', total: 500, correctCount: 4, totalMs: 20_000, rank: 1, rankDelta: 0 },
      ],
    });
    const tiedSummary = summarizeMatchResult(tiedView, 'https://yalla-nelaab.web.app');
    expect(tiedSummary.outcome).toBe('tie');
    expect(tiedSummary.headlineAr).toBe(ar.sharedWin);

    // Regression from Task3a independent review:
    // When teams tie (winningTeamId = null), a team match MUST NOT fall through to claim a solo
    // winner even if the engine populated an individual winnerId for top score.
    const tiedTeamsWithIndividualWinnerView = makePodiumView({
      config: {
        format: 'mixed',
        categoryIds: CATEGORIES.map((c) => c.id),
        roundCount: 10,
        teams: true,
      },
      winnerId: 'p1', // engine projected individual top-scorer
      winningTeamId: null, // teams tied
      teamStandings: [
        { teamId: 'team-a', total: 500, rank: 1, memberIds: ['p1'] },
        { teamId: 'team-b', total: 500, rank: 1, memberIds: ['p2'] },
      ],
      endReason: 'completed',
    });
    const tiedTeamsSummary = summarizeMatchResult(
      tiedTeamsWithIndividualWinnerView,
      'https://yalla-nelaab.web.app',
    );
    expect(tiedTeamsSummary.outcome).toBe('tie');
    expect(tiedTeamsSummary.headlineAr).toBe(ar.sharedWin);
    expect(tiedTeamsSummary.headlineAr).not.toBe('أحمد');
    expect(tiedTeamsSummary.badgeAr).toBe(ar.teamScoreboard);
    expect(tiedTeamsSummary.standings.every((s) => !s.isWinner)).toBe(true);

    const abandonedView = makePodiumView({
      winnerId: null,
      winningTeamId: null,
      endReason: 'abandoned',
    });
    const abandonedSummary = summarizeMatchResult(abandonedView, 'https://yalla-nelaab.web.app');
    expect(abandonedSummary.outcome).toBe('abandoned');
    expect(abandonedSummary.headlineAr).toBe(ar.endedEarly);
  });

  it('sanitizes arbitrary URLs down to the origin without query strings or fragments and truncates overly long names', () => {
    expect(sanitizeShareUrl('https://yalla-nelaab.web.app/?code=ABCDE&token=xyz')).toBe(
      'https://yalla-nelaab.web.app',
    );
    expect(sanitizeShareUrl('http://192.168.1.15:5173/lobby?code=ABCDE#top')).toBe(
      'http://192.168.1.15:5173',
    );

    const longNameView = makePodiumView({
      players: [
        {
          id: 'p1',
          nickname: 'عبدالرحمن محمد أبو الفتوح الكبير جدا',
          connected: true,
          isHost: true,
          total: 700,
          rank: 1,
          leftEarly: false,
          teamId: null,
        },
      ],
      standings: [
        { playerId: 'p1', total: 700, correctCount: 5, totalMs: 12_000, rank: 1, rankDelta: 0 },
      ],
      winnerId: 'p1',
    });

    const summary = summarizeMatchResult(longNameView, 'https://yalla-nelaab.web.app');
    expect(Array.from(summary.headlineAr).length).toBeLessThanOrEqual(20);
    expect(summary.headlineAr.endsWith('…')).toBe(true);
    expect(Array.from(summary.standings[0]!.displayName).length).toBeLessThanOrEqual(18);
    expect(summary.standings[0]!.displayName.endsWith('…')).toBe(true);
  });

  it('renders GameDiscovery, MatchPresets, and ResultShare markup cleanly with collapsed defaults and no leaked room codes', () => {
    const discoveryHtml = renderToStaticMarkup(
      createElement(GameDiscovery, { playerCount: 2, teams: false }),
    );
    // All 14 topics and all 18 games appear in the accessible details markup
    for (const category of CATEGORIES) {
      expect(discoveryHtml).toContain(category.nameAr);
    }
    for (const roundType of ROUND_TYPES) {
      expect(discoveryHtml).toContain(roundType.nameAr);
      expect(discoveryHtml).toContain(roundType.scoringHintAr);
    }
    // Collapsed by default so Home create/join controls stay prominent
    expect(discoveryHtml).not.toContain('<details open=""');

    const presetsHtml = renderToStaticMarkup(
      createElement(MatchPresets, {
        availableCategoryIds: CATEGORIES.map((c) => c.id),
        playerCount: 1,
        onSelect: () => {},
      }),
    );
    expect(presetsHtml).toContain('سهرة سريعة');
    expect(presetsHtml).toContain('ليلة كورة');
    expect(presetsHtml).toContain('حفلة فرق');
    // Teams preset remains enabled even with 1 player in the lobby
    expect(presetsHtml).not.toContain('disabled=""');

    const shareHtml = renderToStaticMarkup(
      createElement(ResultShare, {
        view: makePodiumView(),
        siteUrl: 'https://yalla-nelaab.web.app/?code=KX7QM&token=secret',
      }),
    );
    expect(shareHtml).toContain('أحمد');
    expect(shareHtml).toContain('تحميل صورة النتيجة');
    expect(shareHtml).not.toContain('KX7QM');
    expect(shareHtml).not.toContain('secret');
  });
});
