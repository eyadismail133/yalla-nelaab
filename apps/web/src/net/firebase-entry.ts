import { FirebaseTransport } from './firebase-transport.js';
import { resolveFirebaseConfig, type CreateGameTransportOptions } from './transport-config.js';

/** Selected at build time so the Firebase release never imports the Socket.IO client. */
export function createGameTransport(options: CreateGameTransportOptions = {}) {
  const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
  return new FirebaseTransport({
    ...options.firebaseOptions,
    config: resolveFirebaseConfig(options.firebaseConfig),
    seatId: options.seatId,
    contentSource: options.contentSource,
    databaseEmulatorHost: options.firebaseOptions?.databaseEmulatorHost ?? env.VITE_FIREBASE_DATABASE_EMULATOR_HOST,
    authEmulatorHost: options.firebaseOptions?.authEmulatorHost ?? env.VITE_FIREBASE_AUTH_EMULATOR_HOST,
  });
}
