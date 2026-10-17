import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TEAMS, type RoomView } from '@game/shared';
import { ROUND_TYPES } from '@game/rounds';
import { CATEGORIES } from '../content/index.js';
import { ar } from '../i18n/ar.js';
import type { GameTransport } from '../net/transport.js';
import { PodiumScreen } from './PodiumScreen.js';
import {
  buildInviteUrl,
  buildWhatsAppInviteHref,
  generateInviteQrDataUrl,
  isValidRoomCode,
  normalizeRoomCodeInput,
} from '../ui/InvitationPanel.js';
import {
  countConnectedPlayers,
  countReadyConnectedPlayers,
  evaluateFocusedRoundChoices,
  summarizeLobbyConfig,
} from './LobbyScreen.js';
import { resolveRoundTotalMs } from './RoundScreen.js';
import {
  normalizeRoundActionError,
  performRoundAction,
  reconcileSubmittedDraft,
} from '../rounds/useRoundAction.js';

describe('Invitation helpers', () => {
  it('normalizes and validates 5-character ASCII alphanumeric room codes', () => {
    expect(normalizeRoomCodeInput('kx7qm')).toBe('KX7QM');
    expect(normalizeRoomCodeInput('kx-7_qm#99')).toBe('KX7QM');
    expect(normalizeRoomCodeInput('   abc12345   ')).toBe('ABC12');

    expect(isValidRoomCode('KX7QM')).toBe(true);
    expect(isValidRoomCode('12345')).toBe(true);
    expect(isValidRoomCode('kx7qm')).toBe(false); // must be uppercase
    expect(isValidRoomCode('KX7Q')).toBe(false); // too short
    expect(isValidRoomCode('KX7QM9')).toBe(false); // too long
    expect(isValidRoomCode('KX7Q-')).toBe(false); // illegal character
  });

  it('builds canonical invite URLs and compose-only WhatsApp links', () => {
    const inviteUrl = buildInviteUrl('KX7QM', 'https://yalla-nelaab.web.app/');
    expect(inviteUrl).toBe('https://yalla-nelaab.web.app/?code=KX7QM');

    const whatsAppHref = buildWhatsAppInviteHref('KX7QM', inviteUrl);
    expect(whatsAppHref.startsWith('https://wa.me/?text=')).toBe(true);
    expect(whatsAppHref).toContain('KX7QM');
    expect(decodeURIComponent(whatsAppHref)).toContain(inviteUrl);
  });

  it('generates a local QR data URL without external network dependencies', async () => {
    const dataUrl = await generateInviteQrDataUrl('https://yalla-nelaab.web.app/?code=KX7QM');
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(100);
  });
});

