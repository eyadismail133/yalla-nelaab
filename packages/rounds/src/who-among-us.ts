import {
  type ActionCtx,
  type ContentItem,
  type PlayerId,
  type PollContent,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

const MAX_POINTS = 200;

export interface WhoAmongUsState {
  item: PollContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** voter → the player they voted for. Voting for yourself is allowed, and often the funniest. */
  votes: Record<PlayerId, PlayerId>;
  voteAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type WhoAmongUsAction = { kind: 'vote'; targetId: PlayerId };

const noChange = (state: WhoAmongUsState): StepResult<WhoAmongUsState> => ({ state, events: [] });

/**
 * مين فينا؟ — a prompt about the people in the room, and everybody votes for somebody.
 *
 * There is no correct answer, which is the point twice over. It makes the game about the people
 * playing rather than about trivia — the round everyone remembers afterwards is this one — and
 * it makes the content free: a prompt cannot be factually wrong, so it needs no review, no
 * fact-checking, and no maintenance as the world changes.
 *
 * Points come from agreeing with the room, so the skill is reading your friends rather than
 * knowing anything.
 */
export const whoAmongUs: RoundType<WhoAmongUsState, WhoAmongUsAction> = {
  id: 'who_among_us',
  nameAr: 'مين فينا؟',
  taglineAr: 'صوّت على اللي شايفه الأقرب — النقط على قد ما رأيك يوافق الجماعة',
  scoringHintAr: 'كل واحد يوافقك في اختيارك بيزوّد نقطك',
  contentShapes: ['poll'],
  itemsPerRound: 1,
  pacing: 'fast',
  long: false,
  // With two players every vote is trivially unanimous or split, so there is nothing to read.
  minPlayers: 3,
  requiresTeams: false,
  // One tap, but up to eight names to weigh it against.
  durationMs: 25_000,
  /** The result is an opinion, not an answer. The room needs time to disagree with it. */
  revealWeight: 1.6,
  accent: 'amber',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): WhoAmongUsState {
    const item = content[0];
    if (!item || item.shape !== 'poll') throw new Error('who_among_us requires one poll item');
    return {
      item,
      playerIds: init.players.map((p) => p.id),
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      votes: {},
      voteAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<WhoAmongUsState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'vote') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (!state.playerIds.includes(action.targetId)) return noChange(state);
    if (state.votes[ctx.playerId]) return noChange(state);

    const votes = { ...state.votes, [ctx.playerId]: action.targetId };
    const everyoneVoted = state.playerIds.every((id) => votes[id]);
    const next: WhoAmongUsState = {
      ...state,
      votes,
      voteAtMs: { ...state.voteAtMs, [ctx.playerId]: ctx.nowMs },
      closed: everyoneVoted,
    };

    return {
      state: next,
      events: everyoneVoted
        ? [{ type: 'player_locked', playerId: ctx.playerId }, { type: 'all_locked' }]
        : [{ type: 'player_locked', playerId: ctx.playerId }],
    };
  },

  onDeadline(state): StepResult<WhoAmongUsState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    return {
      textAr: state.item.textAr,
      candidates: state.playerIds,
      myVote: state.votes[playerId] ?? null,
      hasVoted: state.votes[playerId] !== undefined,
      // Running tallies are withheld until the reveal so nobody just follows the leader.
      lockedCount: Object.keys(state.votes).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    const tally = new Map<PlayerId, PlayerId[]>();
    for (const [voter, target] of Object.entries(state.votes)) {
      tally.set(target, [...(tally.get(target) ?? []), voter]);
    }

    return {
      textAr: state.item.textAr,
      tally: [...tally.entries()]
        .map(([targetId, voterIds]) => ({ targetId, voterIds, count: voterIds.length }))
        .sort((a, b) => b.count - a.count),
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    return state.closed ? null : state.endsAtMs;
  },

  roundScores(state): RoundScore[] {
    const counts = new Map<PlayerId, number>();
    for (const target of Object.values(state.votes)) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    const topCount = Math.max(0, ...counts.values());

    // Proportional rather than all-or-nothing: agreeing with three of four others should beat
    // agreeing with one, and a near-miss on a split vote should not score zero.
    const others = Math.max(1, state.playerIds.length - 1);

    return state.playerIds.map((playerId) => {
      const myVote = state.votes[playerId];
      if (!myVote) return { playerId, points: 0, isCorrect: false, msTaken: null };

      const agreeing = (counts.get(myVote) ?? 1) - 1;
      const votedAt = state.voteAtMs[playerId];

      return {
        playerId,
        points: Math.round((MAX_POINTS * agreeing) / others),
        isCorrect: (counts.get(myVote) ?? 0) === topCount && topCount > 0,
        msTaken: votedAt === undefined ? null : Math.max(0, votedAt - state.startedAtMs),
      };
    });
  },
};
