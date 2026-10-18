import {
  type FirebaseApp,
  getApp,
  getApps,
  initializeApp,
  deleteApp,
} from 'firebase/app';
import {
  type Auth,
  type User,
  browserSessionPersistence,
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  signInAnonymously,
} from 'firebase/auth';
import {
  type Database,
  connectDatabaseEmulator,
  getDatabase,
  onValue,
  ref,
  type Unsubscribe,
} from 'firebase/database';
import type { FirebaseWebConfig } from './transport.js';

export interface FirebaseSessionOptions {
  config: FirebaseWebConfig;
  seatId: string;
  databaseEmulatorHost?: string;
  authEmulatorHost?: string;
}

export interface AuthContext {
  uid: string;
  user: User;
  app: FirebaseApp;
  auth: Auth;
  database: Database;
}

const appRefCounts = new Map<string, number>();

/**
 * Manages Firebase app initialization, anonymous authentication, emulator routing,
 * and server time offset tracking scoped to a specific tab seat.
 */
export class FirebaseSessionManager {
  readonly seatId: string;
  readonly config: FirebaseWebConfig;
  private readonly appName: string;
  private readonly dbEmulatorHost?: string;
  private readonly authEmulatorHost?: string;

  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;
  private db: Database | null = null;
  private authPromise: Promise<AuthContext> | null = null;
  private appRefCounted = false;

  private clockOffsetMs = 0;
  private isConnected = false;
  private offsetUnsub: Unsubscribe | null = null;
  private connectedUnsub: Unsubscribe | null = null;
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private disposed = false;

  constructor(options: FirebaseSessionOptions) {
    this.seatId = options.seatId;
    this.config = options.config;
    this.appName = `[seat-${this.seatId}]`;

    // Support explicit emulator host or process.env (for tests and dev)
    const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
    this.dbEmulatorHost = options.databaseEmulatorHost ?? env.FIREBASE_DATABASE_EMULATOR_HOST;
    this.authEmulatorHost = options.authEmulatorHost ?? env.FIREBASE_AUTH_EMULATOR_HOST;
  }

  getAppName(): string {
    return this.appName;
  }

  getClockOffsetMs(): number {
    return this.clockOffsetMs;
  }

  serverNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connectionListeners.add(handler);
    handler(this.isConnected);
    return () => {
      this.connectionListeners.delete(handler);
    };
  }

  private async releaseApp(appToRelease: FirebaseApp): Promise<void> {
    if (!this.appRefCounted) return;
    this.appRefCounted = false;
    const count = (appRefCounts.get(this.appName) ?? 1) - 1;
    if (count <= 0) {
      appRefCounts.delete(this.appName);
      try {
        await deleteApp(appToRelease);
      } catch {
        // Ignore app deletion errors during teardown
      }
    } else {
      appRefCounts.set(this.appName, count);
    }
  }

  /**
   * Initializes the Firebase App, Auth, and Database, and signs in anonymously.
   * Caches the in-flight promise to avoid redundant auth operations in React StrictMode.
   */
  async ensureAuth(): Promise<AuthContext> {
    if (this.disposed) {
      throw new Error('FirebaseSessionManager is disposed');
    }

    if (this.authPromise) {
      return this.authPromise;
    }

    this.authPromise = (async () => {
      // 1. Initialize or retrieve named Firebase App
      const existingApp = getApps().find((a) => a.name === this.appName);
      const app =
        existingApp ??
        initializeApp(
          {
            apiKey: this.config.apiKey,
            authDomain: this.config.authDomain,
            databaseURL: this.config.databaseURL,
            projectId: this.config.projectId,
            appId: this.config.appId,
          },
          this.appName,
        );
      this.app = app;

      if (!this.appRefCounted) {
        this.appRefCounted = true;
        appRefCounts.set(this.appName, (appRefCounts.get(this.appName) ?? 0) + 1);
      }

      if (this.disposed) {
        await this.releaseApp(app);
        throw new Error('FirebaseSessionManager is disposed');
      }

      // 2. Initialize Auth
      const auth = getAuth(app);
      this.auth = auth;
      if (this.authEmulatorHost) {
        const [host, port] = this.authEmulatorHost.split(':');
        try {
          connectAuthEmulator(auth, `http://${host || '127.0.0.1'}:${port || '9099'}`, {
            disableWarnings: true,
          });
        } catch {
          // Already connected
        }
      }

      // Each named app is scoped to its seat, so persistence survives a closed tab without
      // merging the anonymous identities of different players in the same browser.
      try {
        if (typeof window !== 'undefined') {
          try {
            await setPersistence(auth, browserLocalPersistence);
          } catch {
            await setPersistence(auth, browserSessionPersistence);
          }
        }
      } catch {
        // Persistence not supported in some test/node environments; continue with default
      }

      if (this.disposed) {
        await this.releaseApp(app);
        throw new Error('FirebaseSessionManager is disposed');
      }

      // Sign in anonymously if not already signed in
      let user = auth.currentUser;
      if (!user) {
        const userCred = await signInAnonymously(auth);
        user = userCred.user;
      }

      if (this.disposed) {
        await this.releaseApp(app);
        throw new Error('FirebaseSessionManager is disposed');
      }

      // 3. Initialize Database
      const db = getDatabase(app);
      this.db = db;
      if (this.dbEmulatorHost) {
        const [host, portStr] = this.dbEmulatorHost.split(':');
        try {
          connectDatabaseEmulator(db, host || '127.0.0.1', Number(portStr || 9000));
        } catch {
          // Already connected
        }
      }

      if (this.disposed) {
        await this.releaseApp(app);
        throw new Error('FirebaseSessionManager is disposed');
      }

      // 4. Attach .info listeners for server time offset and connection
      this.startInfoListeners(db);

      return {
        uid: user.uid,
        user,
        app,
        auth,
        database: db,
      };
    })().catch(async (err) => {
      this.authPromise = null;
      if (this.disposed) {
        if (this.app) {
          await this.releaseApp(this.app);
          this.app = null;
          this.auth = null;
          this.db = null;
        }
        throw new Error('FirebaseSessionManager is disposed');
      }
      throw err;
    });

    return this.authPromise;
  }

  private startInfoListeners(db: Database): void {
    if (this.disposed || this.offsetUnsub || this.connectedUnsub) return;

    const offsetRef = ref(db, '.info/serverTimeOffset');
    this.offsetUnsub = onValue(
      offsetRef,
      (snap) => {
        if (this.disposed) return;
        const val = snap.val();
        if (typeof val === 'number') {
          this.clockOffsetMs = val;
        }
      },
      () => {},
    );

    const connectedRef = ref(db, '.info/connected');
    this.connectedUnsub = onValue(
      connectedRef,
      (snap) => {
        if (this.disposed) return;
        const val = Boolean(snap.val());
        this.isConnected = val;
        for (const listener of this.connectionListeners) {
          try {
            listener(val);
          } catch {
            // Ignore listener error
          }
        }
      },
      () => {},
    );
  }

  async syncClock(): Promise<number> {
    try {
      const { database } = await this.ensureAuth();
      const offsetRef = ref(database, '.info/serverTimeOffset');
      return new Promise<number>((resolve) => {
        onValue(
          offsetRef,
          (snap) => {
            const val = snap.val();
            if (typeof val === 'number') {
              this.clockOffsetMs = val;
            }
            resolve(this.clockOffsetMs);
          },
          () => {
            resolve(this.clockOffsetMs);
          },
          { onlyOnce: true },
        );
      });
    } catch {
      return this.clockOffsetMs;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.offsetUnsub) {
      this.offsetUnsub();
      this.offsetUnsub = null;
    }
    if (this.connectedUnsub) {
      this.connectedUnsub();
      this.connectedUnsub = null;
    }
    this.connectionListeners.clear();

    if (this.app) {
      const appToDelete = this.app;
      this.app = null;
      this.auth = null;
      this.db = null;
      this.authPromise = null;

      await this.releaseApp(appToDelete);
    }
  }
}
