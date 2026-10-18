import { GameClient } from './client.js';

export function createGameTransport() {
  return new GameClient();
}
