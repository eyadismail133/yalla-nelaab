import {
  type ActionCtx,
  type ContentItem,
  type DeadlineCtx,
  type McqContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

const CORRECT_POINTS = 120;
const STEAL_REWARD = 80;
const STEAL_PENALTY = -40;
/** What the victim loses. Deliberately smaller than the thief's gain — see the note below. */
const VICTIM_LOSS = -40;
const ANSWER_MS = 15_000;
// Scanning seven names and deciding who looked lost takes longer than scanning four did.
const STEAL_MS = 18_000;

export interface StealState {
  item: McqContent;
  playerIds: PlayerId[];
  startedAtMs: number;
  stage: 'answering' | 'stealing' | 'done';
  answerEndsAtMs: number;
  stealEndsAtMs: number | null;
  answers: Record<PlayerId, { choice: number; atMs: number }>;
  /** thief → victim. Only players who answered correctly may steal. */
  steals: Record<PlayerId, PlayerId>;
  /** Correct answerers who chose not to rob anybody. Tracked so the stage can end early. */
  passed: PlayerId[];
  closed: boolean;
}

export type StealAction =
  | { kind: 'answer'; choice: number }
  | { kind: 'steal'; targetId: PlayerId }
  | { kind: 'pass' };

const noChange = (state: StealState): StepResult<StealState> => ({ state, events: [] });

const wasCorrect = (state: StealState, playerId: PlayerId): boolean =>
  state.answers[playerId]?.choice === state.item.correctIndex;

/**
 * السرقة — answer, and if you got it right, take points off somebody who didn't.
 *
 * The only round where one player's score can go down because of what another player did, and
 * that changes the table. You do not know who was wrong, so a steal is a read on the room
 * rather than a certainty, and a wrong read costs you. It also self-corrects the runaway
 * leader problem: the obvious person to rob is whoever is winning.
 *
 * The thief gains more than the victim loses on purpose. Symmetric theft turns a friendly game
 * into a grudge — the round should feel like a heist, not a punishment.
 */
export const steal: RoundType<StealState, StealAction> = {
  id: 'steal',
  nameAr: 'السرقة',
  taglineAr: 'جاوب صح الأول، وبعدين اسرق نقط من اللي شايف إنه غلط',
  scoringHintAr: 'صح = 120، سرقة ناجحة = +80، سرقة فاشلة = −40',
  contentShapes: ['mcq'],
  itemsPerRound: 1,
  pacing: 'fast',
  long: false,
  // With two players the only possible target is the other one, so there is no read to make.
  minPlayers: 3,
  requiresTeams: false,
  durationMs: ANSWER_MS + STEAL_MS,
  /** Who robbed whom is the entire conversation. */
  revealWeight: 1.5,
  accent: 'rose',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): StealState {
    const item = content[0];
    if (!item || item.shape !== 'mcq') throw new Error('steal requires one mcq item');
    return {
      item,
      playerIds: init.players.map((p) => p.id),
      startedAtMs: init.startedAtMs,
      stage: 'answering',
      answerEndsAtMs: init.startedAtMs + ANSWER_MS,
      stealEndsAtMs: null,
      answers: {},
      steals: {},
      passed: [],
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<StealState> {
    if (state.closed) return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);

    if (state.stage === 'answering' && action.kind === 'answer') {
      if (ctx.nowMs > state.answerEndsAtMs) return noChange(state);
      if (state.answers[ctx.playerId]) return noChange(state);
      if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice > 3) {
        return noChange(state);
      }

      const answers = { ...state.answers, [ctx.playerId]: { choice: action.choice, atMs: ctx.nowMs } };
      const next: StealState = { ...state, answers };

      if (state.playerIds.every((id) => answers[id])) {
        return { state: openStealing(next, ctx.nowMs), events: [{ type: 'all_locked' }] };
      }
      return { state: next, events: [{ type: 'player_locked', playerId: ctx.playerId }] };
    }

    if (state.stage === 'stealing') {
      if (state.stealEndsAtMs !== null && ctx.nowMs > state.stealEndsAtMs) return noChange(state);
      // Only a correct answer earns the right to rob somebody.
      if (!wasCorrect(state, ctx.playerId)) return noChange(state);
      if (state.steals[ctx.playerId]) return noChange(state);

      if (state.passed.includes(ctx.playerId)) return noChange(state);

      if (action.kind === 'pass') {
        return {
          state: closeIfSettled({ ...state, passed: [...state.passed, ctx.playerId] }),
          events: [{ type: 'player_locked', playerId: ctx.playerId }],
        };
      }
      if (action.kind !== 'steal') return noChange(state);
      if (action.targetId === ctx.playerId) return noChange(state);
      if (!state.playerIds.includes(action.targetId)) return noChange(state);

      const next: StealState = {
        ...state,
        steals: { ...state.steals, [ctx.playerId]: action.targetId },
      };
      return {
        state: closeIfSettled(next),
        events: [{ type: 'player_locked', playerId: ctx.playerId }],
      };
    }

    return noChange(state);
  },

  onDeadline(state, ctx: DeadlineCtx): StepResult<StealState> {
    if (state.stage === 'answering') {
      return {
        state: openStealing(state, ctx.nowMs),
        events: [{ type: 'sub_round_advanced', index: 1 }],
      };
    }
    if (state.stage === 'stealing') {
      return { state: { ...state, stage: 'done', closed: true }, events: [] };
    }
    return noChange(state);
  },

  view(state, playerId) {
    if (state.stage === 'answering') {
      const mine = state.answers[playerId];
      return {
        stage: 'answering' as const,
        textAr: state.item.textAr,
        options: state.item.options,
        myChoice: mine?.choice ?? null,
        hasAnswered: mine !== undefined,
        lockedCount: Object.keys(state.answers).length,
        totalPlayers: state.playerIds.length,
      };
    }

    return {
      stage: 'stealing' as const,
      textAr: state.item.textAr,
      // You learn whether *you* were right, because you need it to know if you can steal. You
      // learn nothing about anybody else — guessing who slipped up is the whole round.
      iWasCorrect: wasCorrect(state, playerId),
      targets: state.playerIds.filter((id) => id !== playerId),
      myTarget: state.steals[playerId] ?? null,
      hasActed: state.steals[playerId] !== undefined || state.passed.includes(playerId),
      lockedCount: Object.keys(state.steals).length + state.passed.length,
      // Only correct answerers may steal, so counting the whole room here made the progress
      // line stall at "2 / 5" and stay there — the round looked stuck at the exact moment it
      // was waiting on nobody.
      totalPlayers: state.playerIds.filter((id) => wasCorrect(state, id)).length,
    };
  },

  reveal(state) {
    return {
      textAr: state.item.textAr,
      options: state.item.options,
      correctIndex: state.item.correctIndex,
      explanationAr: state.item.explanationAr ?? null,
      choices: Object.fromEntries(Object.entries(state.answers).map(([id, a]) => [id, a.choice])),
      steals: Object.entries(state.steals).map(([thiefId, victimId]) => ({
        thiefId,
        victimId,
        succeeded: !wasCorrect(state, victimId),
      })),
    };
  },

  isFinished(state) {
    return state.closed;
  },

  nextDeadline(state) {
    if (state.closed) return null;
    if (state.stage === 'answering') return state.answerEndsAtMs;
    return state.stealEndsAtMs;
  },

  roundScores(state): RoundScore[] {
    const delta = new Map<PlayerId, number>();
    const bump = (id: PlayerId, amount: number) => delta.set(id, (delta.get(id) ?? 0) + amount);

    for (const [thiefId, victimId] of Object.entries(state.steals)) {
      if (!wasCorrect(state, thiefId)) continue;
      if (wasCorrect(state, victimId)) {
        bump(thiefId, STEAL_PENALTY);
      } else {
        bump(thiefId, STEAL_REWARD);
        bump(victimId, VICTIM_LOSS);
      }
    }

    return state.playerIds.map((playerId) => {
      const answer = state.answers[playerId];
      const correct = wasCorrect(state, playerId);
      const base = correct ? CORRECT_POINTS : 0;

      return {
        playerId,
        points: base + (delta.get(playerId) ?? 0),
        isCorrect: correct,
        msTaken: answer ? Math.max(0, answer.atMs - state.startedAtMs) : null,
      };
    });
  },
};

/**
 * Opens the stealing stage — or skips straight past it.
 *
 * If nobody answered correctly there is nothing to steal and nobody entitled to try, so the
 * round would otherwise park on a dead screen for the full fifteen seconds. This runs on both
 * entry paths, because a room where everybody answers quickly and everybody is wrong reaches
 * here without the deadline ever firing.
 */
function openStealing(state: StealState, nowMs: number): StealState {
  const opened: StealState = { ...state, stage: 'stealing', stealEndsAtMs: nowMs + STEAL_MS };
  if (!state.playerIds.some((id) => wasCorrect(state, id))) {
    return { ...opened, stage: 'done', closed: true };
  }
  return opened;
}

/**
 * The stealing stage ends once every player who could act has acted.
 *
 * Passing counts as acting, which is why it is recorded rather than ignored — otherwise a room
 * where everybody declines to steal would sit out the full timer for nothing.
 */
function closeIfSettled(state: StealState): StealState {
  const settled = state.playerIds
    .filter((id) => wasCorrect(state, id))
    .every((id) => state.steals[id] !== undefined || state.passed.includes(id));

  return settled ? { ...state, stage: 'done', closed: true } : state;
}
