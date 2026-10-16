import type { AnyRoundType, ContentItem, NumericContent, PlayerRef } from '@game/shared';
import { ROUND_TYPES } from './registry.js';
import { pairForHigherLower } from './higher-lower.js';

/**
 * Test-only drivers: for each round type, how to play it perfectly and how to play it randomly.
 *
 * `assertEveryTypeHasADriver` is what gives the invariant suite its teeth. A new round type
 * added without a driver fails the build, so it cannot slip past the 200-point ceiling check
 * or the answer-redaction check by simply not being tested.
 */

export const START_MS = 1_700_000_000_000;

export interface ScriptedAction {
  playerId: string;
  action: unknown;
}

export interface Driver {
  content(): ContentItem[];

  /**
   * The full-room script that scores the theoretical maximum for `playerIds[0]`.
   *
   * A script rather than one player's actions, because some types cannot be maxed alone: in
   * الكذّابين the fool bonus depends on what everyone else votes for, and in مين فينا؟ the
   * score is agreement with the room. Pretending otherwise would let those types quietly skip
   * the ceiling check.
   */
  optimalScript(playerIds: string[]): ScriptedAction[];

  /** One plausible action for `playerId` given where the round currently is. */
  randomAction(rng: () => number, step: number, state: unknown, playerId: string): unknown;

  /** Strings that must never appear in a view before anybody has acted. */
  forbiddenValues(): string[];
}

const base = { categoryId: 'test', difficulty: 3 as const };

/**
 * Well-separated on purpose — no pair sits within the near-tie band `pairForHigherLower` swaps
 * around, so the pairing it produces is exactly "sorted by id hash, chunked in twos" with no
 * reordering to predict.
 */
const HIGHER_LOWER_CONTENT = Array.from({ length: 8 }, (_, i) => ({
  ...base,
  id: `q-hl-${i}`,
  shape: 'numeric' as const,
  textAr: `قيمة رقم ${i + 1}`,
  correctValue: (i + 1) * 500,
  tolerance: 0,
}));

const RELAY_CONTENT = Array.from({ length: 8 }, (_, i) => ({
  ...base,
  id: `q-relay-${i}`,
  shape: 'mcq' as const,
  textAr: `سؤال التتابع رقم ${i + 1}`,
  options: ['أ', 'ب', 'ج', 'د'],
  correctIndex: 2,
}));

const WORD_RACE_CONTENT = [
  {
    ...base,
    id: 'q-word-race',
    shape: 'word_race' as const,
    fieldsAr: ['اسم', 'حيوان', 'جماد', 'بلاد'],
    // Length 1 so the round's stable-hash letter pick always lands on the same index —
    // whatever the hash, `% 1` is 0.
    letters: ['م'],
  },
];

