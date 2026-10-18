import type {
  AckResult,
  ContentSource,
  RoomView,
} from '@game/shared';
import {
  type Database,
  get,
  onDisconnect,
  onValue,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  type Unsubscribe,
} from 'firebase/database';
import { BrowserContentSource } from '../content/browser-source.js';
import { clearSession, saveSession } from './session.js';
import type { FirebaseHostRuntime } from './firebase-host-runtime.js';
import {
  type AuthContext,
  FirebaseSessionManager,
  type FirebaseSessionOptions,
} from './firebase-session.js';
import { TabSeatManager } from './seat.js';
import { ClientSequencer, parseCommandId } from './sequence.js';
import { OfflineActionQueue } from './offline-action.js';
import { measureDatabaseLatency } from './database-latency.js';
import { LEASE_TTL_MS } from './firebase-lease.js';
import { mergeSplitView, type ProjectionRecord } from './split-view.js';
import {
  type FirebaseWebConfig,
  type GameTransport,
  resolveFirebaseConfig,
  validateFirebaseConfig,
} from './transport-config.js';

export interface FirebaseTransportOptions {
  config?: Partial<FirebaseWebConfig>;
  seatId?: string;
  contentSource?: ContentSource;
  storage?: Storage | null;
  channel?: BroadcastChannel | null;
  databaseEmulatorHost?: string;
  authEmulatorHost?: string;
  onClonedDetected?: () => void;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  hostTakeoverGraceMs?: number;
}

function defaultSessionStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore restricted environment storage errors
  }
  return null;
}

const COMMAND_TIMEOUT_MS = 10_000;
const HOST_UNRESPONSIVE_THRESHOLD_MS = 15_000;
const HOST_DEAD_THRESHOLD_MS = 60_000;
const DEFAULT_HOST_TAKEOVER_GRACE_MS = 3_500;

interface RoomAttachment {
  readonly id: number;
  readonly roomId: string;
  readonly isHost: boolean;
  readonly opGen: number;
  dispose(): void;
}

class ActiveRoomAttachment implements RoomAttachment {
  disposed = false;
  viewUnsub: Unsubscribe | null = null;
  heartbeatUnsub: Unsubscribe | null = null;
  metaUnsub: Unsubscribe | null = null;
  pulseTimer: ReturnType<typeof setInterval> | null = null;
  takeoverTimer: ReturnType<typeof setTimeout> | null = null;
  presenceDisconnect: ReturnType<typeof onDisconnect> | null = null;

  constructor(
    public readonly id: number,
    public readonly roomId: string,
    public readonly isHost: boolean,
    public readonly opGen: number,
  ) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.viewUnsub) {
      try {
        this.viewUnsub();
      } catch {}
      this.viewUnsub = null;
    }
    if (this.heartbeatUnsub) {
      try {
        this.heartbeatUnsub();
      } catch {}
      this.heartbeatUnsub = null;
    }
    if (this.metaUnsub) {
      try {
        this.metaUnsub();
      } catch {}
      this.metaUnsub = null;
    }
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
    if (this.takeoverTimer) {
      clearTimeout(this.takeoverTimer);
      this.takeoverTimer = null;
    }
    if (this.presenceDisconnect) {
      void this.presenceDisconnect.cancel().catch(() => {});
      this.presenceDisconnect = null;
    }
  }
}

interface ActiveCommandHandle {
  commandId: string;
  readonly opGen: number;
  readonly roomId: string;
  readonly uid: string;
  cancel(reason: string): void;
}

export class FirebaseTransport implements GameTransport {
  readonly config: FirebaseWebConfig;
  readonly seatManager: TabSeatManager;
  readonly contentSource: ContentSource;
  private readonly options: FirebaseTransportOptions;

  private readonly storage: Storage | null;
  private readonly explicitSeatId: string | null;
  private readonly databaseEmulatorHost?: string;
  private readonly authEmulatorHost?: string;

  private sessionInstance: FirebaseSessionManager | null = null;
  private resolvedSeatId: string | null = null;
  private initPromise: Promise<{
    session: FirebaseSessionManager;
    authCtx: AuthContext;
    seatId: string;
  }> | null = null;

  private sequencer: ClientSequencer | null = null;
  private hostRuntime: FirebaseHostRuntime | null = null;

  private currentRoomId: string | null = null;
  private currentCode: string | null = null;
  private currentUid: string | null = null;
  private currentPlayerId: string | null = null;
  private currentToken: string | null = null;
  private latestRoomView: RoomView | null = null;
  private isHost = false;
  private promotionInFlight = false;
  private promotionPromise: Promise<void> | null = null;

  private isConnected = false;
  private hostUnresponsive = false;
  private lastHostSeenAtMs = 0;

  private currentAttachment: ActiveRoomAttachment | null = null;
  private currentAttachmentId = 0;
  private activeCommand: ActiveCommandHandle | null = null;
  private connectionUnsub: Unsubscribe | null = null;

  private pendingCommand = false;
  private readonly offlineActions = new OfflineActionQueue();
  private commandGeneration = 0;
  private operationGeneration = 0;
  private currentRoomExpiresAtMs = 0;
  private activeResume: {
    key: string;
    promise: Promise<AckResult<{ code: string; playerId: string }>>;
  } | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private disposed = false;

  private readonly stateListeners = new Set<(view: RoomView) => void>();
  private readonly closedListeners = new Set<(payload: { reason: string }) => void>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly hostStatusListeners = new Set<(unresponsive: boolean) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();

  constructor(options: FirebaseTransportOptions = {}) {
    this.options = options;
    this.config = resolveFirebaseConfig(options.config);
    this.storage = options.storage !== undefined ? options.storage : defaultSessionStorage();
    this.seatManager = new TabSeatManager({
      storage: this.storage,
      channel: options.channel,
      onClonedDetected: options.onClonedDetected,
    });

    this.explicitSeatId = options.seatId ?? null;
    this.contentSource = options.contentSource ?? new BrowserContentSource();
    this.databaseEmulatorHost = options.databaseEmulatorHost;
    this.authEmulatorHost = options.authEmulatorHost;

    if (this.explicitSeatId) {
      this.resolvedSeatId = this.explicitSeatId;
      this.sequencer = new ClientSequencer(this.explicitSeatId, { storage: this.storage });
    }
  }

  getHostRuntime(): FirebaseHostRuntime | null {
    return this.hostRuntime;
  }

  get session(): FirebaseSessionManager {
    if (!this.sessionInstance) {
      const fallbackSeatId = this.resolvedSeatId ?? this.seatManager.getSeatIdSync();
      this.sessionInstance = new FirebaseSessionManager({
        config: this.config,
        seatId: fallbackSeatId,
        databaseEmulatorHost: this.databaseEmulatorHost,
        authEmulatorHost: this.authEmulatorHost,
      });
    }
    return this.sessionInstance;
  }

  private async ensureSession(): Promise<{
    session: FirebaseSessionManager;
    authCtx: AuthContext;
    seatId: string;
  }> {
    if (this.disposed) {
      throw new Error('Transport is disposed');
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      // 1. Resolve seat ID before initializing SDK session identity!
      const seatId = this.explicitSeatId ?? (await this.seatManager.resolveSeatId());
      if (this.disposed) {
        throw new Error('Transport is disposed');
      }
      this.resolvedSeatId = seatId;

      if (!this.sequencer) {
        this.sequencer = new ClientSequencer(seatId, { storage: this.storage });
      }

      if (!this.sessionInstance || this.sessionInstance.seatId !== seatId) {
        if (this.connectionUnsub) {
          this.connectionUnsub();
          this.connectionUnsub = null;
        }
        if (this.sessionInstance) {
          void this.sessionInstance.dispose();
        }
        this.sessionInstance = new FirebaseSessionManager({
          config: this.config,
          seatId,
          databaseEmulatorHost: this.databaseEmulatorHost,
          authEmulatorHost: this.authEmulatorHost,
        });
      }

      if (!this.connectionUnsub && this.sessionInstance) {
        this.connectionUnsub = this.sessionInstance.onConnectionChange((connected) => {
          this.isConnected = connected;
          if (connected) queueMicrotask(() => this.flushOfflineActions());
          for (const handler of this.connectionListeners) {
            try {
              handler(connected);
            } catch {
              // Ignore
            }
          }
        });
      }

      const authCtx = await this.sessionInstance.ensureAuth();
      if (this.disposed) {
        throw new Error('Transport is disposed');
      }
      this.currentUid = authCtx.uid;
      return { session: this.sessionInstance, authCtx, seatId };
    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });

