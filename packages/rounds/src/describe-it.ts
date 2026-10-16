import {
  answersMatch,
  normalizeArabic,
  type ActionCtx,
  type ContentItem,
  type OpenAnswerContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

const FIRST_TEAM_POINTS = 200;
const LATER_TEAM_POINTS = 130;
export const MAX_CLUE_LENGTH = 60;

export interface DescribeItState {
  item: OpenAnswerContent;
  playerIds: PlayerId[];
  /** playerId → team. Solo players get their own single-member team. */
  teamOf: Record<PlayerId, string>;
  teamIds: string[];
  /** One describer per team, chosen deterministically from the question id. */
  describerOf: Record<string, PlayerId>;
  startedAtMs: number;
  endsAtMs: number;
  clues: Record<string, string[]>;
  /** Teams that got it, in the order they got it. */
  solvedOrder: string[];
  solvedAtMs: Record<string, number>;
  rejectedClues: Record<PlayerId, number>;
  /** Describers whose most recent clue gave the answer away. Cleared by their next clue. */
  lastClueRejected: PlayerId[];
  closed: boolean;
}

export type DescribeItAction = { kind: 'clue'; text: string } | { kind: 'guess'; text: string };

const noChange = (state: DescribeItState): StepResult<DescribeItState> => ({ state, events: [] });

function stableHash(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * الوصف — one player on each team sees the word and types clues; their teammates race to guess.
 *
 * This is the only round where players on the same side have to actually work together rather
 * than merely share a scoreboard, and it produces the loudest moments in the whole game: one
 * person frantically typing around a word they are not allowed to say while their friends shout
 * wrong answers.
 *
 * The describer is picked from a hash of the question id, so it rotates naturally between
 * rounds without anybody having to track whose turn it is.
 */
export const describeIt: RoundType<DescribeItState, DescribeItAction> = {
  id: 'describe_it',
  nameAr: 'وصّفهالي',
  taglineAr: 'واحد من الفريق بيوصف والباقي بيخمّنوا — بس ممنوع يقول الكلمة نفسها',
  scoringHintAr: 'أول فريق يعرفها = 200 للكل، واللي بعده = 130',
  contentShapes: ['open_answer'],
  itemsPerRound: 1,
  pacing: 'fast',
  long: false,
  minPlayers: 4,
  requiresTeams: true,
  durationMs: 60_000,
  /** The clues get read back out loud afterwards. */
  revealWeight: 1.3,
  accent: 'emerald',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): DescribeItState {
    const item = content[0];
    if (!item || item.shape !== 'open_answer') {
      throw new Error('describe_it requires one open_answer item');
    }

    const playerIds = init.players.map((p) => p.id);
    // A player with no team is their own team, so the round still runs (badly) outside a team
    // match rather than crashing.
    const teamOf = Object.fromEntries(init.players.map((p) => [p.id, p.teamId ?? `solo-${p.id}`]));
    const teamIds = [...new Set(Object.values(teamOf))];

    const describerOf: Record<string, PlayerId> = {};
    for (const teamId of teamIds) {
      const members = playerIds.filter((id) => teamOf[id] === teamId);
      describerOf[teamId] = members[stableHash(item.id + teamId) % members.length]!;
    }

    return {
      item,
      playerIds,
      teamOf,
      teamIds,
      describerOf,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      clues: Object.fromEntries(teamIds.map((id) => [id, []])),
      solvedOrder: [],
      solvedAtMs: {},
      rejectedClues: {},
      lastClueRejected: [],
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<DescribeItState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);

    const teamId = state.teamOf[ctx.playerId]!;
    if (state.solvedOrder.includes(teamId)) return noChange(state);
    const isDescriber = state.describerOf[teamId] === ctx.playerId;

    if (action.kind === 'clue') {
      if (!isDescriber) return noChange(state);
      if (typeof action.text !== 'string' || !action.text.trim()) return noChange(state);

      const text = action.text.trim().slice(0, MAX_CLUE_LENGTH);
      // Saying the word is the one rule. Rejecting it rather than penalising keeps the round
      // moving — the describer just tries again.
      if (leaksAnswer(text, state.item)) {
        return {
          state: {
            ...state,
            rejectedClues: {
              ...state.rejectedClues,
              [ctx.playerId]: (state.rejectedClues[ctx.playerId] ?? 0) + 1,
            },
            lastClueRejected: [...new Set([...state.lastClueRejected, ctx.playerId])],
          },
          events: [],
        };
      }

      return {
        state: {
          ...state,
          clues: { ...state.clues, [teamId]: [...(state.clues[teamId] ?? []), text] },
          lastClueRejected: state.lastClueRejected.filter((id) => id !== ctx.playerId),
        },
        events: [],
      };
    }

    if (action.kind === 'guess') {
      // The describer can see the answer, so they obviously cannot guess it.
      if (isDescriber) return noChange(state);
      if (typeof action.text !== 'string' || !action.text.trim()) return noChange(state);
      if (!answersMatch(action.text, state.item.answerAr, state.item.aliases)) return noChange(state);

      const next: DescribeItState = {
        ...state,
        solvedOrder: [...state.solvedOrder, teamId],
        solvedAtMs: { ...state.solvedAtMs, [teamId]: ctx.nowMs },
      };
      next.closed = next.teamIds.every((id) => next.solvedOrder.includes(id));

      const events: StepResult<DescribeItState>['events'] = [
        { type: 'player_locked', playerId: ctx.playerId },
      ];
      if (next.closed) events.push({ type: 'all_locked' });
      return { state: next, events };
    }

    return noChange(state);
  },

  onDeadline(state): StepResult<DescribeItState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const teamId = state.teamOf[playerId]!;
    const isDescriber = state.describerOf[teamId] === playerId;

    return {
      isDescriber,
      // The answer goes to exactly one player per team, and to nobody else.
      secretAr: isDescriber ? state.item.answerAr : null,
      // True only while the describer's most recent clue is the one that was rejected. A
      // running count made the warning permanent: one slip early on left "التلميح ده فيه
      // الكلمة" pinned to the screen for the rest of the round, under clues that were fine.
      lastClueRejected: state.lastClueRejected.includes(playerId),
      // Clues stay inside the team — the other side does not get to ride along.
      clues: state.clues[teamId] ?? [],
      rejectedCount: state.rejectedClues[playerId] ?? 0,
      teamSolved: state.solvedOrder.includes(teamId),
      solvedTeams: state.solvedOrder.length,
      totalTeams: state.teamIds.length,
    };
  },

  reveal(state) {
    return {
      answerAr: state.item.answerAr,
      explanationAr: state.item.explanationAr ?? null,
      clues: state.clues,
      solvedOrder: state.solvedOrder,
      describerOf: state.describerOf,
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    return state.closed ? null : state.endsAtMs;
  },

  roundScores(state): RoundScore[] {
    return state.playerIds.map((playerId) => {
      const teamId = state.teamOf[playerId]!;
      const place = state.solvedOrder.indexOf(teamId);
      if (place === -1) return { playerId, points: 0, isCorrect: false, msTaken: null };

      // Everyone on the team scores the same, describer included. The round is a team effort
      // and splitting the credit would just start arguments.
      return {
        playerId,
        points: place === 0 ? FIRST_TEAM_POINTS : LATER_TEAM_POINTS,
        isCorrect: true,
        msTaken: Math.max(0, (state.solvedAtMs[teamId] ?? state.endsAtMs) - state.startedAtMs),
      };
    });
  },
};

/**
 * Blocks the answer itself, its aliases, and any distinctive word of it hidden inside a clue.
 *
 * The length floor matters more than it looks. At three characters the filter starts rejecting
 * ordinary Arabic: "كان" is half of "مهرجان كان" and also the commonest verb in the language, so
 * a describer typing "الفيلم ده كان حلو" would be told off for nothing and conclude the game is
 * broken. Four characters and up are distinctive enough to be a real giveaway — and a short
 * answer stays fully protected either way, because saying it outright is caught above
 * regardless of length.
 */
function leaksAnswer(text: string, item: OpenAnswerContent): boolean {
  if (answersMatch(text, item.answerAr, item.aliases)) return true;

  const clue = normalizeArabic(text);
  const banned = [item.answerAr, ...item.aliases]
    .flatMap((phrase) => normalizeArabic(phrase).split(' '))
    .filter((word) => word.length >= 4);

  return banned.some((word) => clue.includes(word));
}