export const DRIVERS: Record<string, Driver> = {
  mcq_race: {
    content: () => [
      {
        ...base,
        id: 'q-mcq',
        shape: 'mcq',
        textAr: 'مين أكتر نادي كسب دوري أبطال أفريقيا؟',
        options: ['الزمالك', 'الترجي', 'الأهلي', 'الرجاء'],
        correctIndex: 2,
      },
    ],
    optimalScript: (ids) => [{ playerId: ids[0]!, action: { kind: 'answer', choice: 2 } }],
    randomAction: (rng) => ({ kind: 'answer', choice: Math.floor(rng() * 4) }),
    forbiddenValues: () => [],
  },

  numeric_guess: {
    content: () => [
      {
        ...base,
        id: 'q-num',
        shape: 'numeric',
        textAr: 'سنة كام كانت ثورة يوليو؟',
        correctValue: 1952,
        tolerance: 0,
      },
    ],
    optimalScript: (ids) => [{ playerId: ids[0]!, action: { kind: 'guess', value: 1952 } }],
    randomAction: (rng) => ({ kind: 'guess', value: 1900 + Math.floor(rng() * 100) }),
    forbiddenValues: () => ['1952'],
  },

  quickfire_tf: {
    content: () =>
      Array.from({ length: 5 }, (_, i) => ({
        ...base,
        id: `q-tf-${i}`,
        shape: 'boolean' as const,
        textAr: `عبارة رقم ${i + 1}`,
        isTrue: i % 2 === 0,
      })),
    optimalScript: (ids) =>
      Array.from({ length: 5 }, (_, i) => ({
        playerId: ids[0]!,
        action: { kind: 'judge', index: i, value: i % 2 === 0 },
      })),
    randomAction: (rng, step) => ({ kind: 'judge', index: step, value: rng() > 0.5 }),
    forbiddenValues: () => ['عبارة رقم 2', 'عبارة رقم 3', 'عبارة رقم 4', 'عبارة رقم 5'],
  },

  fill_blank: {
    content: () => [
      {
        ...base,
        id: 'q-fb',
        shape: 'fill_blank',
        textAr: 'اللي يشوف بلوى غيره تهون عليه ____',
        answerAr: 'بلواه',
        aliases: [],
      },
    ],
    optimalScript: (ids) => [{ playerId: ids[0]!, action: { kind: 'submit', text: 'بلواه' } }],
    randomAction: (rng) => ({
      kind: 'submit',
      text: ['بلواه', 'مصيبته', 'حاجة'][Math.floor(rng() * 3)],
    }),
    forbiddenValues: () => ['بلواه'],
  },

  fibbing: {
    content: () => [
      {
        ...base,
        id: 'q-fib',
        shape: 'open_answer',
        textAr: 'إيه أكتر فاكهة بتتاكل في العالم؟',
        answerAr: 'الطماطم',
        aliases: ['طماطم'],
      },
    ],
    // Everyone writes, then the room falls for player one's lie while player one finds the
    // truth: 100 for the truth plus the full fool bonus.
    optimalScript: (ids) => [
      ...ids.map((playerId, i) => ({ playerId, action: { kind: 'lie', text: `كذبة ${i}` } })),
      { playerId: ids[0]!, action: { kind: 'vote', optionId: 'truth' } },
      ...ids.slice(1).map((playerId) => ({
        playerId,
        action: { kind: 'vote', optionId: '__lie_of_player_0__' },
      })),
    ],
    randomAction: (rng, _step, state, playerId) => {
      const s = state as { stage: string; options?: Array<{ id: string }> };
      if (s.stage === 'writing') {
        return { kind: 'lie', text: `كذبة ${Math.floor(rng() * 5)}-${playerId}` };
      }
      const options = s.options ?? [];
      const pick = options[Math.floor(rng() * options.length)];
      return { kind: 'vote', optionId: pick?.id ?? 'truth' };
    },
    forbiddenValues: () => ['الطماطم'],
  },

  who_among_us: {
    content: () => [
      { ...base, id: 'q-poll', shape: 'poll', textAr: 'مين أكتر واحد فينا بيتأخر على المواعيد؟' },
    ],
    // Unanimity on player one's choice is the maximum: everyone agreeing with you is the whole
    // scoring rule.
    optimalScript: (ids) => ids.map((playerId) => ({ playerId, action: { kind: 'vote', targetId: ids[1] ?? ids[0] } })),
    randomAction: (rng, _step, state) => {
      const s = state as { playerIds: string[] };
      return { kind: 'vote', targetId: s.playerIds[Math.floor(rng() * s.playerIds.length)] };
    },
    forbiddenValues: () => [],
  },

  who_am_i: {
    content: () => [
      {
        ...base,
        id: 'q-whoami',
        shape: 'progressive',
        hints: ['أنا حيوان بيعيش في الصحرا', 'بقدر أستحمل العطش أيام', 'بيقولوا عليا سفينة الصحرا'],
        answerAr: 'الجمل',
        aliases: ['جمل'],
      },
    ],
    // Guessing on the first clue alone is the only route to the ceiling.
    optimalScript: (ids) => [{ playerId: ids[0]!, action: { kind: 'guess', text: 'الجمل' } }],
    randomAction: (rng) => ({
      kind: 'guess',
      text: ['الجمل', 'الحصان', 'الأسد'][Math.floor(rng() * 3)],
    }),
    forbiddenValues: () => ['الجمل', 'بيقولوا عليا سفينة الصحرا'],
  },

  ordering: {
    content: () => [
      {
        ...base,
        id: 'q-order',
        shape: 'ordering',
        textAr: 'رتّبهم من الأقدم للأحدث',
        items: ['ثورة يوليو', 'تأميم القناة', 'النكسة', 'حرب أكتوبر'],
        labels: ['1952', '1956', '1967', '1973'],
      },
    ],
    optimalScript: (ids) => {
      // The board is shuffled deterministically, so the winning taps are worked out from the
      // same hash the round uses rather than assumed.
      const correct = ['ثورة يوليو', 'تأميم القناة', 'النكسة', 'حرب أكتوبر'];
      const shuffled = [...correct].sort(
        (a, b) => stableHashForTests(a + 'q-order') - stableHashForTests(b + 'q-order'),
      );
      return correct.map((label) => ({
        playerId: ids[0]!,
        action: { kind: 'place', index: shuffled.indexOf(label) },
      }));
    },
    randomAction: (rng, _step, state) => {
      const s = state as { shuffled: string[] };
      return { kind: 'place', index: Math.floor(rng() * s.shuffled.length) };
    },
    forbiddenValues: () => [],
  },

  steal: {
    content: () => [
      {
        ...base,
        id: 'q-steal',
        shape: 'mcq',
        textAr: 'مين كسب كأس العالم 2022؟',
        options: ['فرنسا', 'البرازيل', 'الأرجنتين', 'ألمانيا'],
        correctIndex: 2,
      },
    ],
    // Player one answers correctly, everyone else gets it wrong, then player one robs a victim.
    optimalScript: (ids) => [
      { playerId: ids[0]!, action: { kind: 'answer', choice: 2 } },
      ...ids.slice(1).map((playerId) => ({ playerId, action: { kind: 'answer', choice: 0 } })),
      { playerId: ids[0]!, action: { kind: 'steal', targetId: ids[1] } },
    ],
    randomAction: (rng, _step, state, playerId) => {
      const s = state as { stage: string; playerIds: string[] };
      if (s.stage === 'answering') return { kind: 'answer', choice: Math.floor(rng() * 4) };
      const targets = s.playerIds.filter((id) => id !== playerId);
      if (rng() < 0.3) return { kind: 'pass' };
      return { kind: 'steal', targetId: targets[Math.floor(rng() * targets.length)] };
    },
    forbiddenValues: () => [],
  },

  bidding: {
    content: () =>
      Array.from({ length: 4 }, (_, i) => ({
        ...base,
        id: `q-bid-${i}`,
        shape: 'mcq' as const,
        textAr: `سؤال المزايدة رقم ${i + 1}`,
        options: ['أ', 'ب', 'ج', 'د'],
        correctIndex: i % 4,
      })),
    // The maximum bid, delivered in full. Every player has to bid before the questions open,
    // so the script covers the whole room even though only player one is being measured.
    optimalScript: (ids) => [
      { playerId: ids[0]!, action: { kind: 'bid', amount: 4 } },
      ...ids.slice(1).map((playerId) => ({ playerId, action: { kind: 'bid', amount: 1 } })),
      ...Array.from({ length: 4 }, (_, i) => ({
        playerId: ids[0]!,
        action: { kind: 'answer', index: i, choice: i % 4 },
      })),
    ],
    randomAction: (rng, step, state) => {
      const s = state as { stage: string };
      if (s.stage === 'bidding') return { kind: 'bid', amount: 1 + Math.floor(rng() * 4) };
      return { kind: 'answer', index: step, choice: Math.floor(rng() * 4) };
    },
    forbiddenValues: () => [],
  },

  land_grab: {
    content: () =>
      Array.from({ length: 9 }, (_, i) => ({
        ...base,
        id: `q-land-${i}`,
        shape: 'mcq' as const,
        textAr: `سؤال المربع ${i + 1}`,
        options: ['أ', 'ب', 'ج', 'د'],
        correctIndex: i % 4,
      })),
    // Sweeping the whole board: nine squares plus a line.
    optimalScript: (ids) =>
      Array.from({ length: 9 }, (_, cell) => [
        { playerId: ids[0]!, action: { kind: 'open', cell } },
        { playerId: ids[0]!, action: { kind: 'answer', cell, choice: cell % 4 } },
      ]).flat(),
    randomAction: (rng, _step, state, playerId) => {
      const s = state as {
        attempting: Record<string, number | null>;
        owners: Record<number, string>;
      };
      const open = s.attempting[playerId];
      if (open !== null && open !== undefined) {
        return { kind: 'answer', cell: open, choice: Math.floor(rng() * 4) };
      }
      const free = Array.from({ length: 9 }, (_, c) => c).filter((c) => s.owners[c] === undefined);
      if (free.length === 0) return { kind: 'open', cell: 0 };
      return { kind: 'open', cell: free[Math.floor(rng() * free.length)] };
    },
    forbiddenValues: () => ['سؤال المربع 5'],
  },

  describe_it: {
    content: () => [
      {
        ...base,
        id: 'q-describe',
        shape: 'open_answer',
        textAr: 'وصّف الكلمة دي لفريقك',
        answerAr: 'الأهرامات',
        aliases: ['الاهرامات', 'الهرم'],
      },
    ],
    /*
     * Both members of team A guess. One of them is the describer and gets rejected; the other
     * lands it, so the team solves first and every member banks the ceiling. Which one is the
     * describer depends on a hash, so the script covers both rather than trying to predict it.
     */
    optimalScript: (ids) =>
      ids
        .filter((_, i) => i % 2 === 0)
        .map((playerId) => ({ playerId, action: { kind: 'guess', text: 'الأهرامات' } })),
    randomAction: (rng, _step, _state, playerId) => {
      if (rng() < 0.5) return { kind: 'clue', text: `تلميح من ${playerId}` };
      return { kind: 'guess', text: ['الأهرامات', 'المتحف', 'النيل'][Math.floor(rng() * 3)] };
    },
    forbiddenValues: () => [],
  },

  odd_one_out: {
    content: () => [
      {
        ...base,
        id: 'q-odd-0',
        shape: 'odd_one_out',
        textAr: 'دخيل رقم 1',
        items: ['قاهرة', 'إسكندرية', 'باريس', 'أسوان'],
        oddIndex: 2,
        reasonAr: 'التلاتة التانيين مدن مصرية',
      },
      {
        ...base,
        id: 'q-odd-1',
        shape: 'odd_one_out',
        textAr: 'دخيل رقم 2',
        items: ['تفاح', 'موز', 'جزر', 'برتقال'],
        oddIndex: 2,
        reasonAr: 'التلاتة التانيين فاكهة',
      },
      {
        ...base,
        id: 'q-odd-2',
        shape: 'odd_one_out',
        textAr: 'دخيل رقم 3',
        items: ['أسد', 'نمر', 'حصان', 'فهد'],
        oddIndex: 2,
        reasonAr: 'التلاتة التانيين من فصيلة القطط',
      },
    ],
    optimalScript: (ids) => [
      { playerId: ids[0]!, action: { kind: 'answer', index: 0, choice: 2 } },
      { playerId: ids[0]!, action: { kind: 'answer', index: 1, choice: 2 } },
      { playerId: ids[0]!, action: { kind: 'answer', index: 2, choice: 2 } },
    ],
    randomAction: (rng, step) => ({
      kind: 'answer',
      index: step % 3,
      choice: Math.floor(rng() * 4),
    }),
    forbiddenValues: () => [],
  },

  emoji_rush: {
    content: () => [
      { ...base, id: 'q-emoji-0', shape: 'emoji', emojis: '🦁👑', answerAr: 'الأسد الملك', aliases: ['اسد الملك'] },
      { ...base, id: 'q-emoji-1', shape: 'emoji', emojis: '🐍🍎', answerAr: 'حواء وآدم', aliases: [] },
      { ...base, id: 'q-emoji-2', shape: 'emoji', emojis: '⚽🐐', answerAr: 'ميسي', aliases: [] },
      { ...base, id: 'q-emoji-3', shape: 'emoji', emojis: '🌙⭐', answerAr: 'القمر والنجمة', aliases: [] },
      { ...base, id: 'q-emoji-4', shape: 'emoji', emojis: '🕌🏛️', answerAr: 'الجامع الأزهر', aliases: [] },
    ],
    optimalScript: (ids) =>
      ['الأسد الملك', 'حواء وآدم', 'ميسي', 'القمر والنجمة', 'الجامع الأزهر'].map((text) => ({
        playerId: ids[0]!,
        action: { kind: 'submit', text },
      })),
    randomAction: (rng, _step, state, playerId) => {
      const s = state as { items: Array<{ answerAr: string }>; cursor: Record<string, number> };
      const cursor = s.cursor[playerId] ?? 0;
      const item = s.items[cursor];
      if (item && rng() < 0.4) return { kind: 'submit', text: item.answerAr };
      return { kind: 'submit', text: `تخمين${Math.floor(rng() * 1000)}` };
    },
    forbiddenValues: () => ['الأسد الملك', 'حواء وآدم', 'ميسي', 'القمر والنجمة', 'الجامع الأزهر'],
  },

  ladder: {
    content: () =>
      Array.from({ length: 5 }, (_, i) => ({
        ...base,
        id: `q-ladder-${i}`,
        shape: 'mcq' as const,
        textAr: `درجة السلّم رقم ${i + 1}`,
        options: ['أ', 'ب', 'ج', 'د'],
        correctIndex: i % 4,
      })),
    // Five correct answers in a row climbs to the top, which locks itself — no explicit lock
    // action needed.
    optimalScript: (ids) =>
      Array.from({ length: 5 }, (_, i) => ({
        playerId: ids[0]!,
        action: { kind: 'answer', choice: i % 4 },
      })),
    randomAction: (rng, _step, state, playerId) => {
      const s = state as { busted: Record<string, boolean>; locked: Record<string, boolean> };
      if (s.busted[playerId] || s.locked[playerId]) return { kind: 'lock' };
      if (rng() < 0.15) return { kind: 'lock' };
      return { kind: 'answer', choice: Math.floor(rng() * 4) };
    },
    forbiddenValues: () => [],
  },

  higher_lower: {
    content: () => HIGHER_LOWER_CONTENT,
    optimalScript: (ids) => {
      const pairs = pairForHigherLower(HIGHER_LOWER_CONTENT as NumericContent[]);
      return pairs.map((pair, i) => ({
        playerId: ids[0]!,
        action: { kind: 'choose', index: i, side: pair[0].correctValue > pair[1].correctValue ? 'a' : 'b' },
      }));
    },
    randomAction: (rng, _step, state, playerId) => {
      const s = state as { cursor: Record<string, number> };
      const index = s.cursor[playerId] ?? 0;
      return { kind: 'choose', index, side: rng() < 0.5 ? 'a' : 'b' };
    },
    forbiddenValues: () => [],
  },

  relay: {
    content: () => RELAY_CONTENT,
    // Team A's two members alternate turns, each getting the same correctIndex every time —
    // four for four is the only way to reach the top rung, and the script covers exactly that.
    optimalScript: (ids) => {
      const teamAOrder = [ids[0]!, ids[2]!];
      return Array.from({ length: 4 }, (_, i) => ({
        playerId: teamAOrder[i % 2]!,
        action: { kind: 'answer', choice: 2 },
      }));
    },
    randomAction: (rng) => ({ kind: 'answer', choice: Math.floor(rng() * 4) }),
    forbiddenValues: () => [],
  },

  word_race: {
    content: () => WORD_RACE_CONTENT,
    // Nobody else writes anything, so player one's four words are trivially unrejected and
    // trivially unique — the only route to the ceiling that does not depend on guessing what a
    // hash-picked letter will be, since the content only offers one letter to pick anyway.
    optimalScript: (ids) => [
      { playerId: ids[0]!, action: { kind: 'write', field: 0, text: 'محمد' } },
      { playerId: ids[0]!, action: { kind: 'write', field: 1, text: 'ماعز' } },
      { playerId: ids[0]!, action: { kind: 'write', field: 2, text: 'مكتب' } },
      { playerId: ids[0]!, action: { kind: 'write', field: 3, text: 'مصر' } },
    ],
    randomAction: (rng, step, state, playerId) => {
      const s = state as { stage: string; playerIds: string[] };
      if (s.stage === 'writing') {
        return { kind: 'write', field: step % 4, text: `كلمة${Math.floor(rng() * 1000)}` };
      }
      if (rng() < 0.5) return { kind: 'ready' };
      const others = s.playerIds.filter((id) => id !== playerId);
      const authorId = others[Math.floor(rng() * others.length)] ?? playerId;
      return { kind: 'reject', authorId, field: Math.floor(rng() * 4) };
    },
    forbiddenValues: () => ['محمد', 'ماعز', 'مكتب', 'مصر'],
  },
};

