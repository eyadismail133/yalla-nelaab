import { GameClient } from './client.js';
import { createGameTransport as createFirebaseTransport } from './firebase-entry.js';
import type { CreateGameTransportOptions, GameTransport } from './transport-config.js';

export * from './transport-config.js';
export { FirebaseTransport, type FirebaseTransportOptions } from './firebase-transport.js';

/** Explicit transport factory for tests and callers that choose a mode at runtime. */
export function createGameTransport(options: CreateGameTransportOptions = {}): GameTransport {
  const envTransport = (import.meta.env?.VITE_GAME_TRANSPORT ?? '').toLowerCase();
  const mode = options.transport ?? (envTransport === 'firebase' ? 'firebase' : 'socket');
  return mode === 'firebase' ? createFirebaseTransport(options) : new GameClient();
}
