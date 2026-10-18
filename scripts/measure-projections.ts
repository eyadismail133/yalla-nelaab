import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MatchEngine, MemoryStore, toView } from '@game/engine';
import { ROUND_TYPES } from '@game/rounds';
import type { RoomState } from '@game/shared';
import { JsonSource } from '../apps/server/src/content/json-source.js';
import { DRIVERS, initFor, makePlayers, START_MS } from '../packages/rounds/src/test-drivers.js';
import { mergeSplitView, splitViewUpdates, type ProjectionRecord } from '../apps/web/src/net/split-view.js';

const source = new JsonSource(fileURLToPath(new URL('../content/seed', import.meta.url)));
const categories = await source.categories();
const engine = new MatchEngine(new MemoryStore(), source);
const base = (await engine.createRoom('benchmark')).state;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function measure(state: RoomState) {
  const full = Object.fromEntries(state.players.map((player, index) => [`views/uid-${index}`, {
    slot: String(index + 1), json: JSON.stringify(toView(state, player.id, categories, START_MS)),
    version: state.version, updatedAtMs: START_MS, leaseOwnerId: 'benchmark-runtime',
  }]));
  const split = splitViewUpdates(full);
  const shared = split.publicView as ProjectionRecord;
  assert(!Object.hasOwn(JSON.parse(shared.json), 'you'));
  for (const [index, original] of Object.values(full).entries()) {
    assert.deepEqual(mergeSplitView(shared, split[`privateViews/uid-${index}`] as ProjectionRecord), JSON.parse(original.json));
  }
  return { fullProjectionBytes: bytes(full), splitProjectionBytes: bytes(split), publicBytes: bytes(shared),
    privateBytes: bytes(Object.fromEntries(Object.entries(split).filter(([key]) => key.startsWith('privateViews/')))) };
}

const rows: object[] = [];
for (const type of ROUND_TYPES) {
  for (const count of [2, 4, 8]) {
    if (count < type.minPlayers) {
      rows.push({ type: type.id, players: count, unsupported: `requires ${type.minPlayers} players` });
      continue;
    }
    const players = makePlayers(count);
    const state: RoomState = { ...base, code: 'ABCDE', hostId: players[0]!.id,
      players: players.map((player) => ({ ...player, token: 'benchmark-only', joinedAtMs: START_MS, disconnectedAtMs: null, leftEarly: false })),
      config: { ...base.config, teams: type.requiresTeams }, phase: 'in_round', phaseEndsAtMs: START_MS + type.durationMs,
      roundTypeId: type.id, roundNo: 1, roundIndex: 0, playlist: [{ roundTypeId: type.id, weight: 1 }],
      roundState: type.createState(DRIVERS[type.id]!.content(), initFor(type, players)),
    };
    rows.push({ type: type.id, players: count, stage: 'initial', ...measure(state) });
    const action = DRIVERS[type.id]!.optimalScript(players.map((player) => player.id))[0];
    if (action) {
      state.roundState = type.reduce(state.roundState, action.action, { playerId: action.playerId, nowMs: START_MS + 500 }).state;
      rows.push({ type: type.id, players: count, stage: 'first-action', ...measure(state) });
    }
    const owner = players[0]!.id;
    state.matchCards = { [owner]: { doubleRoundNo: 1 } };
    rows.push({ type: type.id, players: count, stage: 'with-captain', ...measure(state) });
    const item = DRIVERS[type.id]!.content()[0]!;
    if (type.id === 'mcq_race' && item.shape === 'mcq') {
      state.matchCards[owner] = { doubleRoundNo: 1, varRoundNo: 1, varHint: {
        hiddenOptions: [0, 1, 2, 3].filter((index) => index !== item.correctIndex).slice(0, 2),
      } };
      rows.push({ type: type.id, players: count, stage: 'with-var', ...measure(state) });
    } else if (type.id === 'numeric_guess' && item.shape === 'numeric') {
      state.matchCards[owner] = { doubleRoundNo: 1, varRoundNo: 1, varHint: { range: [item.correctValue - 100, item.correctValue + 100] } };
      rows.push({ type: type.id, players: count, stage: 'with-var', ...measure(state) });
    }
    if (count < 8) {
      state.players.push({ ...state.players[0]!, id: 'spectator', nickname: 'spectator', spectator: true });
      rows.push({ type: type.id, players: count, stage: 'with-spectator', ...measure(state) });
    }
  }
}
console.log(JSON.stringify({
  scope: 'Deterministic synthetic reducer fixtures through real toView/split/merge. UTF-8 JSON projection update payload only; excludes canonical snapshots, commands, ACKs, protocol overhead and actual network billing. Not bytes-per-action on a live room.',
  rows,
}, null, 2));
