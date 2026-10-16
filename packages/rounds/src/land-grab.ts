import {
  type ActionCtx,
  type ContentItem,
  type McqContent,
  type PlayerId,
  type RoundInit,
  type RoundScore,
  type RoundType,
  type StepResult,
} from '@game/shared';

/** The 3×3 board, and the default when nothing says otherwise. */
export const GRID_SIZE = 9;
/** The 4×4 board, used once the room is too big for nine squares to go round. */
export const BIG_GRID_SIZE = 16;
/**
 * Above this many players the map grows.
 *
 * Nine squares between eight people is one square each: the board is gone in twenty seconds,
 * a line is arithmetically out of reach for everybody, and the round decides nothing except
 * who has the fastest thumb. Sixteen squares restores roughly the two-each density the round
 * was tuned at, at the cost of eating more of the question bank — which is the right trade,
 * because a round that scores everybody 20 points is not worth the questions it already spent.
 */
const BIG_GRID_ABOVE_PLAYERS = 5;

export const gridSizeFor = (playerCount: number): number =>
  playerCount > BIG_GRID_ABOVE_PLAYERS ? BIG_GRID_SIZE : GRID_SIZE;

const TERRITORY_POINTS = 180;
const LINE_BONUS = 20;

/**
 * Every full row, column and diagonal on a square board of this many cells.
 *
 * Derived rather than listed because the board is no longer one fixed size — and a hardcoded
 * 3×3 table silently awards nothing on the 4×4 board instead of failing loudly.
 */
function linesForBoard(size: number): ReadonlyArray<readonly number[]> {
  const side = Math.round(Math.sqrt(size));
  const rows = Array.from({ length: side }, (_, r) =>
    Array.from({ length: side }, (_, c) => r * side + c),
  );
  const columns = Array.from({ length: side }, (_, c) =>
    Array.from({ length: side }, (_, r) => r * side + c),
  );
  const down = Array.from({ length: side }, (_, i) => i * side + i);
  const up = Array.from({ length: side }, (_, i) => i * side + (side - 1 - i));
  return [...rows, ...columns, down, up];
}

export interface LandGrabState {
  items: McqContent[];
  playerIds: PlayerId[];
  startedAtMs: number;
  endsAtMs: number;
  /** Cell index → who claimed it. Undefined means still open. */
  owners: Record<number, PlayerId>;
  /** Which cell each player currently has open, if any. */
  attempting: Record<PlayerId, number | null>;
  /** Cells a player already failed, so they cannot grind the same one. */
  failed: Record<PlayerId, number[]>;
  lastActionAtMs: Record<PlayerId, number>;
  closed: boolean;
}

export type LandGrabAction =
  | { kind: 'open'; cell: number }
  | { kind: 'answer'; cell: number; choice: number };

const noChange = (state: LandGrabState): StepResult<LandGrabState> => ({ state, events: [] });

const cellsOf = (state: LandGrabState, playerId: PlayerId): number[] =>
  Object.entries(state.owners)
    .filter(([, owner]) => owner === playerId)
    .map(([cell]) => Number(cell));

function linesFor(cells: number[], boardSize: number): number {
  const owned = new Set(cells);
  return linesForBoard(boardSize).filter((line) => line.every((cell) => owned.has(cell))).length;
}

/**
 * قطع الأرض — a square board where every cell is a question, and everyone races for territory.
 * 3×3 up to five players, 4×4 above that, so the squares-per-person density holds as the room
 * grows.
 *
 * This replaces the turn-based XO that was originally planned. Taking turns works beautifully
 * with two players and falls apart with eight: seven people watch one person think, which is the
 * exact failure the mixed playlist exists to avoid. Racing for squares keeps the board-game
 * feel — you can see the map filling up, you can block someone off a line — while every player
 * stays busy the whole round.
 *
 * Scoring is territory first (180 spread across however many squares there are) with a small
 * bonus for a line, so a player who grabs ground steadily still beats one who lucks into a row.
 */
