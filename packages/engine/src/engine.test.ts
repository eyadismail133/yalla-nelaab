import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  MatchEngine,
  EngineError,
  DEFAULT_OPTIONS,
  MemoryStore,
  RoomNotFoundError,
  VersionConflictError,
  generateCode,
  normalizeCode,
  CODE_LENGTH,
  toView,
} from './index.js';
import { JsonSource } from '../../../apps/server/src/content/json-source.js';

const SEED_DIR = fileURLToPath(new URL('../../../content/seed', import.meta.url));
const content = new JsonSource(SEED_DIR);

describe('@game/engine package exports and behavioral parity', () => {
  it('exports all required room engine symbols', () => {
    expect(MatchEngine).toBeDefined();
    expect(EngineError).toBeDefined();
    expect(DEFAULT_OPTIONS).toBeDefined();
    expect(MemoryStore).toBeDefined();
    expect(RoomNotFoundError).toBeDefined();
    expect(VersionConflictError).toBeDefined();
    expect(generateCode).toBeDefined();
    expect(normalizeCode).toBeDefined();
    expect(CODE_LENGTH).toBe(5);
    expect(toView).toBeDefined();
  });

  it('creates a room, joins players, starts a match, and projects views without Node dependencies', async () => {
    const store = new MemoryStore();
    const engine = new MatchEngine(store, content);

    const { state: created, playerId: hostId } = await engine.createRoom('يوسف', {
      roundCount: 5,
      format: 'focused',
      roundTypeId: 'mcq_race',
    });
    expect(created.code).toHaveLength(CODE_LENGTH);

    const { state: joined, playerId: guestId } = await engine.join(
      normalizeCode(` ${created.code.toLowerCase()} `),
      'أحمد',
    );
    expect(joined.players).toHaveLength(2);

    const started = await engine.start(created.code, hostId);
    expect(started.phase).toBe('round_intro');

    const categories = await content.categories();
    const view = toView(started, guestId, categories);
    expect(view.you.id).toBe(guestId);
    expect(view.you.isHost).toBe(false);
    expect(view.round?.view).toBeNull();
  });
});
