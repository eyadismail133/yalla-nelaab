import {
  answersMatch,
  normalizeArabic,
  type ActionCtx,
  type ContentItem,
  type DeadlineCtx,
  type OpenAnswerContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

const TRUTH_POINTS = 100;
/** Split across however many players could have been fooled, so the ceiling never moves. */
const MAX_FOOL_POINTS = 100;
const WRITE_MS = 40_000;
/**
 * Voting time scales with how much there is to read.
 *
 * The vote list is one line per player plus the truth, so a room of three reads four lines and
 * a room of eight reads nine. A flat thirty seconds was comfortable for the first and a
 * scramble for the second — and in a bluffing round, rushing the read is the whole game lost:
 * players stop weighing the lies and just tap something.
 */
const VOTE_MS_BASE = 16_000;
const VOTE_MS_PER_OPTION = 4_000;
const VOTE_MS_MAX = 52_000;

const voteMsFor = (optionCount: number): number =>
  Math.min(VOTE_MS_MAX, VOTE_MS_BASE + VOTE_MS_PER_OPTION * optionCount);
export const MAX_LIE_LENGTH = 60;

export const TRUTH_OPTION_ID = 'truth';

export interface FibbingOption {
  id: string;
  textAr: string;
  /** Null for the real answer. Never sent to the client before the reveal. */
  authorIds: PlayerId[];
}

export interface FibbingState {
  item: OpenAnswerContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  stage: 'writing' | 'voting' | 'done';
  writeEndsAtMs: number;
  voteEndsAtMs: number | null;
  /** What each player wrote. A player whose lie happens to be the truth is recorded separately. */
  lies: Record<PlayerId, string>;
  accidentalTruths: PlayerId[];
  options: FibbingOption[];
  votes: Record<PlayerId, string>;
  voteAtMs: Record<PlayerId, number>;
}

export type FibbingAction =
  | { kind: 'lie'; text: string }
  | { kind: 'vote'; optionId: string };

const noChange = (state: FibbingState): StepResult<FibbingState> => ({ state, events: [] });

/** Deterministic ordering — the state must be reproducible, so no RNG here. */
function stableHash(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function buildOptions(state: FibbingState): FibbingOption[] {
  // Identical lies merge into one option, and both authors get credit for anyone it fools —
  // otherwise the same text would appear twice and give the game away.
  const byText = new Map<string, FibbingOption>();

  for (const playerId of state.playerIds) {
    const text = state.lies[playerId];
    if (!text) continue;
    if (state.accidentalTruths.includes(playerId)) continue;

    const key = normalizeArabic(text);
    const existing = byText.get(key);
    if (existing) existing.authorIds.push(playerId);
    else byText.set(key, { id: `lie-${stableHash(key)}`, textAr: text, authorIds: [playerId] });
  }

  const options = [...byText.values()];
  options.push({ id: TRUTH_OPTION_ID, textAr: state.item.answerAr, authorIds: [] });
  return options.sort((a, b) => stableHash(a.id + state.item.id) - stableHash(b.id + state.item.id));
}

/**
 * الكذّابين — a question with an obscure answer. Everyone writes a fake, then everyone tries to
 * spot the real one among them.
 *
 * This is the only round type where players compete against each other rather than against the
 * question, and it is the reason it exists: you win by knowing the answer *or* by writing a lie
 * convincing enough to catch your friends. Both halves are fun, and a player who knows nothing
 * about the topic can still take the round.
 *
 * It is also the cheapest content in the game — the question needs a truth and nothing else,
 * because the players write the distractors.
 */
export const fibbing: RoundType<FibbingState, FibbingAction> = {
  id: 'fibbing',
  nameAr: 'الكذّابين',
  taglineAr: 'اكتب إجابة مضروبة تلغبط بيها صحابك، وحاول تعرف الإجابة الحقيقية',
  scoringHintAr: 'تعرف الصح = 100، وكل واحد يقع في كذبتك = نقط زيادة',
  contentShapes: ['open_answer'],
  itemsPerRound: 1,
  pacing: 'thinking',
  long: true,
  // With two players there is one lie and one truth: a coin flip, and nobody to fool.
  minPlayers: 3,
  requiresTeams: false,
  // Nominal: the real vote window is sized to the room in .
  durationMs: WRITE_MS + voteMsFor(5),
  /** Nine lines and a full vote tally — the funniest thirty seconds in the match. */
  revealWeight: 1.7,
  accent: 'violet',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): FibbingState {
    const item = content[0];
    if (!item || item.shape !== 'open_answer') {
      throw new Error('fibbing requires one open_answer item');
    }
    return {
      item,
      playerIds: init.players.map((p) => p.id),
      startedAtMs: init.startedAtMs,
      stage: 'writing',
      writeEndsAtMs: init.startedAtMs + WRITE_MS,
      voteEndsAtMs: null,
      lies: {},
      accidentalTruths: [],
      options: [],
      votes: {},
      voteAtMs: {},
    };
  },

  reduce(state, action, ctx): StepResult<FibbingState> {
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);

    if (state.stage === 'writing' && action.kind === 'lie') {
      if (ctx.nowMs > state.writeEndsAtMs) return noChange(state);
      if (state.lies[ctx.playerId]) return noChange(state);
      if (typeof action.text !== 'string' || !action.text.trim()) return noChange(state);

      const text = action.text.trim().slice(0, MAX_LIE_LENGTH);
      const next: FibbingState = { ...state, lies: { ...state.lies, [ctx.playerId]: text } };

      // Guessing the truth while trying to lie is rewarded, not punished — and the answer must
      // not then appear twice in the vote list.
      if (answersMatch(text, state.item.answerAr, state.item.aliases)) {
        next.accidentalTruths = [...state.accidentalTruths, ctx.playerId];
      }

      const everyoneWrote = next.playerIds.every((id) => next.lies[id]);
      if (everyoneWrote) return { state: openVoting(next, ctx.nowMs), events: [{ type: 'all_locked' }] };
      return { state: next, events: [{ type: 'player_locked', playerId: ctx.playerId }] };
    }

    if (state.stage === 'voting' && action.kind === 'vote') {
      if (state.voteEndsAtMs !== null && ctx.nowMs > state.voteEndsAtMs) return noChange(state);
      if (state.votes[ctx.playerId]) return noChange(state);

      const option = state.options.find((o) => o.id === action.optionId);
      if (!option) return noChange(state);
      // Voting for your own lie would be free points for nothing.
      if (option.authorIds.includes(ctx.playerId)) return noChange(state);

      const next: FibbingState = {
        ...state,
        votes: { ...state.votes, [ctx.playerId]: option.id },
        voteAtMs: { ...state.voteAtMs, [ctx.playerId]: ctx.nowMs },
      };
      const everyoneVoted = next.playerIds.every((id) => next.votes[id]);
      if (everyoneVoted) {
        return { state: { ...next, stage: 'done' }, events: [{ type: 'all_locked' }] };
      }
      return { state: next, events: [{ type: 'player_locked', playerId: ctx.playerId }] };
    }

    return noChange(state);
  },

  onDeadline(state, ctx: DeadlineCtx): StepResult<FibbingState> {
    if (state.stage === 'writing') {
      return { state: openVoting(state, ctx.nowMs), events: [{ type: 'sub_round_advanced', index: 1 }] };
    }
    if (state.stage === 'voting') return { state: { ...state, stage: 'done' }, events: [] };
    return noChange(state);
  },

  view(state, playerId) {
    if (state.stage === 'writing') {
      return {
        stage: 'writing' as const,
        textAr: state.item.textAr,
        myLie: state.lies[playerId] ?? null,
        lockedCount: Object.keys(state.lies).length,
        totalPlayers: state.playerIds.length,
      };
    }

    return {
      stage: 'voting' as const,
      textAr: state.item.textAr,
      // Author ids are stripped: seeing who wrote what is the entire puzzle.
      options: state.options.map((o) => ({ id: o.id, textAr: o.textAr })),
      // Your own lie is shown as unpickable rather than hidden, so the list still makes sense.
      myOptionIds: state.options.filter((o) => o.authorIds.includes(playerId)).map((o) => o.id),
      myVote: state.votes[playerId] ?? null,
      lockedCount: Object.keys(state.votes).length,
      totalPlayers: state.playerIds.length,
    };
  },

  reveal(state) {
    const votesByOption = new Map<string, PlayerId[]>();
    for (const [voter, optionId] of Object.entries(state.votes)) {
      votesByOption.set(optionId, [...(votesByOption.get(optionId) ?? []), voter]);
    }

    return {
      textAr: state.item.textAr,
      answerAr: state.item.answerAr,
      explanationAr: state.item.explanationAr ?? null,
      options: state.options.map((o) => ({
        id: o.id,
        textAr: o.textAr,
        isTruth: o.id === TRUTH_OPTION_ID,
        authorIds: o.authorIds,
        voterIds: votesByOption.get(o.id) ?? [],
      })),
      accidentalTruths: state.accidentalTruths,
    };
  },

  isFinished(state) {
    return state.stage === 'done';
  },

  nextDeadline(state) {
    if (state.stage === 'writing') return state.writeEndsAtMs;
    if (state.stage === 'voting') return state.voteEndsAtMs;
    return null;
  },

  roundScores(state): RoundScore[] {
    const foolCount = new Map<PlayerId, number>();
    for (const [voter, optionId] of Object.entries(state.votes)) {
      const option = state.options.find((o) => o.id === optionId);
      if (!option || option.id === TRUTH_OPTION_ID) continue;
      for (const author of option.authorIds) {
        if (author === voter) continue;
        foolCount.set(author, (foolCount.get(author) ?? 0) + 1);
      }
    }

    // Everyone except yourself is fool-able, so dividing by that keeps the maximum at exactly
    // MAX_FOOL_POINTS whether the room has three players or five.
    const foolable = Math.max(1, state.playerIds.length - 1);

    return state.playerIds.map((playerId) => {
      const foundTruth =
        state.votes[playerId] === TRUTH_OPTION_ID || state.accidentalTruths.includes(playerId);
      const fooled = foolCount.get(playerId) ?? 0;

      const points =
        (foundTruth ? TRUTH_POINTS : 0) + Math.round((MAX_FOOL_POINTS * fooled) / foolable);
      const votedAt = state.voteAtMs[playerId];

      return {
        playerId,
        points,
        isCorrect: foundTruth,
        msTaken: votedAt === undefined ? null : Math.max(0, votedAt - state.startedAtMs),
      };
    });
  },
};

function openVoting(state: FibbingState, nowMs: number): FibbingState {
  const voting: FibbingState = { ...state, stage: 'voting', voteEndsAtMs: nowMs };
  const options = buildOptions(voting);
  return { ...voting, options, voteEndsAtMs: nowMs + voteMsFor(options.length) };
}