describe('Lobby helpers and guest config summary', () => {
  const dummyPlayers: RoomView['players'] = [
    { id: 'p1', nickname: 'أحمد', connected: true, isHost: true, total: 0, rank: null, leftEarly: false, teamId: null, ready: true },
    { id: 'p2', nickname: 'سارة', connected: true, isHost: false, total: 0, rank: null, leftEarly: false, teamId: null, ready: false },
    { id: 'p3', nickname: 'كريم', connected: false, isHost: false, total: 0, rank: null, leftEarly: false, teamId: null, ready: true },
    { id: 'p4', nickname: 'ندى', connected: true, isHost: false, total: 0, rank: null, leftEarly: true, teamId: null, ready: true },
  ];

  it('counts only actively connected non-leftEarly players for lobby thresholds', () => {
    expect(countConnectedPlayers(dummyPlayers)).toBe(2); // p1 and p2
    expect(countReadyConnectedPlayers(dummyPlayers)).toBe(1); // p1 only
  });

  it('evaluates focused round choices accurately against connected player count and team status', () => {
    const availableTypes = [
      { id: 'mcq_race', nameAr: 'سباق الإجابات', taglineAr: 'أسرع واحد', accent: 'emerald' },
      { id: 'describe_it', nameAr: 'وصّفهالي', taglineAr: 'واحد يوصف', accent: 'emerald' },
      { id: 'fibbing', nameAr: 'الكذّابين', taglineAr: 'اكتب كذبة', accent: 'violet' },
    ];

    // 2 players, solo match
    const soloChoices = evaluateFocusedRoundChoices(availableTypes, 2, false);
    const mcq = soloChoices.find((c) => c.id === 'mcq_race')!;
    const describeIt = soloChoices.find((c) => c.id === 'describe_it')!;
    const fibbing = soloChoices.find((c) => c.id === 'fibbing')!;

    expect(mcq.eligibility.eligible).toBe(true);
    expect(describeIt.eligibility.eligible).toBe(false);
    expect(describeIt.eligibility.statusAr).toContain('فرق');
    expect(fibbing.eligibility.eligible).toBe(false); // needs 3 players

    // 4 players, team match
    const teamChoices = evaluateFocusedRoundChoices(availableTypes, 4, true);
    expect(teamChoices.find((c) => c.id === 'describe_it')!.eligibility.eligible).toBe(true);
  });

  it('summarizes lobby configuration for guests accurately', () => {
    const summary = summarizeLobbyConfig({
      config: {
        format: 'mixed',
        roundCount: 10,
        teams: false,
        categoryIds: ['football', 'cinema'],
      },
      availableCategories: CATEGORIES.map((c) => ({ ...c })),
      availableRoundTypes: [{ id: 'mcq_race', nameAr: 'سباق الإجابات', taglineAr: '', accent: 'emerald' }],
    });

    expect(summary.formatLabelAr).toBe('الخلطة');
    expect(summary.lengthLabelAr).toContain('10');
    expect(summary.teamsLabelAr).toContain('فردي');
    expect(summary.selectedCategories).toHaveLength(2);
    expect(summary.categoriesSummaryAr).toContain('2 من 14');
  });
});

describe('Round countdown total duration isolation across rematches', () => {
  it('derives and caches total duration per room/roundNo/deadline without leaking stale match length across rematches', () => {
    const cache = new Map<string, number>();

    const round1Match1 = {
      code: 'ROOM1',
      phase: 'in_round' as const,
      phaseEndsAtMs: 1_000_000 + 20_000,
      serverNowMs: 1_000_000,
      round: { roundNo: 1, typeId: 'mcq_race' },
    };
    expect(resolveRoundTotalMs(round1Match1, cache)).toBe(20_000);

    // Later tick of the same round retrieves cached initial duration so ring drains smoothly
    const round1Match1Tick = {
      ...round1Match1,
      serverNowMs: 1_000_000 + 5_000,
    };
    expect(resolveRoundTotalMs(round1Match1Tick, cache)).toBe(20_000);

    // Rematch starts in the same room with roundNo 1, but with a different round type and deadline
    const round1Match2 = {
      code: 'ROOM1',
      phase: 'in_round' as const,
      phaseEndsAtMs: 2_000_000 + 40_000,
      serverNowMs: 2_000_000,
      round: { roundNo: 1, typeId: 'higher_lower' },
    };
    expect(resolveRoundTotalMs(round1Match2, cache)).toBe(40_000);
  });
});

