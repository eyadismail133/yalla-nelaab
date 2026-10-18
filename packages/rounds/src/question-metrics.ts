import type { ActionCtx, AnyRoundType } from '@game/shared';
import type { QuickfireState } from './quickfire-tf.js';
import type { OddOneOutState } from './odd-one-out.js';
import type { BiddingState } from './bidding.js';
import type { LandGrabState } from './land-grab.js';
import type { LadderState } from './ladder.js';
import type { RelayState } from './relay.js';

// Compact snapshot tuples: question index, actor index, shown offset, answer offset, correctness.
type Exposure = [question: number, actor: number, shownMs: number, answeredMs: number | null, correct: boolean | null];
interface TrackedState {
  contentTelemetry?: { typeId: string; rows: Exposure[] };
  closed: boolean;
  playerIds: string[];
  startedAtMs: number;
}
interface VisibleQuestion { questionId: string; actorId: string }
function questionIds(id: string, state: unknown): string[] {
  if (id === 'relay') {
    const s = state as RelayState;
    return s.teamIds.flatMap((team) => (s.itemsByTeam[team] ?? []).map((item) => item.id));
  }
  return (state as { items: Array<{ id: string }> }).items.map((item) => item.id);
}

const SUPPORTED = new Set(['quickfire_tf', 'odd_one_out', 'bidding', 'land_grab', 'ladder', 'relay']);

/** Private snapshot metadata only; never returned by a reducer's view/reveal. */
function visibleQuestions(id: string, state: unknown): VisibleQuestion[] {
  if ((state as TrackedState).closed) return [];
  switch (id) {
    case 'quickfire_tf': {
      const s = state as QuickfireState;
      return s.playerIds.flatMap((actorId) => {
        const item = s.items[s.cursor[actorId] ?? 0];
        return item ? [{ actorId, questionId: item.id }] : [];
      });
    }
    case 'odd_one_out': {
      const s = state as OddOneOutState;
      return s.playerIds.flatMap((actorId) => s.items.map((item) => ({ actorId, questionId: item.id })));
    }
    case 'bidding': {
      const s = state as BiddingState;
      if (s.stage === 'bidding') return [];
      return s.playerIds.flatMap((actorId) => {
        const item = s.bids[actorId] === undefined ? undefined : s.items[s.cursor[actorId] ?? 0];
        return item ? [{ actorId, questionId: item.id }] : [];
      });
    }
    case 'land_grab': {
      const s = state as LandGrabState;
      return s.playerIds.flatMap((actorId) => {
        const cell = s.attempting[actorId];
        const item = cell === null || cell === undefined || s.owners[cell] ? undefined : s.items[cell];
        return item ? [{ actorId, questionId: item.id }] : [];
      });
    }
    case 'ladder': {
      const s = state as LadderState;
      return s.playerIds.flatMap((actorId) => {
        const item = s.locked[actorId] || s.busted[actorId] ? undefined : s.items[s.rung[actorId] ?? 0];
        return item ? [{ actorId, questionId: item.id }] : [];
      });
    }
    case 'relay': {
      const s = state as RelayState;
      return s.teamIds.flatMap((team) => {
        const item = s.itemsByTeam[team]?.[s.asked[team] ?? 0];
        const order = s.order[team] ?? [];
        const actorId = order[(s.activeIndex[team] ?? 0) % order.length];
        return item && actorId ? [{ actorId, questionId: item.id }] : [];
      });
    }
    default: return [];
  }
}