/** Mirrors the deterministic shuffle inside the ordering round so tests can predict the board. */
function stableHashForTests(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function assertEveryTypeHasADriver(): string[] {
  return ROUND_TYPES.filter((t) => !DRIVERS[t.id]).map((t) => t.id);
}

export function makePlayers(count: number): PlayerRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`,
    nickname: `لاعب ${i + 1}`,
    connected: true,
    // Alternating sides, so cooperative types have a real team structure to work with. Every
    // other round type ignores this field entirely.
    teamId: i % 2 === 0 ? 'team-a' : 'team-b',
  }));
}

export function initFor(type: AnyRoundType, players: PlayerRef[]) {
  return { players, startedAtMs: START_MS, endsAtMs: START_MS + type.durationMs };
}

/**
 * Runs a driver's optimal script, resolving the placeholder that stands for "the lie player one
 * wrote" once the options actually exist.
 */
export function runOptimalScript(
  type: AnyRoundType,
  content: ContentItem[],
  players: PlayerRef[],
  atMs = START_MS,
): unknown {
  const driver = DRIVERS[type.id]!;
  const ids = players.map((p) => p.id);
  let state = type.createState(content, initFor(type, players));

  for (const scripted of driver.optimalScript(ids)) {
    let action = scripted.action;

    const placeholder = (action as { optionId?: string })?.optionId === '__lie_of_player_0__';
    if (placeholder) {
      const options = (state as { options?: Array<{ id: string; authorIds: string[] }> }).options ?? [];
      const mine = options.find((o) => o.authorIds.includes(ids[0]!));
      if (!mine) continue;
      action = { ...(action as object), optionId: mine.id };
    }

    state = type.reduce(state, action, { playerId: scripted.playerId, nowMs: atMs }).state;
  }

  while (!type.isFinished(state)) {
    const before = JSON.stringify(state);
    state = type.onDeadline(state, { nowMs: START_MS + type.durationMs }).state;
    if (JSON.stringify(state) === before) break;
  }
  return state;
}

/** Deterministic PRNG so a failing random simulation can be reproduced from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