describe('Round action helpers and error resilience', () => {
  it('reconciles submitted drafts without erasing newly typed input', () => {
    // If the input was untouched during the request, it gets cleared
    expect(reconcileSubmittedDraft('إجابة قديمة', 'إجابة قديمة')).toBe('');

    // If the user typed new text while awaiting resolution, the new text is kept
    expect(reconcileSubmittedDraft('إجابة جديدة معدلة', 'إجابة قديمة')).toBe('إجابة جديدة معدلة');
  });

  it('normalizes arbitrary errors into friendly Arabic text', () => {
    expect(normalizeRoundActionError('انتهت الجولة')).toBe('انتهت الجولة');
    expect(normalizeRoundActionError(new Error('اللاعب مش موجود'))).toBe('اللاعب مش موجود');
    expect(normalizeRoundActionError(null)).toContain('مقدرناش نسجل');
    expect(normalizeRoundActionError(undefined)).toContain('مقدرناش نسجل');
  });

  it('handles rejected promises, transport errors, and bounded timeouts safely', async () => {
    // 1. Successful action
    const mockSuccessClient = {
      act: vi.fn().mockResolvedValue({ ok: true }),
    };
    const successRes = await performRoundAction(mockSuccessClient, 1, { kind: 'answer', choice: 0 });
    expect(successRes).toEqual({ ok: true });

    // 2. Transport error reply
    const mockFailClient = {
      act: vi.fn().mockResolvedValue({ ok: false, error: 'الوقت خلص' }),
    };
    const failRes = await performRoundAction(mockFailClient, 1, { kind: 'answer', choice: 0 });
    expect(failRes).toEqual({ ok: false, error: 'الوقت خلص' });

    // 3. Rejected promise / network crash handled cleanly without unhandled rejection
    const mockRejectClient = {
      act: vi.fn().mockRejectedValue(new Error('Network dropped')),
    };
    const rejectRes = await performRoundAction(mockRejectClient, 1, { kind: 'answer', choice: 0 });
    expect(rejectRes.ok).toBe(false);
    if (!rejectRes.ok) {
      expect(rejectRes.error).toBe('Network dropped');
    }

    // 4. Bounded timeout prevents hanging pending state indefinitely
    const mockHangingClient = {
      act: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    };
    const timeoutRes = await performRoundAction(mockHangingClient, 1, { kind: 'answer', choice: 0 }, 50);
    expect(timeoutRes.ok).toBe(false);
    if (!timeoutRes.ok) {
      expect(timeoutRes.error).toContain('انتهت مهلة الطلب');
    }
  });
});

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

const createMockTransport = (): GameTransport =>
  ({
    act: vi.fn(),
    rematch: vi.fn().mockResolvedValue({ ok: true }),
    setReady: vi.fn(),
    skip: vi.fn(),
    kick: vi.fn(),
    start: vi.fn(),
    configure: vi.fn(),
    leave: vi.fn(),
  }) as unknown as GameTransport;