export const landGrab: RoundType<LandGrabState, LandGrabAction> = {
  id: 'land_grab',
  nameAr: 'قطع الأرض',
  taglineAr: 'كل مربع فيه سؤال — جاوب صح تاخد المربع، واللي ياخد أكتر أرض يكسب',
  scoringHintAr: 'كل مربع بينقّطك، وخط كامل بيديك بونص',
  contentShapes: ['mcq'],
  itemsPerRound: GRID_SIZE,
  itemsFor: (playerCount) => gridSizeFor(playerCount),
  pacing: 'fast',
  long: true,
  minPlayers: 2,
  requiresTeams: false,
  // Long enough for the bigger board to actually fill; a small board closes itself the moment
  // the last square is claimed, so nobody sits and waits out the difference.
  durationMs: 70_000,
  /** Nine or sixteen questions all revealed at once. */
  revealWeight: 1.5,
  accent: 'emerald',
  supportsSuddenDeath: false,

  createState(content: ContentItem[], init: RoundInit): LandGrabState {
    const items = content.filter((c): c is McqContent => c.shape === 'mcq');
    const playerIds = init.players.map((p) => p.id);
    // The board is whatever the engine handed over, not a constant — it asked for a size via
    // `itemsFor`, and trusting the content keeps sudden-death and rematch paths honest.
    const side = Math.round(Math.sqrt(items.length));
    if (items.length < GRID_SIZE || side * side !== items.length) {
      throw new Error(`land_grab requires a square board of at least ${GRID_SIZE} mcq items`);
    }

    return {
      items,
      playerIds,
      startedAtMs: init.startedAtMs,
      endsAtMs: init.endsAtMs,
      owners: {},
      attempting: Object.fromEntries(playerIds.map((id) => [id, null])),
      failed: Object.fromEntries(playerIds.map((id) => [id, []])),
      lastActionAtMs: {},
      closed: false,
    };
  },

  reduce(state, action, ctx): StepResult<LandGrabState> {
    if (state.closed || ctx.nowMs > state.endsAtMs) return noChange(state);
    if (!state.playerIds.includes(ctx.playerId)) return noChange(state);

    if (action.kind === 'open') {
      if (!Number.isInteger(action.cell) || action.cell < 0 || action.cell >= state.items.length) {
        return noChange(state);
      }
      if (state.owners[action.cell] !== undefined) return noChange(state);
      if ((state.failed[ctx.playerId] ?? []).includes(action.cell)) return noChange(state);
      if (state.attempting[ctx.playerId] !== null) return noChange(state);

      return {
        state: { ...state, attempting: { ...state.attempting, [ctx.playerId]: action.cell } },
        events: [],
      };
    }

    if (action.kind === 'answer') {
      // Only the cell this player actually opened is answerable.
      if (state.attempting[ctx.playerId] !== action.cell) return noChange(state);
      if (state.owners[action.cell] !== undefined) {
        // Somebody else took it while this player was reading. Release without penalty — losing
        // a square to a faster player is the game; being punished for it is not.
        return {
          state: { ...state, attempting: { ...state.attempting, [ctx.playerId]: null } },
          events: [],
        };
      }
      if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice > 3) {
        return noChange(state);
      }

      const item = state.items[action.cell]!;
      const correct = action.choice === item.correctIndex;

      const next: LandGrabState = {
        ...state,
        attempting: { ...state.attempting, [ctx.playerId]: null },
        lastActionAtMs: { ...state.lastActionAtMs, [ctx.playerId]: ctx.nowMs },
      };

      if (correct) {
        next.owners = { ...state.owners, [action.cell]: ctx.playerId };
      } else {
        next.failed = {
          ...state.failed,
          [ctx.playerId]: [...(state.failed[ctx.playerId] ?? []), action.cell],
        };
      }

      const boardFull = Object.keys(next.owners).length >= next.items.length;
      // Also over when nobody has a legal move left.
      const stuck = next.playerIds.every((id) =>
        Array.from({ length: next.items.length }, (_, cell) => cell).every(
          (cell) => next.owners[cell] !== undefined || (next.failed[id] ?? []).includes(cell),
        ),
      );
      next.closed = boardFull || stuck;

      const events: StepResult<LandGrabState>['events'] = correct
        ? [{ type: 'player_locked', playerId: ctx.playerId }]
        : [];
      if (next.closed) events.push({ type: 'all_locked' });
      return { state: next, events };
    }

    return noChange(state);
  },

  onDeadline(state): StepResult<LandGrabState> {
    if (state.closed) return noChange(state);
    return { state: { ...state, closed: true }, events: [] };
  },

  view(state, playerId) {
    const open = state.attempting[playerId];
    const current = open === null || open === undefined ? null : state.items[open];

    return {
      // The board's ownership is public — watching the map fill up is the point. What stays
      // hidden is every question the player has not opened.
      board: Array.from({ length: state.items.length }, (_, cell) => ({
        cell,
        ownerId: state.owners[cell] ?? null,
        failedByMe: (state.failed[playerId] ?? []).includes(cell),
      })),
      openCell:
        current && open !== null && open !== undefined
          ? { cell: open, textAr: current.textAr, options: current.options }
          : null,
      myCells: cellsOf(state, playerId).length,
      totalCells: state.items.length,
    };
  },

  reveal(state) {
    return {
      board: Array.from({ length: state.items.length }, (_, cell) => ({
        cell,
        ownerId: state.owners[cell] ?? null,
        textAr: state.items[cell]!.textAr,
        answerAr: state.items[cell]!.options[state.items[cell]!.correctIndex],
      })),
      lines: state.playerIds.map((playerId) => ({
        playerId,
        cells: cellsOf(state, playerId).length,
        lines: linesFor(cellsOf(state, playerId), state.items.length),
      })),
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
      const cells = cellsOf(state, playerId);
      const lines = linesFor(cells, state.items.length);
      const lastAt = state.lastActionAtMs[playerId];

      // Territory scales with the board so the ceiling holds no matter how the squares split.
      const territory = Math.round((TERRITORY_POINTS * cells.length) / state.items.length);
      const bonus = Math.min(LINE_BONUS, lines * LINE_BONUS);

      return {
        playerId,
        points: territory + bonus,
        isCorrect: lines > 0,
        msTaken:
          cells.length === 0 || lastAt === undefined
            ? null
            : Math.max(0, lastAt - state.startedAtMs),
      };
    });
  },
};
