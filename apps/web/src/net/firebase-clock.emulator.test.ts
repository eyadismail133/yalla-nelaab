import { expect, it } from 'vitest';
import { FirebaseSessionManager } from './firebase-session.js';

it('synchronizes repeatedly when the info value is already cached', async () => {
  const session = new FirebaseSessionManager({
    seatId: 'seat-clock-regression',
    config: {
      apiKey: 'fake-api-key-demo', authDomain: 'demo-yalla-nelaab.firebaseapp.com',
      databaseURL: 'http://127.0.0.1:9000?ns=demo-yalla-nelaab', projectId: 'demo-yalla-nelaab',
      appId: '1:123456789:web:abcdef123456',
    },
    databaseEmulatorHost: process.env.FIREBASE_DATABASE_EMULATOR_HOST ?? '127.0.0.1:9000',
    authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
  });
  try {
    await session.ensureAuth();
    expect(Number.isFinite(await session.syncClock())).toBe(true);
    expect(Number.isFinite(await session.syncClock())).toBe(true);
  } finally { session.dispose(); }
});