function response(id: string, before: unknown, action: unknown, actorId: string): { questionId: string; correct: boolean } | null {
  const a = action as { kind?: string; choice?: number; index?: number; cell?: number; value?: boolean };
  if (id === 'quickfire_tf' && a.kind === 'judge') {
    const s = before as QuickfireState;
    const item = s.items[s.cursor[actorId] ?? 0];
    return item ? { questionId: item.id, correct: a.value === item.isTrue } : null;
  }
  if (a.kind !== 'answer') return null;
  let item: { id: string; correctIndex: number } | undefined;
  switch (id) {
    case 'odd_one_out': {
      const odd = (before as OddOneOutState).items[a.index!];
      return odd ? { questionId: odd.id, correct: a.choice === odd.oddIndex } : null;
    }
    case 'bidding': {
      const s = before as BiddingState;
      item = s.items[s.cursor[actorId] ?? 0]; break;
    }
    case 'land_grab': {
      const s = before as LandGrabState;
      // A cell claimed while this player was reading is cancelled, not an incorrect answer.
      if (s.owners[a.cell!]) return null;
      item = s.items[a.cell!]; break;
    }
    case 'ladder': {
      const s = before as LadderState;
      item = s.items[s.rung[actorId] ?? 0]; break;
    }
    case 'relay': {
      const s = before as RelayState;
      const team = s.teamOf[actorId]!;
      item = s.itemsByTeam[team]?.[s.asked[team] ?? 0]; break;
    }
  }
  return item ? { questionId: item.id, correct: a.choice === item.correctIndex } : null;
}

function track(id: string, before: TrackedState, next: TrackedState, nowMs: number, action?: { value: unknown; ctx: ActionCtx }): TrackedState {
  if (!before.contentTelemetry || before === next) return next;
  const ids = questionIds(id, next);
  const elapsed = Math.max(0, nowMs - next.startedAtMs);
  const outcome = action ? response(id, before, action.value, action.ctx.playerId) : null;
  const answeredQuestion = outcome ? ids.indexOf(outcome.questionId) : -1;
  const answeredActor = action ? next.playerIds.indexOf(action.ctx.playerId) : -1;
  let rows: Exposure[] = before.contentTelemetry.rows.map((row) => outcome && row[0] === answeredQuestion && row[1] === answeredActor && row[3] === null
    ? [row[0], row[1], row[2], elapsed, outcome.correct] : row);
  if (id === 'land_grab') {
    const s = next as unknown as LandGrabState;
    rows = rows.filter(([cell, actor, , answered]) => answered !== null || !s.owners[cell] || s.owners[cell] === s.playerIds[actor]);
  }
  for (const visible of visibleQuestions(id, next)) {
    const question = ids.indexOf(visible.questionId);
    const actor = next.playerIds.indexOf(visible.actorId);
    if (!rows.some((row) => row[0] === question && row[1] === actor)) rows.push([question, actor, elapsed, null, null]);
  }
  return { ...next, contentTelemetry: { typeId: id, rows } };
}

/** Instrument accepted reducer transitions; legacy in-progress snapshots remain uninstrumented. */
export function withQuestionMetrics(type: AnyRoundType): AnyRoundType {
  if (!SUPPORTED.has(type.id)) return type;
  return {
    ...type,
    createState(content, init) {
      const state = type.createState(content, init);
      const ids = questionIds(type.id, state);
      const rows: Exposure[] = visibleQuestions(type.id, state).map((visible) => [ids.indexOf(visible.questionId), state.playerIds.indexOf(visible.actorId), 0, null, null]);
      return { ...state, contentTelemetry: { typeId: type.id, rows } };
    },
    reduce(state, action, ctx) {
      const step = type.reduce(state, action, ctx);
      return { ...step, state: track(type.id, state, step.state, ctx.nowMs, { value: action, ctx }) };
    },
    onDeadline(state, ctx) {
      const step = type.onDeadline(state, ctx);
      return { ...step, state: track(type.id, state, step.state, ctx.nowMs) };
    },
  };
}

export interface QuestionMetric { questionId: string; plays: number; answered: number; correct: number; totalSolveMs: number }
export function questionMetrics(state: unknown): QuestionMetric[] {
  const telemetry = (state as TrackedState | null)?.contentTelemetry;
  if (!telemetry) return [];
  const ids = questionIds(telemetry.typeId, state);
  const result = new Map<string, QuestionMetric>();
  for (const [question, , shown, answered, correct] of telemetry.rows) {
    const questionId = ids[question]!;
    const metric = result.get(questionId) ?? { questionId, plays: 0, answered: 0, correct: 0, totalSolveMs: 0 };
    metric.plays += 1;
    if (answered !== null) {
      metric.answered += 1;
      metric.correct += Number(correct === true);
      metric.totalSolveMs += Math.max(0, answered - shown);
    }
    result.set(questionId, metric);
  }
  return [...result.values()];
}