describe('PodiumScreen full rendering regressions', () => {
  const mockClient = createMockTransport();

  it('renders a tie hero and never crowns an individual player when teams tie, even with projected winnerId', () => {
    const tiedTeamsWithIndividualWinnerView = makePodiumView({
      config: {
        format: 'mixed',
        categoryIds: CATEGORIES.map((c) => c.id),
        roundCount: 10,
        teams: true,
      },
      winnerId: 'p1', // engine projected individual top-scorer
      winningTeamId: null, // teams tied
      players: [
        {
          id: 'p1',
          nickname: 'أحمد',
          connected: true,
          isHost: true,
          total: 500,
          rank: 1,
          leftEarly: false,
          teamId: 'team-a',
        },
        {
          id: 'p2',
          nickname: 'سارة',
          connected: true,
          isHost: false,
          total: 500,
          rank: 1,
          leftEarly: false,
          teamId: 'team-b',
        },
      ],
      standings: [
        { playerId: 'p1', total: 500, correctCount: 5, totalMs: 15_000, rank: 1, rankDelta: 0 },
        { playerId: 'p2', total: 500, correctCount: 5, totalMs: 15_000, rank: 1, rankDelta: 0 },
      ],
      teamStandings: [
        { teamId: 'team-a', total: 500, rank: 1, memberIds: ['p1'] },
        { teamId: 'team-b', total: 500, rank: 1, memberIds: ['p2'] },
      ],
      endReason: 'completed',
    });

    const markup = renderToStaticMarkup(
      createElement(PodiumScreen, {
        view: tiedTeamsWithIndividualWinnerView,
        client: mockClient,
        onLeave: vi.fn(),
        onError: vi.fn(),
      }),
    );

    // 1. Hero announces shared win / tie with handshake emoji
    expect(markup).toContain('🤝');
    expect(markup).toContain(ar.sharedWin);

    // 2. Hero does NOT crown أحمد as an individual winner in the hero card
    expect(markup).not.toContain(`<p class="mt-2 text-sm text-muted">${ar.winner}</p>`);

    // 3. Scoreboards still preserve individual player names and rankings
    expect(markup).toContain('أحمد');
    expect(markup).toContain('سارة');
    expect(markup).toContain(ar.scoreboard);

    // 4. Team scoreboard is rendered with both teams and scores
    expect(markup).toContain(ar.teamScoreboard);
    expect(markup).toContain('الفريق الأحمر');
    expect(markup).toContain('الفريق الأزرق');

    // 5. ResultShare component is embedded cleanly and also reports the team tie
    expect(markup).toContain('شارك كارت النتيجة');
  });

  it('renders solo winner hero when a solo match has a winner', () => {
    const soloWinnerView = makePodiumView({
      config: {
        format: 'mixed',
        categoryIds: CATEGORIES.map((c) => c.id),
        roundCount: 10,
        teams: false,
      },
      winnerId: 'p1',
      winningTeamId: null,
      teamStandings: [],
    });

    const markup = renderToStaticMarkup(
      createElement(PodiumScreen, {
        view: soloWinnerView,
        client: mockClient,
        onLeave: vi.fn(),
        onError: vi.fn(),
      }),
    );

    expect(markup).toContain('🏆');
    expect(markup).toContain(ar.winner);
    expect(markup).toContain('أحمد');
    expect(markup).toContain('640');
  });

  it('renders winning team hero when a team match has a decisive winning team', () => {
    const teamWinnerView = makePodiumView({
      config: {
        format: 'mixed',
        categoryIds: CATEGORIES.map((c) => c.id),
        roundCount: 10,
        teams: true,
      },
      winnerId: null,
      winningTeamId: 'team-b',
      teamStandings: [
        { teamId: 'team-b', total: 600, rank: 1, memberIds: ['p2'] },
        { teamId: 'team-a', total: 400, rank: 2, memberIds: ['p1'] },
      ],
    });

    const markup = renderToStaticMarkup(
      createElement(PodiumScreen, {
        view: teamWinnerView,
        client: mockClient,
        onLeave: vi.fn(),
        onError: vi.fn(),
      }),
    );

    expect(markup).toContain(ar.winningTeam);
    expect(markup).toContain('الفريق الأزرق');
  });

  it('renders abandonment notice when the match ended early', () => {
    const abandonedView = makePodiumView({
      endReason: 'abandoned',
      winnerId: null,
      winningTeamId: null,
    });

    const markup = renderToStaticMarkup(
      createElement(PodiumScreen, {
        view: abandonedView,
        client: mockClient,
        onLeave: vi.fn(),
        onError: vi.fn(),
      }),
    );

    expect(markup).toContain(ar.endedEarly);
  });

  it('renders rematch button for host and waiting message for guest', () => {
    const hostView = makePodiumView({
      you: { id: 'p1', nickname: 'أحمد', isHost: true },
    });
    const hostMarkup = renderToStaticMarkup(
      createElement(PodiumScreen, {
        view: hostView,
        client: mockClient,
        onLeave: vi.fn(),
        onError: vi.fn(),
      }),
    );
    expect(hostMarkup).toContain(ar.rematch);
    expect(hostMarkup).not.toContain(ar.waitingForHost);

    const guestView = makePodiumView({
      you: { id: 'p2', nickname: 'سارة', isHost: false },
    });
    const guestMarkup = renderToStaticMarkup(
      createElement(PodiumScreen, {
        view: guestView,
        client: mockClient,
        onLeave: vi.fn(),
        onError: vi.fn(),
      }),
    );
    expect(guestMarkup).toContain(ar.waitingForHost);
    expect(guestMarkup).not.toContain(ar.rematch);
  });
});