    return this.initPromise;
  }

  onState(handler: (view: RoomView) => void): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  onClosed(handler: (payload: { reason: string }) => void): () => void {
    this.closedListeners.add(handler);
    return () => {
      this.closedListeners.delete(handler);
    };
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connectionListeners.add(handler);
    handler(this.isConnected);
    return () => {
      this.connectionListeners.delete(handler);
    };
  }

  onHostStatusChange(handler: (unresponsive: boolean) => void): () => void {
    this.hostStatusListeners.add(handler);
    handler(this.hostUnresponsive);
    return () => {
      this.hostStatusListeners.delete(handler);
    };
  }

  onError(handler: (message: string) => void): () => void {
    this.errorListeners.add(handler);
    return () => {
      this.errorListeners.delete(handler);
    };
  }

  private emitError(message: string): void {
    for (const handler of this.errorListeners) {
      try {
        handler(message);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  syncClock(samples = 5): Promise<number> {
    return this.session.syncClock();
  }

  serverNow(): number {
    return this.session.serverNow();
  }

  private cancelActiveCommand(reason: string): void {
    this.commandGeneration += 1;
    if (this.activeCommand) {
      const cmd = this.activeCommand;
      this.activeCommand = null;
      cmd.cancel(reason);
    }
    this.pendingCommand = false;
  }

  async createRoom(
    nickname: string,
    config?: Record<string, unknown>,
  ): Promise<AckResult<{ code: string; playerId: string; token: string }>> {
    const configCheck = validateFirebaseConfig(this.config);
    if (!configCheck.ok) {
      const err = configCheck.error || 'إعدادات Firebase غير صالحة';
      this.emitError(err);
      return { ok: false, error: err };
    }

    const normNickname = nickname.trim().slice(0, 16);
    if (!normNickname) {
      return { ok: false, error: 'الاسم مطلوب' };
    }

    this.cancelActiveCommand('تم استبدال العملية بإنشاء غرفة جديدة');
    this.offlineActions.cancel();
    const opGen = ++this.operationGeneration;
    const startDeadlineMs = Date.now() + COMMAND_TIMEOUT_MS;

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<AckResult<{ code: string; playerId: string; token: string }>>((resolve) => {
      timeoutTimer = setTimeout(() => {
        resolve({ ok: false, error: 'انتهت مهلة إنشاء الغرفة — جرب تاني' });
      }, COMMAND_TIMEOUT_MS + 100);
    });

    let currentRuntime = null as FirebaseHostRuntime | null;

    const executionPromise = (async (): Promise<AckResult<{ code: string; playerId: string; token: string }>> => {
      try {
        const [{ session, authCtx, seatId }, { FirebaseHostRuntime }] = await Promise.all([
          this.ensureSession(), import('./firebase-host-runtime.js'),
        ]);
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة إنشاء الغرفة — جرب تاني' };
        }

        if (this.hostRuntime) {
          this.hostRuntime.dispose();
          this.hostRuntime = null;
        }

        const runtime = new FirebaseHostRuntime({
          session,
          contentSource: this.contentSource,
          leaseTtlMs: this.options.leaseTtlMs,
          heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        });
        currentRuntime = runtime;
        this.hostRuntime = runtime;

        runtime.onExecutionStopped((reason) => {
          if (!this.disposed && this.operationGeneration === opGen && this.hostRuntime === runtime) {
            this.updateHostStatus(true);
          }
        });

        const res = await runtime.createRoom(normNickname, config);
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          if (this.hostRuntime === runtime) {
            this.hostRuntime.dispose();
            this.hostRuntime = null;
          }
          return { ok: false, error: 'انتهت مهلة إنشاء الغرفة — جرب تاني' };
        }

        const attachRes = await this.attachRoomListeners(
          authCtx.database,
          res.roomId,
          authCtx.uid,
          true,
          opGen,
          startDeadlineMs,
        );
        if (!attachRes.ok || this.disposed || this.operationGeneration !== opGen) {
          if (currentRuntime && this.hostRuntime === currentRuntime) {
            currentRuntime.dispose();
            this.hostRuntime = null;
          }
          return { ok: false, error: attachRes.error || 'تم إلغاء عملية إنشاء الغرفة' };
        }

        this.currentRoomId = res.roomId;
        this.currentCode = res.code;
        this.currentPlayerId = res.playerId;
        this.currentToken = res.token;
        this.isHost = true;

        saveSession({ code: res.code, playerId: res.playerId, token: res.token });

        return {
          ok: true,
          code: res.code,
          playerId: res.playerId,
          token: res.token,
        };
      } catch (err) {
        if (currentRuntime && this.hostRuntime === currentRuntime) {
          currentRuntime.dispose();
          this.hostRuntime = null;
        }
        if (this.disposed || this.operationGeneration !== opGen) {
          return { ok: false, error: 'تم إلغاء عملية إنشاء الغرفة' };
        }
        const error = err instanceof Error ? err.message : 'فشل إنشاء الغرفة';
        this.emitError(error);
        return { ok: false, error };
      }
    })();

    try {
      const result = await Promise.race([executionPromise, timeoutPromise]);
      if (!result.ok && this.operationGeneration === opGen) {
        this.operationGeneration += 1;
        if (currentRuntime && this.hostRuntime === currentRuntime) {
          currentRuntime.dispose();
          this.hostRuntime = null;
        }
      }
      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  async joinRoom(
    code: string,
    nickname: string,
  ): Promise<AckResult<{ code: string; playerId: string; token: string }>> {
    const configCheck = validateFirebaseConfig(this.config);
    if (!configCheck.ok) {
      const err = configCheck.error || 'إعدادات Firebase غير صالحة';
      this.emitError(err);
      return { ok: false, error: err };
    }

    const normNickname = nickname.trim().slice(0, 16);
    if (!normNickname) {
      return { ok: false, error: 'الاسم مطلوب' };
    }

    this.cancelActiveCommand('تم استبدال العملية بالانضمام لغرفة');
    this.offlineActions.cancel();
    const opGen = ++this.operationGeneration;
    const startDeadlineMs = Date.now() + COMMAND_TIMEOUT_MS;

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<AckResult<{ code: string; playerId: string; token: string }>>((resolve) => {
      timeoutTimer = setTimeout(() => {
        resolve({ ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' });
      }, COMMAND_TIMEOUT_MS + 100);
    });

    const executionPromise = (async (): Promise<AckResult<{ code: string; playerId: string; token: string }>> => {
      try {
        const { session, authCtx, seatId } = await this.ensureSession();
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' };
        }
        const db = authCtx.database;

        const normCode = code.trim().toUpperCase();

        // 1. Look up room code
        const codeSnap = await get(ref(db, `codes/${normCode}`));
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' };
        }
        if (!codeSnap.exists() || !codeSnap.val().roomId) {
          return { ok: false, error: 'الكود ده مش موجود أو الغرفة مقفولة' };
        }
        const roomId = String(codeSnap.val().roomId);

        // 2. Read room meta and own member record in parallel to save 1 network round-trip
        const [metaSnap, ownMemberSnap] = await Promise.all([
          get(ref(db, `rooms/${roomId}/meta`)),
          get(ref(db, `rooms/${roomId}/members/${authCtx.uid}`)),
        ]);
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' };
        }
        if (!metaSnap.exists() || metaSnap.val().status === 'closed') {
          return { ok: false, error: 'الغرفة مقفولة' };
        }
        const meta = metaSnap.val();
        const isExistingMember = ownMemberSnap.exists() && ownMemberSnap.val()?.removed !== true;

        if (!isExistingMember) {
          if (meta.memberCount >= 8) {
            return { ok: false, error: 'الغرفة كاملة (8 لاعبين)' };
          }
          if (meta.admittedCount >= 32) {
            return { ok: false, error: 'الغرفة وصلت للحد الأقصى من اللاعبين' };
          }
        } else if (meta.phase !== 'lobby') {
          // Existing admitted member (including a former host returning as a member) attempting recovery after match started
          let recoveredCredentials: { code: string; playerId: string; token: string } | null = null;
          for (let s = 1; s <= 8; s += 1) {
            if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
              break;
            }
            try {
              const respSnap = await get(ref(db, `rooms/${roomId}/joinResponses/${s}`));
              if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
                break;
              }
              if (respSnap.exists() && respSnap.val()?.uid === authCtx.uid && respSnap.val()?.ok) {
                const parsed = JSON.parse(respSnap.val().dataJson || '{}');
                if (parsed.playerId && parsed.token) {
                  recoveredCredentials = parsed;
                  break;
                }
              }
            } catch {}
          }
          if (!recoveredCredentials && ownMemberSnap.val()?.playerId) {
            let fallbackToken = this.currentToken || '';
            if (!fallbackToken && this.storage) {
              try {
                const saved = JSON.parse(this.storage.getItem('party-game-session') || '{}');
                if (saved?.code === normCode && saved?.token) {
                  fallbackToken = String(saved.token);
                }
              } catch {}
            }
            recoveredCredentials = {
              code: normCode,
              playerId: String(ownMemberSnap.val().playerId),
              token: fallbackToken,
            };
          }
          if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
            return { ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' };
          }
          if (recoveredCredentials) {
            if (this.hostRuntime) {
              this.hostRuntime.dispose();
              this.hostRuntime = null;
            }
            const attachRes = await this.attachRoomListeners(db, roomId, authCtx.uid, false, opGen, startDeadlineMs);
            if (!attachRes.ok || this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
              return { ok: false, error: attachRes.error || 'تم إلغاء عملية الانضمام' };
            }
            this.currentRoomId = roomId;
            this.currentCode = normCode;
            this.currentPlayerId = recoveredCredentials.playerId;
            this.currentToken = recoveredCredentials.token;
            this.isHost = false;
            saveSession({
              code: normCode,
              playerId: recoveredCredentials.playerId,
              token: recoveredCredentials.token,
            });
            return {
              ok: true,
              code: recoveredCredentials.code,
              playerId: recoveredCredentials.playerId,
              token: recoveredCredentials.token,
            };
          }
          return { ok: false, error: 'الماتش شغال مش هينفع تنضم دلوقتي' };
        }

        // 3. Claim a join request slot (1..8)
        const entryServerNow = session.serverNow();
        const requestExpiresAtMs = entryServerNow + COMMAND_TIMEOUT_MS;
        const { commandId } = this.sequencer!.nextCommandId(seatId);

        let claimedSlot: string | null = null;
        for (let s = 1; s <= 8; s += 1) {
          if (
            this.disposed ||
            this.operationGeneration !== opGen ||
            Date.now() >= startDeadlineMs ||
            session.serverNow() >= requestExpiresAtMs
          ) {
            break;
          }
          const slotKey = String(s);
          try {
            const slotSnap = await get(ref(db, `rooms/${roomId}/joinRequests/${slotKey}`));
            if (
              this.disposed ||
              this.operationGeneration !== opGen ||
              Date.now() >= startDeadlineMs ||
              session.serverNow() >= requestExpiresAtMs
            ) {
              break;
            }
            const val = slotSnap.val();
            const currentNow = session.serverNow();
            if (!slotSnap.exists() || val.uid === authCtx.uid || val.expiresAtMs <= currentNow) {
              if (
                this.disposed ||
                this.operationGeneration !== opGen ||
                Date.now() >= startDeadlineMs ||
                currentNow >= requestExpiresAtMs
              ) {
                break;
              }
              await set(ref(db, `rooms/${roomId}/joinRequests/${slotKey}`), {
                commandId,
                uid: authCtx.uid,
                nickname: normNickname,
                createdAtMs: entryServerNow,
                expiresAtMs: requestExpiresAtMs,
              });
              if (
                this.disposed ||
                this.operationGeneration !== opGen ||
                Date.now() >= startDeadlineMs ||
                session.serverNow() >= requestExpiresAtMs
              ) {
                void runTransaction(ref(db, `rooms/${roomId}/joinRequests/${slotKey}`), (curr) => {
                  if (curr && curr.commandId === commandId) return null;
                  return curr;
                }).catch(() => {});
                return { ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' };
              }
              claimedSlot = slotKey;
              break;
            }
          } catch {
            // Slot occupied or claimed concurrently; try next slot
          }
        }

        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          if (claimedSlot) {
            void runTransaction(ref(db, `rooms/${roomId}/joinRequests/${claimedSlot}`), (curr) => {
              if (curr && curr.commandId === commandId) return null;
              return curr;
            }).catch(() => {});
          }
          return { ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' };
        }

        if (!claimedSlot) {
          return { ok: false, error: 'الخانات مشغولة حالياً — جرب تاني بعد لحظات' };
        }

        // 4. Low-latency bounded polling on joinResponses/$claimedSlot (starts at 25ms, then 50ms intervals)
        let joinResult: { code: string; playerId: string; token: string } | null = null;
        let joinError: string | null = null;
        let pollDelayMs = 25;

        while (Date.now() < startDeadlineMs) {
          if (this.disposed || this.operationGeneration !== opGen) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
          pollDelayMs = 50;
          if (this.disposed || this.operationGeneration !== opGen) {
            break;
          }
          try {
            const respSnap = await get(ref(db, `rooms/${roomId}/joinResponses/${claimedSlot}`));
            if (respSnap.exists()) {
              const val = respSnap.val();
              if (val.commandId === commandId && val.uid === authCtx.uid) {
                if (val.ok) {
                  const parsed = JSON.parse(val.dataJson || '{}') as {
                    code: string;
                    playerId: string;
                    token: string;
                  };
                  joinResult = parsed;
                  break;
                } else {
                  joinError = val.error || 'فشل الانضمام للغرفة';
                  break;
                }
              }
            }
          } catch {
            // Permission denied on empty or previous occupant slot is expected while waiting
          }
        }

        // 5. Non-blocking ID-conditional cleanup of own joinRequest
        void runTransaction(ref(db, `rooms/${roomId}/joinRequests/${claimedSlot}`), (curr) => {
          if (curr && curr.commandId === commandId) {
            return null;
          }
          return curr;
        }).catch(() => {});

        if (this.disposed || this.operationGeneration !== opGen) {
          return { ok: false, error: 'تم إلغاء عملية الانضمام' };
        }

        if (joinError) {
          return { ok: false, error: joinError };
        }
        if (!joinResult) {
          return { ok: false, error: 'انتهت مهلة الانضمام — جرب تاني' };
        }

        if (this.hostRuntime) {
          this.hostRuntime.dispose();
          this.hostRuntime = null;
        }

        const attachRes = await this.attachRoomListeners(db, roomId, authCtx.uid, false, opGen, startDeadlineMs);
        if (!attachRes.ok || this.disposed || this.operationGeneration !== opGen) {
          return { ok: false, error: attachRes.error || 'تم إلغاء عملية الانضمام' };
        }

        this.currentRoomId = roomId;
        this.currentCode = normCode;
        this.currentPlayerId = joinResult.playerId;
        this.currentToken = joinResult.token;
        this.isHost = false;

        saveSession({
          code: normCode,
          playerId: joinResult.playerId,
          token: joinResult.token,
        });

        return {
          ok: true,
          code: joinResult.code,
          playerId: joinResult.playerId,
          token: joinResult.token,
        };
      } catch (err) {
        if (this.disposed || this.operationGeneration !== opGen) {
          return { ok: false, error: 'تم إلغاء عملية الانضمام' };
        }
        const error = err instanceof Error ? err.message : 'فشل الانضمام للغرفة';
        this.emitError(error);
        return { ok: false, error };
      }
    })();

    try {
      const result = await Promise.race([executionPromise, timeoutPromise]);
      if (!result.ok && this.operationGeneration === opGen) {
        this.operationGeneration += 1;
      }
      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  resume(
    code: string,
    token: string,
    options?: { maxWaitMs?: number },
  ): Promise<AckResult<{ code: string; playerId: string }>> {
    const normCode = code.trim().toUpperCase();
    const resumeKey = `${normCode}:${token}`;
    if (this.activeResume) {
      if (this.activeResume.key === resumeKey) {
        return this.activeResume.promise;
      }
      // Different resume key cancels prior resume and any command it started
      this.cancelActiveCommand('تم استبدال عملية استعادة الجلسة');
      this.operationGeneration += 1;
    }

    const currentResumePromise = this.doResume(normCode, token, options).finally(() => {
      if (this.activeResume?.promise === currentResumePromise) {
        this.activeResume = null;
      }
    });

    this.activeResume = { key: resumeKey, promise: currentResumePromise };
    return currentResumePromise;
  }

  private async doResume(
    code: string,
    token: string,
    options?: { maxWaitMs?: number },
  ): Promise<AckResult<{ code: string; playerId: string }>> {
    const configCheck = validateFirebaseConfig(this.config);
    if (!configCheck.ok) {
      const err = configCheck.error || 'إعدادات Firebase غير صالحة';
      this.emitError(err);
      return { ok: false, error: err };
    }

    const opGen = ++this.operationGeneration;
    // A refreshed host must be able to wait out its predecessor's full lease, then restore.
    // Keep gameplay command timeouts separate from this recovery-only budget.
    const maxWait = options?.maxWaitMs ?? (this.options.leaseTtlMs ?? LEASE_TTL_MS) + COMMAND_TIMEOUT_MS;
    const startDeadlineMs = Date.now() + maxWait;

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<AckResult<{ code: string; playerId: string }>>((resolve) => {
      timeoutTimer = setTimeout(() => {
        resolve({ ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' });
      }, maxWait + 100);
    });

    let currentRuntime = null as FirebaseHostRuntime | null;

    const executionPromise = (async (): Promise<AckResult<{ code: string; playerId: string }>> => {
      try {
        const { session, authCtx } = await this.ensureSession();
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' };
        }
        const db = authCtx.database;

        const normCode = code.trim().toUpperCase();
        const codeSnap = await get(ref(db, `codes/${normCode}`));
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' };
        }
        if (!codeSnap.exists() || !codeSnap.val().roomId) {
          if (this.operationGeneration === opGen) clearSession();
          return { ok: false, error: 'الغرفة غير موجودة أو انتهت' };
        }
        const roomId = String(codeSnap.val().roomId);

        const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' };
        }
        if (!metaSnap.exists() || metaSnap.val().status === 'closed') {
          if (this.operationGeneration === opGen) clearSession();
          return { ok: false, error: 'الغرفة مقفولة' };
        }

        const meta = metaSnap.val();
        if (meta.hostUid === authCtx.uid) {
          const { FirebaseHostRuntime } = await import('./firebase-host-runtime.js');
          if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
            return { ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' };
          }
          // Resuming as host
          if (this.hostRuntime) {
            this.hostRuntime.dispose();
            this.hostRuntime = null;
          }

          const runtime = new FirebaseHostRuntime({
            session,
            contentSource: this.contentSource,
            leaseTtlMs: this.options.leaseTtlMs,
            heartbeatIntervalMs: this.options.heartbeatIntervalMs,
          });
          currentRuntime = runtime;
          this.hostRuntime = runtime;

          runtime.onExecutionStopped(() => {
            if (!this.disposed && this.operationGeneration === opGen && this.hostRuntime === runtime) {
              this.updateHostStatus(true);
            }
          });

          const remainingBudget = Math.max(1, startDeadlineMs - Date.now() - 50);
          const res = await runtime.resumeHost(roomId, normCode, {
            maxWaitMs: Math.min(maxWait, remainingBudget),
          });
          this.sequencer!.advanceTo(runtime.getLastCommandSequence(authCtx.uid));
          if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
            if (currentRuntime && this.hostRuntime === currentRuntime) {
              currentRuntime.dispose();
              this.hostRuntime = null;
            }
            return { ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' };
          }

          const attachRes = await this.attachRoomListeners(db, roomId, authCtx.uid, true, opGen, startDeadlineMs);
          if (!attachRes.ok || this.disposed || this.operationGeneration !== opGen) {
            if (currentRuntime && this.hostRuntime === currentRuntime) {
              currentRuntime.dispose();
              this.hostRuntime = null;
            }
            return { ok: false, error: attachRes.error || 'تم إلغاء عملية استعادة الجلسة' };
          }

          this.currentRoomId = roomId;
          this.currentCode = normCode;
          this.currentPlayerId = res.playerId;
          this.currentToken = res.token;
          this.isHost = true;

          saveSession({ code: normCode, playerId: res.playerId, token: res.token });

          return {
            ok: true,
            code: normCode,
            playerId: res.playerId,
          };
        }

        // Guest resume (or former host returning after host transfer to another member):
        if (this.hostRuntime) {
          this.hostRuntime.dispose();
          this.hostRuntime = null;
        }

        const memberSnap = await get(ref(db, `rooms/${roomId}/members/${authCtx.uid}`));
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' };
        }
        if (!memberSnap.exists() || memberSnap.val().removed === true) {
          if (this.operationGeneration === opGen) clearSession();
          return { ok: false, error: 'تم استبعادك من الغرفة أو انتهت صلاحية المقعد' };
        }

        const member = memberSnap.val();

        // Closed-tab recovery can have no session counter (including older recovery entries).
        const response = await get(ref(db, `rooms/${roomId}/responses/${authCtx.uid}`));
        if (this.disposed || this.operationGeneration !== opGen || Date.now() >= startDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة استعادة الجلسة — جرب تاني' };
        }
        const lastCommand = parseCommandId(response.val()?.commandId);
        if (lastCommand) this.sequencer!.advanceTo(lastCommand.seq);

        const attachRes = await this.attachRoomListeners(db, roomId, authCtx.uid, false, opGen, startDeadlineMs);
        if (!attachRes.ok || this.disposed || this.operationGeneration !== opGen) {
          return { ok: false, error: attachRes.error || 'تم إلغاء عملية استعادة الجلسة' };
        }

        this.currentRoomId = roomId;
        this.currentCode = normCode;
        this.currentPlayerId = member.playerId;
        this.currentToken = token;
        this.isHost = false;

        // Send resume command to notify engine of player return and propagate outcome
        const cmdRes = await this.sendCommand('resume', { token });
        if (this.disposed || this.operationGeneration !== opGen) {
          return { ok: false, error: 'تم إلغاء عملية استعادة الجلسة' };
        }
        if (!cmdRes.ok) {
          this.cleanUpRoomSubscriptions(roomId);
          if (this.currentRoomId === roomId) {
            this.currentRoomId = null;
            this.currentCode = null;
            this.currentPlayerId = null;
          }
          return { ok: false, error: cmdRes.error || 'فشل استعادة الجلسة' };
        }

        saveSession({ code: normCode, playerId: member.playerId, token });

        return {
          ok: true,
          code: normCode,
          playerId: member.playerId,
        };
      } catch (err) {
        if (currentRuntime && this.hostRuntime === currentRuntime) {
          currentRuntime.dispose();
          this.hostRuntime = null;
        }
        if (this.disposed || this.operationGeneration !== opGen) {
          return { ok: false, error: 'تم إلغاء عملية استعادة الجلسة' };
        }
        const error = err instanceof Error ? err.message : 'فشل استعادة الجلسة';
        this.emitError(error);
        return { ok: false, error };
      }
    })();

    try {
      const result = await Promise.race([executionPromise, timeoutPromise]);
      if (!result.ok && this.operationGeneration === opGen) {
        this.operationGeneration += 1;
        if (currentRuntime && this.hostRuntime === currentRuntime) {
          currentRuntime.dispose();
          this.hostRuntime = null;
        }
      }
      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  private async sendCommand<T = Record<string, never>>(
    type: string,
    payload: unknown = {},
    roundNo?: number,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<AckResult<T>> {
    if (type !== 'resume' && this.activeResume) {
      const roomId = this.currentRoomId;
      const playerId = this.currentPlayerId;
      const generation = this.operationGeneration;
      const restored = await this.activeResume.promise;
      if (!restored.ok) return { ok: false, error: restored.error };
      if (this.operationGeneration !== generation || this.currentRoomId !== roomId || this.currentPlayerId !== playerId) {
        return { ok: false, error: 'تم إلغاء الأمر بعد تغيير الجلسة' };
      }
    }
    // A promoted view may arrive before the local runtime's listeners are attached.
    // Commands must choose their host/guest acknowledgement path after that transition.
    if (this.promotionInFlight) await this.promotionPromise;
    if (this.disposed || !this.currentRoomId || !this.currentUid || !this.sequencer) {
      return { ok: false, error: 'الاتصال غير مهيأ' };
    }

    if (this.hostUnresponsive) {
      return { ok: false, error: 'الهوست غير متصل مؤقتاً — انتظر عودته' };
    }

    if (this.pendingCommand) {
      return { ok: false, error: 'يوجد أمر قيد التنفيذ حالياً' };
    }
    this.pendingCommand = true;

    const opGen = ++this.commandGeneration;
    const startNow = this.session.serverNow();
    const startLocalTime = Date.now();
    const commandExpiresAtMs = startNow + timeoutMs;
    const startDeadlineMs = startLocalTime + timeoutMs;

    const roomId = this.currentRoomId;
    const uid = this.currentUid;
    const isHost = this.isHost;
    const hostRuntime = this.hostRuntime;

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let activeCommandId: string | null = null;
    let activeDb: Database | null = null;
    let cancelResponseListener = null as (() => void) | null;
    let settleFn: ((res: AckResult<T>) => void) | null = null;
    let settled = false;

    const doCleanupInbox = (cmdId: string, db: Database | null) => {
      if (db && !this.disposed) {
        try {
          void runTransaction(ref(db, `rooms/${roomId}/commands/${uid}`), (curr) => {
            if (curr && curr.commandId === cmdId) return null;
            return curr;
          }).catch(() => {});
        } catch {}
      }
    };

    const handle: ActiveCommandHandle = {
      commandId: '',
      opGen,
      roomId,
      uid,
      cancel: (reason: string) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (cancelResponseListener) {
          try {
            cancelResponseListener();
          } catch {}
          cancelResponseListener = null;
        }
        if (this.activeCommand === handle) {
          this.activeCommand = null;
        }
        if (this.pendingCommand && this.commandGeneration === opGen) {
          this.pendingCommand = false;
        }
        if (activeCommandId) {
          doCleanupInbox(activeCommandId, activeDb);
        }
        if (settleFn) {
          settleFn({ ok: false, error: reason });
        }
      },
    };
    this.activeCommand = handle;

    const timeoutPromise = new Promise<AckResult<T>>((resolve) => {
      settleFn = resolve;
      timeoutTimer = setTimeout(() => {
        handle.cancel('انتهت مهلة الطلب — جرب تاني');
      }, timeoutMs);
    });

    const executionPromise = (async (): Promise<AckResult<T>> => {
      try {
        const { session, authCtx, seatId } = await this.ensureSession();
        if (
          this.disposed ||
          this.commandGeneration !== opGen ||
          Date.now() >= startDeadlineMs ||
          session.serverNow() >= commandExpiresAtMs
        ) {
          return { ok: false, error: 'انتهت مهلة الطلب — جرب تاني' };
        }
        const db = authCtx.database;
        activeDb = db;

        const { commandId } = this.sequencer!.nextCommandId(seatId);
        activeCommandId = commandId;
        handle.commandId = commandId;

        const commandRecord: Record<string, unknown> = {
          commandId,
          uid,
          type,
          payloadJson: JSON.stringify(payload ?? {}),
          createdAtMs: startNow,
          expiresAtMs: commandExpiresAtMs,
        };
        if (typeof roundNo === 'number') {
          commandRecord.roundNo = roundNo;
        }

        if (
          this.disposed ||
          this.commandGeneration !== opGen ||
          Date.now() >= startDeadlineMs ||
          session.serverNow() >= commandExpiresAtMs
        ) {
          return { ok: false, error: 'انتهت مهلة الطلب — جرب تاني' };
        }

        // Commit-only path for host vs guest
        if (isHost && hostRuntime) {
          const ackPromise = new Promise<AckResult<T>>((resolve) => {
            const unsubAck = hostRuntime.onCommittedAck((ack) => {
              if (settled || this.commandGeneration !== opGen) return;
              if (ack.commandId === commandId) {
                settled = true;
                if (timeoutTimer) clearTimeout(timeoutTimer);
                unsubAck();
                cancelResponseListener = null;
                if (this.activeCommand === handle) this.activeCommand = null;
                if (this.pendingCommand && this.commandGeneration === opGen) {
                  this.pendingCommand = false;
                }
                doCleanupInbox(commandId, db);
                if (ack.ok) {
                  let data: Record<string, unknown> = {};
                  if (ack.dataJson) {
                    try {
                      data = JSON.parse(ack.dataJson) as Record<string, unknown>;
                    } catch {}
                  }
                  resolve({ ok: true, ...(data as T) });
                } else {
                  resolve({ ok: false, error: ack.error || 'فشل تنفيذ الأمر' });
                }
              }
            });
            cancelResponseListener = unsubAck;
          });

          await set(ref(db, `rooms/${roomId}/commands/${uid}`), commandRecord);
          if (
            this.disposed ||
            this.commandGeneration !== opGen ||
            Date.now() >= startDeadlineMs
          ) {
            doCleanupInbox(commandId, db);
            return { ok: false, error: 'انتهت مهلة الطلب — جرب تاني' };
          }

          return await ackPromise;
        }

        // Guest path: write command to own inbox and wait on responses/${uid}
        const guestAckPromise = new Promise<AckResult<T>>((resolve) => {
          const unsub = onValue(
            ref(db, `rooms/${roomId}/responses/${uid}`),
            (snap) => {
              if (settled || !snap.exists() || this.commandGeneration !== opGen) return;
              const val = snap.val();
              if (val && val.commandId === commandId) {
                settled = true;
                if (timeoutTimer) clearTimeout(timeoutTimer);
                unsub();
                cancelResponseListener = null;
                if (this.activeCommand === handle) this.activeCommand = null;
                if (this.pendingCommand && this.commandGeneration === opGen) {
                  this.pendingCommand = false;
                }
                doCleanupInbox(commandId, db);
                if (val.ok) {
                  let data: Record<string, unknown> = {};
                  if (val.dataJson) {
                    try {
                      data = JSON.parse(val.dataJson) as Record<string, unknown>;
                    } catch {}
                  }
                  resolve({ ok: true, ...(data as T) });
                } else {
                  resolve({ ok: false, error: val.error || 'فشل تنفيذ الأمر' });
                }
              }
            },
            () => {},
          );
          cancelResponseListener = unsub;
        });

        await set(ref(db, `rooms/${roomId}/commands/${uid}`), commandRecord);
        if (
          this.disposed ||
          this.commandGeneration !== opGen ||
          Date.now() >= startDeadlineMs
        ) {
          doCleanupInbox(commandId, db);
          return { ok: false, error: 'انتهت مهلة الطلب — جرب تاني' };
        }

        return await guestAckPromise;
      } catch (err) {
        const error = err instanceof Error ? err.message : 'فشل إرسال الأمر';
        return { ok: false, error };
      }
    })();

    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cancelResponseListener) {
        try {
          cancelResponseListener();
        } catch {}
        cancelResponseListener = null;
      }
      if (this.activeCommand === handle) {
        this.activeCommand = null;
      }
      if (this.pendingCommand && this.commandGeneration === opGen) {
        this.pendingCommand = false;
      }
      this.flushOfflineActions();
    }
  }

  configure(patch: Record<string, unknown>): Promise<AckResult<Record<string, unknown>>> {
    return this.sendCommand('configure', patch);
  }

  setReady(ready?: boolean): Promise<AckResult<Record<string, unknown>>> {
    return this.sendCommand('ready', { ready });
  }

  start(): Promise<AckResult<Record<string, unknown>>> {
    return this.sendCommand('start');
  }

  skip(): Promise<AckResult<Record<string, unknown>>> {
    return this.sendCommand('skip');
  }

  kick(playerId: string): Promise<AckResult<Record<string, unknown>>> {
    return this.sendCommand('kick', { playerId });
  }

  rematch(): Promise<AckResult<Record<string, unknown>>> {
    return this.sendCommand('rematch');
  }

  async leave(): Promise<AckResult<Record<string, unknown>>> {
    this.offlineActions.cancel();
    const departingRoomId = this.currentRoomId;
    const departingIsHost = this.isHost;
    const departingHostRuntime = this.hostRuntime;
    const departingUid = this.currentUid;
    const leaveStartDeadlineMs = Date.now() + 5_000;

    this.commandGeneration += 1;
    this.operationGeneration += 1;

    if (this.activeCommand) {
      this.activeCommand.cancel('تمت مغادرة الغرفة');
      this.activeCommand = null;
    }

    clearSession();
    this.cleanUpRoomSubscriptions(departingRoomId ?? undefined);

    this.currentRoomId = null;
    this.currentCode = null;
    this.currentPlayerId = null;
    this.currentToken = null;
    this.latestRoomView = null;
    this.isHost = false;
    this.hostRuntime = null;
    this.currentRoomExpiresAtMs = 0;

    if (!departingRoomId) {
      return { ok: true };
    }

    if (departingIsHost && departingHostRuntime) {
      try {
        const relinquished = await departingHostRuntime.relinquishHost();
        if (!relinquished) {
          await departingHostRuntime.closeRoom('أغلق الهوست الغرفة');
        }
        departingHostRuntime.dispose();
        return { ok: true };
      } catch (err) {
        departingHostRuntime.dispose();
        const error = err instanceof Error ? err.message : 'فشل إغلاق الغرفة';
        return { ok: false, error };
      }
    }

    // Guest leave: send genuine leave command to departing room inbox anchored to entry deadline
    let settled = false;
    let timer = null as ReturnType<typeof setTimeout> | null;
    let unsub = null as Unsubscribe | null;
    let activeCmdRef: ReturnType<typeof ref> | null = null;
    let activeCmdId: string | null = null;

    const cleanupLeave = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      if (activeCmdRef && activeCmdId && !this.disposed) {
        const targetId = activeCmdId;
        void runTransaction(activeCmdRef, (curr) => {
          if (curr && curr.commandId === targetId) return null;
          return curr;
        }).catch(() => {});
      }
    };

    const timeoutPromise = new Promise<AckResult<Record<string, unknown>>>((resolve) => {
      const remainingMs = Math.max(50, leaveStartDeadlineMs - Date.now());
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupLeave();
        resolve({ ok: false, error: 'انتهت مهلة المغادرة' });
      }, remainingMs);
    });

    const workPromise = (async (): Promise<AckResult<Record<string, unknown>>> => {
      try {
        if (this.disposed || Date.now() >= leaveStartDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة المغادرة' };
        }
        const { session, authCtx, seatId } = await this.ensureSession();
        if (settled || this.disposed || Date.now() >= leaveStartDeadlineMs) {
          return { ok: false, error: 'انتهت مهلة المغادرة' };
        }
        const db = authCtx.database;
        const uid = departingUid ?? authCtx.uid;
        const now = session.serverNow();
        const { commandId } = this.sequencer!.nextCommandId(seatId);
        activeCmdId = commandId;

        const commandRecord: Record<string, unknown> = {
          commandId,
          uid,
          type: 'leave',
          payloadJson: JSON.stringify({}),
          createdAtMs: now,
          expiresAtMs: now + 5_000,
        };

        const cmdRef = ref(db, `rooms/${departingRoomId}/commands/${uid}`);
        activeCmdRef = cmdRef;

        const ackPromise = new Promise<AckResult<Record<string, unknown>>>((resolve) => {
          unsub = onValue(
            ref(db, `rooms/${departingRoomId}/responses/${uid}`),
            (snap) => {
              if (settled || this.disposed || !snap.exists()) return;
              const val = snap.val();
              if (val && val.commandId === commandId) {
                settled = true;
                cleanupLeave();
                if (val.ok) {
                  resolve({ ok: true });
                } else {
                  resolve({ ok: false, error: val.error || 'فشل المغادرة' });
                }
              }
            },
            () => {
              if (settled) return;
              settled = true;
              cleanupLeave();
              resolve({ ok: false, error: 'انتهى الاتصال أثناء المغادرة' });
            },
          );
        });

        await set(cmdRef, commandRecord);
        if (settled || this.disposed || Date.now() >= leaveStartDeadlineMs) {
          cleanupLeave();
          return { ok: false, error: 'انتهت مهلة المغادرة' };
        }

        return await ackPromise;
      } catch (err) {
        cleanupLeave();
        const error = err instanceof Error ? err.message : 'فشل إرسال أمر المغادرة';
        return { ok: false, error };
      }
    })();

    try {
      return await Promise.race([workPromise, timeoutPromise]);
    } finally {
      settled = true;
      cleanupLeave();
    }
  }

  act(roundNo: number, action: unknown): Promise<AckResult<Record<string, unknown>>> {
    const scope = this.roundActionScope();
    if (!this.isConnected && scope && this.latestRoomView?.round?.roundNo === roundNo) {
      const roomId = this.currentRoomId;
      const deadline = Date.now() + 2_000;
      return this.offlineActions.enqueue(scope, async () => {
        const { authCtx } = await this.ensureSession();
        const shared = await get(ref(authCtx.database, `rooms/${roomId}/publicView`));
        let freshView: RoomView | null;
        if (shared.exists()) {
          const personal = await get(ref(authCtx.database, `rooms/${roomId}/privateViews/${authCtx.uid}`));
          freshView = mergeSplitView(shared.val(), personal.val());
        } else {
          const legacy = await get(ref(authCtx.database, `rooms/${roomId}/views/${authCtx.uid}`));
          freshView = legacy.exists() ? JSON.parse(legacy.val().json) as RoomView : null;
        }
        // A reconnect notification can precede delivery of the latest round. Validate a server
        // read before replaying so an answer can never spill into the next question or stage.
        if (this.disposed || !this.isConnected || Date.now() >= deadline || this.currentRoomId !== roomId ||
          this.roundActionScope(freshView) !== scope) {
          return { ok: false, error: 'انتهت فرصة إرسال الإجابة بعد رجوع الاتصال' };
        }
        return this.sendCommand('round:action', { action }, roundNo, 7_500);
      });
    }
    return this.sendCommand('round:action', { action }, roundNo);
  }

  private roundActionScope(view = this.latestRoomView): string | null {
    if (!view?.round || !['in_round', 'sudden_death'].includes(view.phase) || !this.currentRoomId) return null;
    if (view.phaseEndsAtMs !== null && this.session.serverNow() >= view.phaseEndsAtMs) return null;
    const round = view.round.view as { stage?: string; current?: { index?: number }; rung?: number } | null;
    return JSON.stringify([this.currentRoomId, view.round.roundNo, view.round.typeId,
      round?.stage, round?.current?.index, round?.rung]);
  }

  private flushOfflineActions(): void {
    this.offlineActions.flush(this.roundActionScope(), this.isConnected && !this.pendingCommand && !this.promotionInFlight);
  }

  async preloadContent(categoryIds: string[]): Promise<void> {
    await this.contentSource.preload?.(categoryIds);
  }

  readonly latencyLabel = 'اتصال Firebase';

  async sampleLatency(): Promise<number | null> {
    if (!this.isConnected || !this.currentRoomId) return null;
    const roomId = this.currentRoomId;
    const { authCtx } = await this.ensureSession();
    const idToken = await authCtx.user.getIdToken();
    const measured = await measureDatabaseLatency(ref(authCtx.database, `rooms/${roomId}/meta`).toString(), idToken);
    return this.isConnected && this.currentRoomId === roomId ? measured : null;
  }

  private getCandidateTakeoverRank(): number {
    if (!this.latestRoomView || !this.currentPlayerId) return 0;
    const candidates = this.latestRoomView.players.filter(
      (p) => !p.isHost && p.connected && !p.leftEarly,
    );
    const idx = candidates.findIndex((p) => p.id === this.currentPlayerId);
    return idx >= 0 ? idx : candidates.length;
  }

  private scheduleHostTakeover(
    attachment: ActiveRoomAttachment,
    roomId: string,
    immediate: boolean,
  ): void {
    if (this.disposed || this.isHost || this.promotionInFlight || attachment.disposed) return;
    if (attachment.takeoverTimer) return;

    const rank = this.getCandidateTakeoverRank();
    const delayMs = immediate ? rank * 250 + 50 : rank * 300 + 50;

    attachment.takeoverTimer = setTimeout(() => {
      attachment.takeoverTimer = null;
      if (this.disposed || this.isHost || attachment.disposed || this.currentRoomId !== roomId) {
        return;
      }
      this.promotionPromise = this.tryPromoteToHost(roomId);
    }, delayMs);
  }

  private async tryPromoteToHost(roomId: string): Promise<void> {
    if (
      this.disposed ||
      this.isHost ||
      this.promotionInFlight ||
      this.currentRoomId !== roomId ||
      !this.currentCode
    ) {
      return;
    }
    this.promotionInFlight = true;
    const code = this.currentCode;
    let candidateRuntime: FirebaseHostRuntime | null = null;

    try {
      const [{ session, authCtx }, { FirebaseHostRuntime }] = await Promise.all([
        this.ensureSession(), import('./firebase-host-runtime.js'),
      ]);
      if (this.disposed || this.isHost || this.currentRoomId !== roomId) return;

      const runtime = new FirebaseHostRuntime({
        session,
        contentSource: this.contentSource,
        leaseTtlMs: this.options.leaseTtlMs,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      });
      candidateRuntime = runtime;

      const res = await runtime.resumeHost(roomId, code, {
        maxWaitMs: 1_500,
        allowTakeover: true,
      });

      if (this.disposed || this.currentRoomId !== roomId) {
        runtime.dispose();
        return;
      }

      if (this.hostRuntime && this.hostRuntime !== runtime) {
        this.hostRuntime.dispose();
      }
      this.hostRuntime = runtime;
      candidateRuntime = null;
      this.isHost = true;
      this.currentPlayerId = res.playerId;
      if (res.token) {
        this.currentToken = res.token;
      }
      this.updateHostStatus(false);

      const currentOpGen = this.operationGeneration;
      runtime.onExecutionStopped(() => {
        if (!this.disposed && this.hostRuntime === runtime && this.isHost) {
          this.updateHostStatus(true);
        }
      });

      await this.attachRoomListeners(
        authCtx.database,
        roomId,
        authCtx.uid,
        true,
        currentOpGen,
        Date.now() + COMMAND_TIMEOUT_MS,
      );

      if (this.currentToken) {
        saveSession({
          code,
          playerId: res.playerId,
          token: this.currentToken,
        });
      }
    } catch {
      if (candidateRuntime) {
        candidateRuntime.dispose();
      }
    } finally {
      this.promotionInFlight = false;
    }
  }

  private async demoteToGuest(db: Database, roomId: string, uid: string): Promise<void> {
    if (this.disposed || !this.isHost || this.currentRoomId !== roomId) return;
    this.isHost = false;
    if (this.hostRuntime) {
      this.hostRuntime.dispose();
      this.hostRuntime = null;
    }
    this.updateHostStatus(false);
    const currentOpGen = this.operationGeneration;
    await this.attachRoomListeners(
      db,
      roomId,
      uid,
      false,
      currentOpGen,
      Date.now() + COMMAND_TIMEOUT_MS,
    );
    if (!this.disposed && this.currentRoomId === roomId && this.currentToken && !this.pendingCommand) {
      void this.sendCommand('resume', { token: this.currentToken }).catch(() => {});
    }
  }

  private async attachRoomListeners(
    db: Database,
    roomId: string,
    uid: string,
    isHost: boolean,
    opGen: number,
    deadlineMs: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.disposed || this.operationGeneration !== opGen || Date.now() >= deadlineMs) {
      return { ok: false, error: 'تم إلغاء الاتصال بالغرفة' };
    }

    this.cleanUpRoomSubscriptions();
    const attachmentId = ++this.currentAttachmentId;
    const attachment = new ActiveRoomAttachment(attachmentId, roomId, isHost, opGen);
    this.currentAttachment = attachment;

    const isAttachmentActive = (): boolean => {
      return (
        !this.disposed &&
        !attachment.disposed &&
        this.currentAttachment === attachment &&
        this.operationGeneration === opGen
      );
    };

    // 1. Presence setup
    const presenceRef = ref(db, `rooms/${roomId}/presence/${uid}`);
    const presenceDisconnect = onDisconnect(presenceRef);
    attachment.presenceDisconnect = presenceDisconnect;

    try {
      if (!isAttachmentActive() || this.operationGeneration !== opGen || Date.now() >= deadlineMs) {
        attachment.dispose();
        if (this.currentAttachment === attachment) this.currentAttachment = null;
        return { ok: false, error: 'تم إلغاء الاتصال بالغرفة' };
      }

      await set(presenceRef, {
        uid,
        connected: true,
        updatedAtMs: this.session.serverNow(),
      });

      if (!isAttachmentActive() || this.operationGeneration !== opGen || Date.now() >= deadlineMs) {
        attachment.dispose();
        if (this.currentAttachment === attachment) this.currentAttachment = null;
        return { ok: false, error: 'تم إلغاء الاتصال بالغرفة' };
      }

      await presenceDisconnect.set({
        uid,
        connected: false,
        updatedAtMs: serverTimestamp(),
      });

      if (!isAttachmentActive() || this.operationGeneration !== opGen || Date.now() >= deadlineMs) {
        attachment.dispose();
        if (this.currentAttachment === attachment) this.currentAttachment = null;
        return { ok: false, error: 'تم إلغاء الاتصال بالغرفة' };
      }
    } catch (presenceErr) {
      attachment.dispose();
      if (this.currentAttachment === attachment) this.currentAttachment = null;
      const msg = presenceErr instanceof Error ? presenceErr.message : 'فشل إعداد حالة الاتصال';
      return { ok: false, error: msg };
    }

    // 2. View subscription
    if (isHost && this.hostRuntime) {
      attachment.viewUnsub = this.hostRuntime.onCommittedView((view) => {
        if (!isAttachmentActive()) {
          return;
        }
        this.latestRoomView = view;
        this.flushOfflineActions();
        for (const handler of this.stateListeners) {
          handler(view);
        }
      });
      const initialView = this.hostRuntime.getLatestCommittedView();
      if (initialView && isAttachmentActive()) {
        this.latestRoomView = initialView;
        this.flushOfflineActions();
        for (const handler of this.stateListeners) {
          handler(initialView);
        }
      }
    } else {
      let shared: ProjectionRecord | null = null;
      let personal: ProjectionRecord | null = null;
      const accept = (view: RoomView | null) => {
        if (!view || !isAttachmentActive()) return;
        this.latestRoomView = view;
        this.flushOfflineActions();
        for (const handler of this.stateListeners) handler(view);
      };
      const onViewError = () => {
        if (!isAttachmentActive()) return;
        this.emitError('انقطع الاتصال بعرض الغرفة أو أُلغيت الصلاحية');
        this.emitClosed('انقطع الاتصال بعرض الغرفة أو أُلغيت الصلاحية', roomId);
      };
      const subscriptions = [
        onValue(ref(db, `rooms/${roomId}/publicView`), (snap) => {
          shared = snap.exists() ? snap.val() as ProjectionRecord : null;
          try { accept(mergeSplitView(shared, personal)); } catch { onViewError(); }
        }, onViewError),
        onValue(ref(db, `rooms/${roomId}/privateViews/${uid}`), (snap) => {
          personal = snap.exists() ? snap.val() as ProjectionRecord : null;
          try { accept(mergeSplitView(shared, personal)); } catch { onViewError(); }
        }, onViewError),
        onValue(ref(db, `rooms/${roomId}/views/${uid}`), (snap) => {
          if (shared || !snap.exists()) return;
          try { accept(JSON.parse(snap.val().json) as RoomView); } catch { onViewError(); }
        }, onViewError),
      ];
      attachment.viewUnsub = () => { for (const unsubscribe of subscriptions) unsubscribe(); };
    }

    // 3. Heartbeat & host unresponsive / takeover monitoring (for guests)
    if (!isHost) {
      this.lastHostSeenAtMs = 0;
      const hbRef = ref(db, `rooms/${roomId}/heartbeat`);
      attachment.heartbeatUnsub = onValue(
        hbRef,
        (snap) => {
          if (!snap.exists() || !isAttachmentActive()) {
            return;
          }
          const val = snap.val();
          if (val && typeof val.lastSeenAtMs === 'number') {
            this.lastHostSeenAtMs = val.lastSeenAtMs;
            const now = this.session.serverNow();
            const elapsed = now - val.lastSeenAtMs;
            if (val.connected === false) {
              // Host explicitly left and relinquished lease -> trigger immediate staggered takeover
              this.scheduleHostTakeover(attachment, roomId, true);
            } else if (elapsed > HOST_UNRESPONSIVE_THRESHOLD_MS) {
              this.updateHostStatus(true);
            } else {
              this.updateHostStatus(false);
              if (attachment.takeoverTimer) {
                clearTimeout(attachment.takeoverTimer);
                attachment.takeoverTimer = null;
              }
            }
          }
        },
        () => {
          if (!isAttachmentActive()) {
            return;
          }
          this.emitError('انقطع الاتصال بنبض الغرفة أو انتهت الصلاحية');
        },
      );
    }

    // 4. Pulse check timer (runs for both host and guest)
    attachment.pulseTimer = setInterval(() => {
      if (!isAttachmentActive()) {
        return;
      }
      const now = this.session.serverNow();

      if (this.currentRoomExpiresAtMs > 0 && now >= this.currentRoomExpiresAtMs) {
        this.emitClosed('انتهت صلاحية الغرفة', roomId);
        return;
      }

      if (!isHost) {
        if (!this.isConnected) {
          return;
        }
        if (this.lastHostSeenAtMs > 0) {
          const elapsed = now - this.lastHostSeenAtMs;
          const effectiveLeaseTtlMs = this.options.leaseTtlMs ?? LEASE_TTL_MS;
          const takeoverGraceMs =
            this.options.hostTakeoverGraceMs ?? DEFAULT_HOST_TAKEOVER_GRACE_MS;

          if (elapsed > HOST_DEAD_THRESHOLD_MS) {
            this.emitClosed('انتهت مهلة اتصال الهوست (أكثر من 60 ثانية)', roomId);
          } else {
            if (elapsed > HOST_UNRESPONSIVE_THRESHOLD_MS) {
              this.updateHostStatus(true);
            } else {
              this.updateHostStatus(false);
            }
            if (elapsed >= effectiveLeaseTtlMs + takeoverGraceMs) {
              this.scheduleHostTakeover(attachment, roomId, false);
            }
          }
        }
      }
    }, 1_000);

    // 5. Meta status monitoring
    const metaRef = ref(db, `rooms/${roomId}/meta`);
    attachment.metaUnsub = onValue(
      metaRef,
      (snap) => {
        if (!snap.exists() || !isAttachmentActive()) {
          return;
        }
        const val = snap.val();
        if (val) {
          if (typeof val.expiresAtMs === 'number') {
            this.currentRoomExpiresAtMs = val.expiresAtMs;
          }
          const now = this.session.serverNow();
          if (val.status === 'closed') {
            this.emitClosed(val.closedReason || 'انتهت الغرفة', roomId);
          } else if (val.expiresAtMs && now >= val.expiresAtMs) {
            this.emitClosed('انتهت صلاحية الغرفة', roomId);
          } else if (this.isHost && val.hostUid && val.hostUid !== uid) {
            // Another member legitimately took over host role after lease expiry; demote to guest
            void this.demoteToGuest(db, roomId, uid);
          }
        }
      },
      () => {
        if (!isAttachmentActive()) {
          return;
        }
        this.emitClosed('انتهت صلاحية الغرفة أو انتهى الاتصال بها', roomId);
      },
    );

    if (!isAttachmentActive() || this.operationGeneration !== opGen || Date.now() >= deadlineMs) {
      attachment.dispose();
      if (this.currentAttachment === attachment) this.currentAttachment = null;
      return { ok: false, error: 'تم إلغاء الاتصال بالغرفة' };
    }

    return { ok: true };
  }

  private updateHostStatus(unresponsive: boolean): void {
    if (this.hostUnresponsive !== unresponsive) {
      this.hostUnresponsive = unresponsive;
      for (const handler of this.hostStatusListeners) {
        handler(unresponsive);
      }
    }
  }

  private emitClosed(reason: string, targetRoomId?: string): void {
    if (targetRoomId) {
      const matchesRoom = this.currentRoomId === targetRoomId;
      const matchesAttachment = this.currentAttachment?.roomId === targetRoomId;
      if (!matchesRoom && !matchesAttachment) {
        return;
      }
    }

    this.commandGeneration += 1;
    this.operationGeneration += 1;

    if (this.activeCommand) {
      this.activeCommand.cancel('تم إغلاق الغرفة: ' + reason);
      this.activeCommand = null;
    }

    if (this.hostRuntime) {
      this.hostRuntime.dispose();
      this.hostRuntime = null;
    }

    clearSession();
    this.cleanUpRoomSubscriptions(targetRoomId);

    this.currentRoomId = null;
    this.currentCode = null;
    this.currentPlayerId = null;
    this.currentToken = null;
    this.latestRoomView = null;
    this.offlineActions.cancel();
    this.isHost = false;
    this.currentRoomExpiresAtMs = 0;

    for (const handler of this.closedListeners) {
      try {
        handler({ reason });
      } catch {
        // Ignore subscriber error
      }
    }
  }

  private cleanUpRoomSubscriptions(targetRoomId?: string): void {
    this.currentAttachmentId += 1;
    if (this.currentAttachment) {
      if (!targetRoomId || this.currentAttachment.roomId === targetRoomId) {
        this.currentAttachment.dispose();
        this.currentAttachment = null;
      }
    }
    this.hostUnresponsive = false;
    this.currentRoomExpiresAtMs = 0;
    this.lastHostSeenAtMs = 0;
  }

  retryConnection(): void {
    if (this.disposed) return;
    const configCheck = validateFirebaseConfig(this.config);
    if (!configCheck.ok) {
      this.emitError(configCheck.error || 'إعدادات Firebase غير صالحة');
      return;
    }

    if (this.recoveryPromise) return;

    this.recoveryPromise = (async () => {
      try {
        const { authCtx } = await this.ensureSession();
        if (this.disposed || !this.currentRoomId || !this.currentCode) return;

        let token = this.currentToken;
        if (!token && typeof window !== 'undefined' && this.storage) {
          try {
            const saved = JSON.parse(this.storage.getItem('party-game-session') || '{}');
            if (saved?.token) {
              token = String(saved.token);
            }
          } catch {}
        }

        // If host in current room and host runtime stopped/expired (e.g. after switching apps on mobile),
        // resume session (will resume as host if still hostUid, or seamlessly demote to guest if transferred!)
        if (this.isHost && (!this.hostRuntime || !this.hostRuntime.isLive())) {
          if (token && this.currentCode) {
            await this.resume(this.currentCode, token);
          }
          return;
        }

        // Re-assert presence immediately when returning from background/mobile app switch
        await set(ref(authCtx.database, `rooms/${this.currentRoomId}/presence/${authCtx.uid}`), {
          uid: authCtx.uid,
          connected: true,
          updatedAtMs: this.session.serverNow(),
        }).catch(() => {});

        const selfPlayer = this.latestRoomView?.players.find((p) => p.id === this.currentPlayerId);
        if (!this.isHost && selfPlayer && !selfPlayer.connected && token && !this.pendingCommand) {
          await this.sendCommand('resume', { token }).catch(() => {});
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'فشل إعادة الاتصال';
        this.emitError(error);
      } finally {
        this.recoveryPromise = null;
      }
    })();
  }

  dispose(): void {
    this.offlineActions.cancel();
    this.disposed = true;
    this.commandGeneration += 1;
    this.operationGeneration += 1;

    if (this.activeCommand) {
      this.activeCommand.cancel('Transport is disposed');
      this.activeCommand = null;
    }

    this.cleanUpRoomSubscriptions();

    if (this.hostRuntime) {
      this.hostRuntime.dispose();
      this.hostRuntime = null;
    }
    if (this.connectionUnsub) {
      this.connectionUnsub();
      this.connectionUnsub = null;
    }

    this.seatManager.dispose();
    if (this.sessionInstance) {
      void this.sessionInstance.dispose();
      this.sessionInstance = null;
    }

    this.stateListeners.clear();
    this.closedListeners.clear();
    this.connectionListeners.clear();
    this.hostStatusListeners.clear();
    this.errorListeners.clear();
  }
}
