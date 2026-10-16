import {
  type ActionCtx,
  type ContentItem,
  type NumericContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

export const HIGHER_LOWER_ITEMS = 8;
const PAIR_COUNT = HIGHER_LOWER_ITEMS / 2;
/**
 * How many numeric items the engine actually fetches for one round. Only `HIGHER_LOWER_ITEMS`
 * of these end up on screen — the rest exist purely so `pairForHigherLower` has enough of a
 * spread to find same-kind matches in, even in a narrow category.
 */
export const HIGHER_LOWER_POOL = 24;
const POINTS_PER_PAIR = 50;
/**
 * Pairs whose values sit closer than this are a coin flip rather than a question, so they get
 * re-paired with a neighbour instead of shipping as-is.
 */
const NEAR_TIE_RATIO = 0.1;

export type HigherLowerPair = readonly [NumericContent, NumericContent];

/** Deterministic ordering — the pairing has to be reproducible, so no RNG here. */
function stableHash(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Coarse "kind of number" a numeric fact belongs to — years next to years, distances next to
 * distances — so a pair is never decided by which topic happens to produce bigger numbers
 * rather than by actually knowing the answer. Deliberately coarse (a handful of buckets, not
 * one per unit): most `unitAr` strings in the bank are one-off ("قيراط", "بيضة/أسبوع"...), so
 * bucketing by exact unit would leave almost nothing to pair against. Falls back to `count` —
 * plain numbers of things, still a fair fight since they share the same small-integer scale.
 */
const FAMILY_BY_UNIT: Record<string, string> = {
  سنة: 'time', قرن: 'time', شهر: 'time', شهور: 'time', أسبوع: 'time', يوم: 'time',
  ساعة: 'time', دقيقة: 'time', ثانية: 'time', هـ: 'time', موسم: 'time', 'ألف سنة': 'time',
  متر: 'distance', كم: 'distance', سم: 'distance', ملليمتر: 'distance', ياردة: 'distance',
  هكتار: 'distance', 'متر مربع': 'distance', مربع: 'distance', 'كم²': 'distance',
  'مليون كم²': 'distance', 'ألف كم': 'distance', 'ألف كم²': 'distance', 'مليون كم': 'distance',
  'سنة ضوئية': 'distance', 'مليون سنة ضوئية': 'distance',
  جرام: 'weight', كجم: 'weight', كيلوجرام: 'weight', مليجرام: 'weight', طن: 'weight', قيراط: 'weight',
  دولار: 'money', 'مليار دولار': 'money', جنيه: 'money',
  بالمية: 'percent', '%': 'percent',
  '°م': 'temperature', 'درجة مئوية': 'temperature', فهرنهايت: 'temperature',
  'كم/ساعة': 'speed', 'م/ث': 'speed', 'متر/ثانية': 'speed', 'كم/ث': 'speed', 'ألف كم/ث': 'speed',
  نبضة: 'rate', دقة: 'rate', 'دقة/دقيقة': 'rate', 'نفس/دقيقة': 'rate', 'مرة/ثانية': 'rate',
  هرتز: 'rate', 'ضربة/دقيقة': 'rate',
};

/** A bare number is still a year, and not a "count of things", if the text says so. */
const YEAR_PATTERN = /سن[ةه]/;

export function numericFamily(item: NumericContent): string {
  if (item.unitAr) return FAMILY_BY_UNIT[item.unitAr] ?? 'count';
  if (YEAR_PATTERN.test(item.textAr) && item.correctValue >= 1000 && item.correctValue <= 2100) {
    return 'time';
  }
  return 'count';
}

const isNearTie = (a: NumericContent, b: NumericContent): boolean => {
  const gap = Math.abs(a.correctValue - b.correctValue);
  const scale = Math.max(Math.abs(a.correctValue), Math.abs(b.correctValue), 1);
  return gap / scale < NEAR_TIE_RATIO;
};

/** Pairs up one family's items, breaking any coin-flip-close pair against its neighbour. */
function pairWithinFamily(group: NumericContent[]): HigherLowerPair[] {
  const pairs: Array<[NumericContent, NumericContent]> = [];
  for (let i = 0; i + 1 < group.length; i += 2) {
    pairs.push([group[i]!, group[i + 1]!]);
  }
  for (let i = 0; i < pairs.length - 1; i += 1) {
    const [a, b] = pairs[i]!;
    if (isNearTie(a, b)) {
      const next = pairs[i + 1]!;
      pairs[i] = [a, next[1]!];
      pairs[i + 1] = [next[0]!, b];
    }
  }
  return pairs;
}

/**
 * Picks four pairs out of the numeric items on offer, each pair comparing the same kind of
 * number — two years, two distances, two plain counts — so "which is bigger" is never a
 * giveaway just from the units involved. Deterministic from the question ids, so the same pool
 * always produces the same pairing regardless of the order it arrived in.
 *
 * The kind still rotates pair to pair when the pool has more than one: rather than exhausting
 * one family before moving to the next, it round-robins across families so a round very rarely
 * ends up as four years in a row.
 *
 * Exported so the test suite can predict a driver's pairing instead of re-implementing this
 * logic and risking it drifting out of sync with the real thing.
 */
export function pairForHigherLower(items: NumericContent[]): HigherLowerPair[] {
  const ordered = [...items].sort((a, b) => stableHash(a.id) - stableHash(b.id));

  const groups = new Map<string, NumericContent[]>();
  for (const item of ordered) {
    const family = numericFamily(item);
    const list = groups.get(family);
    if (list) list.push(item);
    else groups.set(family, [item]);
  }

  // Deterministic family order, independent of Map insertion order.
  const familyLists = [...groups.values()].sort((a, b) => stableHash(a[0]!.id) - stableHash(b[0]!.id));
  const familyPairLists = familyLists.map(pairWithinFamily);
  const leftovers = familyLists.filter((g) => g.length % 2 === 1).map((g) => g[g.length - 1]!);

  // Round-robin across families ("row" 0 of every family, then row 1, ...) so four pairs from a
  // pool with several kinds available don't all land on the same one.
  const pairs: HigherLowerPair[] = [];
  for (let row = 0; pairs.length < PAIR_COUNT; row += 1) {
    const before = pairs.length;
    for (const list of familyPairLists) {
      if (row < list.length) pairs.push(list[row]!);
      if (pairs.length >= PAIR_COUNT) break;
    }
    if (pairs.length === before) break; // every family's pairs are exhausted
  }

  // Only reachable with an unusually small or fragmented pool (a hand-built test fixture, a
  // near-empty category) — pair off whatever is left rather than shipping fewer than four pairs.
  for (let i = 0; pairs.length < PAIR_COUNT && i + 1 < leftovers.length; i += 2) {
    pairs.push([leftovers[i]!, leftovers[i + 1]!]);
  }

  return pairs.slice(0, PAIR_COUNT);
}

export interface HigherLowerState {
  pairs: HigherLowerPair[];
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** Index-aligned with `pairs`. */
  answers: Record<PlayerId, Array<'a' | 'b' | null>>;
  cursor: Record<PlayerId, number>;
  lastActionAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type HigherLowerAction = { kind: 'choose'; index: number; side: 'a' | 'b' };

const noChange = (state: HigherLowerState): StepResult<HigherLowerState> => ({ state, events: [] });

const correctSideOf = (pair: HigherLowerPair): 'a' | 'b' | null => {
  const [a, b] = pair;
  if (a.correctValue === b.correctValue) return null;
  return a.correctValue > b.correctValue ? 'a' : 'b';
};

/**
 * أعلى ولا أقل؟ — two numeric facts side by side, neither answer shown. Pick the one with the
 * bigger number.
 *
 * Each pair compares the same kind of number — two years, two distances, two plain counts —
 * never "سنة كام كسبت مصر أول أمم أفريقية؟" next to "عدد سكان مصر", where the answer is really
 * just "which topic tends to produce bigger numbers" rather than actual knowledge. The engine
 * hands this type a bigger pool than it needs (`HIGHER_LOWER_POOL`) precisely so
 * `pairForHigherLower` has room to find four same-kind pairs in; see its docs for how the kind
 * still rotates pair to pair. Each player moves through their four pairs at their own pace, same
 * as الكلمة الناقصة سريع.
 */
export const higherLower: RoundType<HigherLowerState, HigherLowerAction> = {
  id: 'higher_lower',
  nameAr: 'أعلى ولا أقل؟',
  taglineAr: 'رقمين من غير إجاباتهم — إجابة مين أكبر؟',
  scoringHintAr: 'كل زوج صح = 50 نقطة — أربعة صح = 200',
  contentShapes: ['numeric'],
  itemsPerRound: HIGHER_LOWER_ITEMS,
  /** Always the full pool, regardless of room size — this type doesn't grow with the party. */
  itemsFor: () => HIGHER_LOWER_POOL,
  pacing: 'fast',
  long: false,
  minPlayers: 2,
  requiresTeams: false,
  durationMs: 40_000,
  /** Four little "أهو كان أكبر فعلًا" moments. */
  revealWeight: 1.2,
  accent: 'emerald',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): HigherLowerState {
    const items = content.filter((c): c is NumericContent => c.shape === 'numeric');
    if (items.length < HIGHER_LOWER_ITEMS) {
      throw new Error(`higher_lower requires at least ${HIGHER_LOWER_ITEMS} numeric items`);
    }
    const pairs = pairForHigherLower(items);
    if (pairs.length !== PAIR_COUNT) {
      throw new Error(`higher_lower could not build ${PAIR_COUNT} pairs from ${items.length} items`);
    }
    const playerIds = init.players.map((p) => p.id);
    return {
      pairs,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      answers: Object.fromEntries(playerIds.map((id) => [id, Array(PAIR_COUNT).fill(null)])),
      cursor: Object.fromEntries(playerIds.map((id) => [id, 0])),
      lastActionAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<HigherLowerState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (action.kind !== 'choose') return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);
    if (action.side !== 'a' && action.side !== 'b') return noChange(state);

    const cursor = state.cursor[ctx.playerId] ?? 0;
    if (action.index !== cursor || cursor >= PAIR_COUNT) return noChange(state);

    const mine = [...(state.answers[ctx.playerId] ?? [])];
    mine[cursor] = action.side;

    const next: HigherLowerState = {
      ...state,
      answers: { ...state.answers, [ctx.playerId]: mine },
      cursor: { ...state.cursor, [ctx.playerId]: cursor + 1 },
      lastActionAtMs: { ...state.lastActionAtMs, [ctx.playerId]: ctx.nowMs },
    };
    next.closed = next.playerIds.every((id) => (next.cursor[id] ?? 0) >= PAIR_COUNT);

    const events: StepResult<HigherLowerState>['events'] = [
      { type: 'sub_round_advanced', index: cursor + 1 },
    ];
    if (next.closed) events.push({ type: 'all_locked' });
    return { state: next, events };
  },

  onDeadline(state): StepResult<HigherLowerState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const cursor = state.cursor[playerId] ?? 0;
    const pair = state.pairs[cursor];
    return {
      current: pair
        ? {
            index: cursor,
            a: { textAr: pair[0].textAr, unitAr: pair[0].unitAr ?? null },
            b: { textAr: pair[1].textAr, unitAr: pair[1].unitAr ?? null },
          }
        : null,
      answeredCount: cursor,
      totalPairs: PAIR_COUNT,
      isDone: cursor >= PAIR_COUNT,
      progress: state.playerIds.map((id) => ({ playerId: id, answered: state.cursor[id] ?? 0 })),
    };
  },

  reveal(state) {
    return {
      pairs: state.pairs.map((pair, i) => ({
        index: i,
        a: { textAr: pair[0].textAr, correctValue: pair[0].correctValue, unitAr: pair[0].unitAr ?? null },
        b: { textAr: pair[1].textAr, correctValue: pair[1].correctValue, unitAr: pair[1].unitAr ?? null },
        correctSide: correctSideOf(pair),
      })),
      answers: state.answers,
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
      const mine = state.answers[playerId] ?? [];
      let points = 0;
      let correctCount = 0;
      let answered = 0;

      for (const [i, pair] of state.pairs.entries()) {
        const given = mine[i];
        if (given === null || given === undefined) continue;
        answered += 1;
        const correctSide = correctSideOf(pair);
        if (correctSide !== null && given === correctSide) {
          points += POINTS_PER_PAIR;
          correctCount += 1;
        }
      }

      const lastAt = state.lastActionAtMs[playerId];
      return {
        playerId,
        points,
        isCorrect: correctCount === state.pairs.length,
        msTaken: answered > 0 && lastAt !== undefined ? Math.max(0, lastAt - state.startedAtMs) : null,
      };
    });
  },
};
