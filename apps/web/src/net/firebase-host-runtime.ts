import { nanoid } from 'nanoid';
import type {
  ContentSource,
  MatchConfig,
  PlayerId,
  RoomPlayer,
  RoomState,
  RoomView,
} from '@game/shared';
import {
  EngineError,
  generateCode,
  MatchEngine,
  MemoryStore,
  toView,
} from '@game/engine';
import {
  type Database,
  get,
  onValue,
  ref,
  remove,
  runTransaction,
  set,
  update,
  type Unsubscribe,
} from 'firebase/database';
import type { FirebaseSessionManager } from './firebase-session.js';
import { HostDedupTracker, parseCommandId } from './sequence.js';
import { prepareViewPublication } from './view-publication.js';
import { splitViewUpdates } from './split-view.js';
import { questionSample } from './question-telemetry.js';
import { LEASE_TTL_MS } from './firebase-lease.js';

export const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
export { LEASE_TTL_MS };
export const HEARTBEAT_INTERVAL_MS = 3_500;

export interface HostRuntimeOptions {
  session: FirebaseSessionManager;
  contentSource: ContentSource;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  runtimeId?: string;
}

export interface BootstrapRoomResult {
  code: string;
  roomId: string;
  playerId: string;
  token: string;
}

export interface HostSnapshotEnvelope {
  envelopeVersion: 1;
  projectionFormat?: 2;
  state: RoomState;
  bindings: Array<{ uid: string; playerId: string; slot: string }>;
  occupiedSlots: Array<{ slot: string; uid: string }>;
  dedup: ReturnType<HostDedupTracker['toJSON']>;
}

export interface CommittedAck {
  commandId: string;
  ok: boolean;
  error?: string;
  dataJson?: string;
}

interface QueuedTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface RoomMetaCache {
  code: string;
  hostUid: string;
  createdAtMs: number;
  expiresAtMs: number;
  phase: string;
  status: string;
  memberCount: number;
  admittedCount: number;
  updatedAtMs: number;
  leaseOwnerId: string;
}

/**
 * Executes the authoritative game engine as the fixed room host.
 *
 * All state mutations are serialized through an internal queue and atomically published
 * to Firebase RTDB alongside redacted player RoomViews and live lease fencing.
 */
export class FirebaseHostRuntime {
  getLastCommandSequence(uid: string): number {
    return this.dedup.toJSON()[uid]?.lastSeq ?? 0;
  }
  readonly session: FirebaseSessionManager;
  readonly contentSource: ContentSource;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;

  private runtimeId: string;
  private roomId: string | null = null;
  private code: string | null = null;
  private hostUid: string | null = null;
  private hostPlayerId: string | null = null;
  private epoch = 1;
  private generation = 0;
  private acquiredAtMs = 0;
  private leaseExpiresAtMs = 0;

  private store = new MemoryStore();
  private engine: MatchEngine | null = null;
  private dedup = new HostDedupTracker();

  private readonly uidToPlayerId = new Map<string, string>();
  private readonly playerIdToUid = new Map<string, string>();
  private readonly uidToSlot = new Map<string, string>();
  private readonly occupiedSlots = new Map<string, string>(); // slot -> uid

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private joinRequestsUnsub: Unsubscribe | null = null;
  private commandsUnsub: Unsubscribe | null = null;
  private presenceUnsub: Unsubscribe | null = null;
  private leaseUnsub: Unsubscribe | null = null;
  private metaUnsub: Unsubscribe | null = null;

  private cachedMeta: RoomMetaCache | null = null;
  private projectionFormat: 1 | 2 = 2;
  private readonly committedViewSignatures = new Map<string, string>();
  private readonly latestJoinRequests = new Map<
    string,
    { commandId: string; uid: string; nickname: string; expiresAtMs: number }
  >();
  private readonly latestCommands = new Map<
    string,
    {
      commandId: string;
      uid: string;
      type: string;
      payloadJson: string;
      expiresAtMs: number;
      roundNo?: number;
    }
  >();

  private queue: QueuedTask<unknown>[] = [];
  private isProcessingQueue = false;
  private disposed = false;
  private isPublishing = false;
  private isStopped = false;
  private isRestoring = false;
  private connectionUnsub: (() => void) | null = null;
  private committedViewHandlers: ((view: RoomView) => void)[] = [];
  private committedAckHandlers: ((ack: CommittedAck) => void)[] = [];
  private executionStoppedHandlers: ((reason: string) => void)[] = [];
  private latestCommittedView: RoomView | null = null;

  constructor(options: HostRuntimeOptions) {
    this.session = options.session;
    this.contentSource = options.contentSource;
    this.leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.runtimeId = options.runtimeId ?? `rt_${nanoid(16).replace(/[^A-Za-z0-9_-]/g, 'a')}`;

    this.connectionUnsub = this.session.onConnectionChange((connected) => {
      if (this.disposed || this.isStopped) return;
      if (!connected && (this.acquiredAtMs > 0 || this.isRestoring || this.isLive())) {
        this.stopExecution('فقدان الاتصال بقاعدة البيانات');
      }
    });
  }

  getRuntimeId(): string {
    return this.runtimeId;
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  getCode(): string | null {
    return this.code;
  }

  getHostPlayerId(): string | null {
    return this.hostPlayerId;
  }

  getLatestCommittedView(): RoomView | null {
    return this.latestCommittedView;
  }

  getStore(): MemoryStore {
    return this.store;
  }

  getEngine(): MatchEngine | null {
    return this.engine;
  }

  isLive(): boolean {
    return !this.disposed && !this.isStopped && this.session.serverNow() < this.leaseExpiresAtMs && this.session.getIsConnected();
  }

  private assertLive(generation: number): void {
    if (this.disposed || this.isStopped || this.generation !== generation || !this.isLive()) {
      throw new Error('Host execution preempted by lease loss, generation change, or disposal');
    }
  }

  private assertRestorationLive(generation: number): void {
    if (this.disposed || this.isStopped || this.generation !== generation) {
      throw new Error('Host restoration preempted by disposal, stop, or generation change');
    }
    if (this.acquiredAtMs > 0) {
      if (this.session.serverNow() >= this.leaseExpiresAtMs || !this.session.getIsConnected()) {
        this.stopExecution('فقدان حجز الغرفة أثناء استعادة الحالة');
        throw new Error('Host restoration preempted by lease expiry or disconnection');
      }
    }
  }

  private startLeaseObserver(db: Database): void {
    if (!this.roomId) return;
    if (this.leaseUnsub) {
      this.leaseUnsub();
      this.leaseUnsub = null;
    }
    const leaseRef = ref(db, `rooms/${this.roomId}/lease`);
    this.leaseUnsub = onValue(leaseRef, (snap) => {
      if (this.disposed || this.isStopped) return;
      if (!snap.exists()) return;
      const val = snap.val();
      if (val && (val.ownerId !== this.runtimeId || val.epoch !== this.epoch)) {
        this.stopExecution('فقدان حجز الغرفة لهوست آخر');
      }
    });
  }

  onCommittedView(handler: (view: RoomView) => void): () => void {
    this.committedViewHandlers.push(handler);
    return () => {
      this.committedViewHandlers = this.committedViewHandlers.filter((h) => h !== handler);
    };
  }

  private notifyCommittedView(view: RoomView): void {
    this.latestCommittedView = view;
    for (const h of this.committedViewHandlers) {
      try {
        h(view);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  private async publishRoomUpdate(db: Database, proposed: Record<string, unknown>): Promise<void> {
    if (this.projectionFormat === 2) {
      await update(ref(db, `rooms/${this.roomId}`), splitViewUpdates(proposed));
      this.recordQuestionSample(db, proposed);
      return;
    }
    const publication = prepareViewPublication(proposed, this.committedViewSignatures);
    await update(ref(db, `rooms/${this.roomId}`), publication.updates);
    // Only a server-accepted publication may suppress a later retry.
    for (const [path, signature] of publication.signatures) {
      this.committedViewSignatures.set(path, signature);
    }
    this.recordQuestionSample(db, proposed);
  }

  private recordQuestionSample(db: Database, proposed: Record<string, unknown>): void {
    const snapshot = proposed.snapshot as { json: string } | undefined;
    if (!snapshot || !this.roomId) return;
    const state = (JSON.parse(snapshot.json) as HostSnapshotEnvelope).state;
    const sample = questionSample(state, this.roomId);
    if (!sample) return;
    const sampleRef = ref(db, `telemetry/${sample.questionId}/${sample.sampleId}`);
    // An immutable room/round key prevents duplicated samples after retries and host transfer.
    void runTransaction(sampleRef, (existing) => existing ? undefined : sample.aggregate, { applyLocally: false })
      .catch((error) => console.warn('Question telemetry was not saved', error));
  }

  onCommittedAck(handler: (ack: CommittedAck) => void): () => void {
    this.committedAckHandlers.push(handler);
    return () => {
      this.committedAckHandlers = this.committedAckHandlers.filter((h) => h !== handler);
    };
  }

  private notifyCommittedAck(ack: CommittedAck): void {
    for (const h of this.committedAckHandlers) {
      try {
        h(ack);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  onExecutionStopped(handler: (reason: string) => void): () => void {
    this.executionStoppedHandlers.push(handler);
    return () => {
      this.executionStoppedHandlers = this.executionStoppedHandlers.filter((h) => h !== handler);
    };
  }

  private notifyExecutionStopped(reason: string): void {
    for (const h of this.executionStoppedHandlers) {
      try {
        h(reason);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  private createSnapshotRecord(state: RoomState, now: number) {
    const envelope: HostSnapshotEnvelope = {
      envelopeVersion: 1,
      ...(this.projectionFormat === 2 ? { projectionFormat: 2 as const } : {}),
      state,
      bindings: Array.from(this.uidToPlayerId.entries()).map(([uid, playerId]) => ({
        uid,
        playerId,
        slot: this.uidToSlot.get(uid) ?? '1',
      })),
      occupiedSlots: Array.from(this.occupiedSlots.entries()).map(([slot, uid]) => ({
        slot,
        uid,
      })),
      dedup: this.dedup.toJSON(),
    };
    return {
      json: JSON.stringify(envelope),
      version: state.version,
      updatedAtMs: now,
      leaseOwnerId: this.runtimeId,
    };
  }

  /**
   * Enqueues an async task to run sequentially on the host engine with generation and liveness fencing.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Host runtime is disposed'));
    }
    const currentGen = this.generation;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: async () => {
          if (this.disposed || this.generation !== currentGen || !this.isLive()) {
            throw new Error('Host execution preempted by lease expiration, generation change, or disposal');
          }
          const result = await fn();
          if (this.disposed || this.generation !== currentGen || !this.isLive()) {
            throw new Error('Host execution preempted by lease expiration, generation change, or disposal');
          }
          return result;
        },
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.queue.length === 0 || this.disposed) {
      return;
    }
    this.isProcessingQueue = true;
    while (this.queue.length > 0 && !this.disposed) {
      const task = this.queue.shift();
      if (!task) break;
      try {
        const result = await task.fn();
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      }
    }
    this.isProcessingQueue = false;
  }

  /**
   * Reconciles an existing `hosts/$uid/activeRoom` intent before replacing it.
   *
   * - Does not swallow read/permission/network errors.
   * - If `rooms/$priorRoomId/meta` is absent (verified via authorized exists() === false), returns cleanly.
   * - If `rooms/$priorRoomId/meta` is open and unexpired, acquires/verifies lease ownership and closes it.
   *   - If no lease exists yet (metadata-only bootstrap), acquires epoch 1 using `meta.leaseOwnerId` fence.
   *   - If a live lease is actively renewed by another runtime, throws without replacing pointer.
   * - Cleans up `codes/$priorCode` ONLY if its current `roomId` still matches `priorRoomId`.
   */
  private async reconcilePriorActiveRoom(
    db: Database,
    hostUid: string,
    priorRoomId: string,
    priorCode: string,
    currentGen: number,
  ): Promise<void> {
    this.assertRestorationLive(currentGen);

    const metaSnap = await get(ref(db, `rooms/${priorRoomId}/meta`));
    this.assertRestorationLive(currentGen);

    if (metaSnap.exists()) {
      const meta = metaSnap.val();
      const now = this.session.serverNow();

      if (meta.hostUid === hostUid && meta.expiresAtMs < now - 3_600_000) {
        await remove(ref(db, `rooms/${priorRoomId}`));
        this.assertRestorationLive(currentGen);
      }

      if (meta.hostUid === hostUid && meta.status === 'open' && meta.expiresAtMs > now) {
        const leaseSnap = await get(ref(db, `rooms/${priorRoomId}/lease`));
        this.assertRestorationLive(currentGen);

        if (!leaseSnap.exists()) {
          // Metadata-only bootstrap with no lease: rules require initial lease to match meta.leaseOwnerId at epoch 1
          const initialOwnerId =
            typeof meta.leaseOwnerId === 'string' && meta.leaseOwnerId.length >= 4
              ? meta.leaseOwnerId
              : this.runtimeId;
          const claimNow = this.session.serverNow();
          await set(ref(db, `rooms/${priorRoomId}/lease`), {
            ownerId: initialOwnerId,
            hostUid,
            epoch: 1,
            acquiredAtMs: claimNow,
            expiresAtMs: claimNow + Math.min(this.leaseTtlMs, 15_000),
          });
          this.assertRestorationLive(currentGen);

          const closeNow = this.session.serverNow();
          await update(ref(db, `rooms/${priorRoomId}/meta`), {
            status: 'closed',
            closedReason: 'تم إغلاق الغرفة غير المكتملة بواسطة الهوست',
            updatedAtMs: closeNow,
            leaseOwnerId: initialOwnerId,
          });
          this.assertRestorationLive(currentGen);
        } else {
          let leaseVal = leaseSnap.val();
          let currentNow = this.session.serverNow();

          if (leaseVal.ownerId === this.runtimeId && leaseVal.expiresAtMs > currentNow) {
            await update(ref(db, `rooms/${priorRoomId}/meta`), {
              status: 'closed',
              closedReason: 'تم فتح غرفة جديدة بواسطة الهوست',
              updatedAtMs: currentNow,
              leaseOwnerId: this.runtimeId,
            });
            this.assertRestorationLive(currentGen);
          } else {
            const initialExpiresAtMs = Number(leaseVal.expiresAtMs ?? 0);
            const initialEpoch = Number(leaseVal.epoch ?? 1);

            if (leaseVal.expiresAtMs > currentNow) {
              // Wait up to leaseTtlMs + 600ms (bounded) to see if prior runtime is stopped/disposed or actively renewing
              const maxWaitMs = Math.min(this.leaseTtlMs + 600, 3_500);
              const startWait = Date.now();
              while (leaseVal.expiresAtMs > currentNow && Date.now() - startWait < maxWaitMs) {
                this.assertRestorationLive(currentGen);
                await new Promise((r) => setTimeout(r, 120));
                this.assertRestorationLive(currentGen);

                const freshLeaseSnap = await get(ref(db, `rooms/${priorRoomId}/lease`));
                this.assertRestorationLive(currentGen);
                if (!freshLeaseSnap.exists()) break;
                leaseVal = freshLeaseSnap.val();
                currentNow = this.session.serverNow();

                if (
                  Number(leaseVal.expiresAtMs ?? 0) > initialExpiresAtMs ||
                  Number(leaseVal.epoch ?? 1) > initialEpoch
                ) {
                  // Actively renewed by a live execution owner! Cannot preempt or abandon.
                  throw new Error('يوجد هوست نشط آخر يدير الغرفة الحالية');
                }
              }

              if (leaseVal.expiresAtMs > currentNow) {
                throw new Error('يوجد هوست نشط آخر يدير الغرفة الحالية');
              }
            }

            currentNow = this.session.serverNow();
            if (currentNow - leaseVal.expiresAtMs > 60_000) {
              // Expired > 60s ago: rules permit direct closure without acquiring a new lease
              await update(ref(db, `rooms/${priorRoomId}/meta`), {
                status: 'closed',
                closedReason: 'تم إغلاق الغرفة السابقة بعد انتهاء المهلة',
                updatedAtMs: currentNow,
                leaseOwnerId: this.runtimeId,
              });
              this.assertRestorationLive(currentGen);
            } else {
              // Claim expired lease with next epoch to authorize closure
              const nextEpoch = (leaseVal.epoch ?? 1) + 1;
              await set(ref(db, `rooms/${priorRoomId}/lease`), {
                ownerId: this.runtimeId,
                hostUid,
                epoch: nextEpoch,
                acquiredAtMs: currentNow,
                expiresAtMs: currentNow + Math.min(this.leaseTtlMs, 15_000),
              });
              this.assertRestorationLive(currentGen);

              const closeNow = this.session.serverNow();
              await update(ref(db, `rooms/${priorRoomId}/meta`), {
                status: 'closed',
                closedReason: 'تم فتح غرفة جديدة بواسطة الهوست',
                updatedAtMs: closeNow,
                leaseOwnerId: this.runtimeId,
              });
              this.assertRestorationLive(currentGen);
            }
          }
        }
      }
    }

    // Targeted client-assisted code cleanup: remove `codes/$priorCode` ONLY if it still maps to `priorRoomId`
    if (priorCode && /^[A-Z0-9]{5}$/.test(priorCode)) {
      const codeRef = ref(db, `codes/${priorCode}`);
      const codeSnap = await get(codeRef);
      this.assertRestorationLive(currentGen);
      if (
        codeSnap.exists() &&
        codeSnap.val()?.roomId === priorRoomId &&
        codeSnap.val()?.hostUid === hostUid
      ) {
        const unsubCode = onValue(codeRef, () => {});
        try {
          await get(codeRef);
          this.assertRestorationLive(currentGen);
          await runTransaction(
            codeRef,
            (curr) => {
              if (!curr) return null;
              if (curr.roomId === priorRoomId && curr.hostUid === hostUid) {
                return null;
              }
              return undefined;
            },
            { applyLocally: false },
          ).catch(() => {});
        } finally {
          unsubCode();
        }
        this.assertRestorationLive(currentGen);
      }
    }
  }

  /**
   * Performs the supported staged room bootstrap under client security rules:
   * 0. Reconcile any prior `hosts/$uid/activeRoom` and write durable CAS intent pointer
   * 1. Write `meta` matching `activeRoom`
   * 2. Write `lease` (epoch 1) and start early lease renewal / observer
   * 3. Reserve host `memberSlots/1`
   * 4. Atomically publish initial `snapshot`, host member, host view, and `heartbeat`
   * 5. Publish public `codes/$code` mapping (retrying cleanly on collision)
   */
  async createRoom(
    nickname: string,
    config?: Partial<MatchConfig>,
  ): Promise<BootstrapRoomResult> {
    if (this.disposed) {
      throw new Error('Host runtime is disposed');
    }
    this.isRestoring = true;
    this.isStopped = false;
    const currentGen = ++this.generation;
    this.assertRestorationLive(currentGen);

    let unsubActiveRoom: Unsubscribe | null = null;

    try {
      const authCtx = await this.session.ensureAuth();
      this.assertRestorationLive(currentGen);
      const hostUid = authCtx.uid;
      this.hostUid = hostUid;
      const db = authCtx.database;

      const activeRoomRef = ref(db, `hosts/${hostUid}/activeRoom`);
      // Keep activeRoom synced in local SDK cache during createRoom so CAS transactions see exact current state
      unsubActiveRoom = onValue(activeRoomRef, () => {});

      const activeSnap = await get(activeRoomRef);
      this.assertRestorationLive(currentGen);

      let expectedPrevRoomId: string | null = null;
      if (activeSnap.exists() && activeSnap.val()?.roomId) {
        const priorRoomId = String(activeSnap.val().roomId);
        const priorCode = typeof activeSnap.val().code === 'string' ? String(activeSnap.val().code) : '';
        expectedPrevRoomId = priorRoomId;
        await this.reconcilePriorActiveRoom(db, hostUid, priorRoomId, priorCode, currentGen);
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        this.assertRestorationLive(currentGen);

        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.leaseUnsub) {
          this.leaseUnsub();
          this.leaseUnsub = null;
        }
        this.acquiredAtMs = 0;
        this.leaseExpiresAtMs = 0;

        this.committedViewSignatures.clear();
        this.projectionFormat = 2;
        this.store = new MemoryStore();
        this.engine = new MatchEngine(this.store, this.contentSource, {
          transferHostOnLeave: false,
          now: () => this.session.serverNow(),
          rng: () => Math.random(),
        });
        const candidateResult = await this.engine.createRoom(nickname, config);
        this.assertRestorationLive(currentGen);

        const candidateCode = candidateResult.state.code;
        const codeCheck = await get(ref(db, `codes/${candidateCode}`));
        this.assertRestorationLive(currentGen);

        const checkNow = this.session.serverNow();
        if (codeCheck.exists() && codeCheck.val()?.expiresAtMs > checkNow) {
          const existingRoomId = String(codeCheck.val()?.roomId || '');
          let codeOccupied = true;
          if (existingRoomId.length >= 10) {
            try {
              const existingMetaSnap = await get(ref(db, `rooms/${existingRoomId}/meta`));
              this.assertRestorationLive(currentGen);
              if (
                !existingMetaSnap.exists() ||
                existingMetaSnap.val()?.status === 'closed' ||
                existingMetaSnap.val()?.expiresAtMs <= this.session.serverNow()
              ) {
                codeOccupied = false;
              }
            } catch {
              codeOccupied = true;
            }
          }
          if (codeOccupied) {
            continue;
          }
        }

        const candidateRoomId = `room_${nanoid(16).replace(/[^A-Za-z0-9_-]/g, 'a')}`;
        const intentNow = this.session.serverNow();

        // Stage 0: Durable CAS intent at hosts/$uid/activeRoom BEFORE writing room metadata
        const txResult = await runTransaction(
          activeRoomRef,
          (current) => {
            if (this.disposed || this.isStopped || this.generation !== currentGen) {
              return undefined;
            }
            if (current !== null && typeof current === 'object') {
              const currRoomId = (current as { roomId?: unknown }).roomId;
              if (
                typeof currRoomId === 'string' &&
                currRoomId !== expectedPrevRoomId &&
                currRoomId !== candidateRoomId
              ) {
                return undefined;
              }
            } else if (expectedPrevRoomId !== null && current === null) {
              return undefined;
            }
            return {
              roomId: candidateRoomId,
              code: candidateCode,
              updatedAtMs: intentNow,
            };
          },
          { applyLocally: false },
        );
        this.assertRestorationLive(currentGen);
        if (!txResult.committed) {
          throw new Error('تم استبدال عملية إنشاء الغرفة بعملية أحدث');
        }
        expectedPrevRoomId = candidateRoomId;

        const bootstrapNow = this.session.serverNow();
        const expiresAtMs = bootstrapNow + SIX_HOURS_MS - 5_000;
        const hostPlayerId = candidateResult.playerId;

        this.code = candidateCode;
        this.roomId = candidateRoomId;
        this.hostPlayerId = hostPlayerId;
        this.epoch = 1;
        this.acquiredAtMs = bootstrapNow;
        this.leaseExpiresAtMs = bootstrapNow + this.leaseTtlMs;

        this.uidToPlayerId.clear();
        this.playerIdToUid.clear();
        this.uidToSlot.clear();
        this.occupiedSlots.clear();
        this.uidToPlayerId.set(hostUid, hostPlayerId);
        this.playerIdToUid.set(hostPlayerId, hostUid);
        this.uidToSlot.set(hostUid, '1');
        this.occupiedSlots.set('1', hostUid);

        // Stage 1: Room meta (memberCount: 1, admittedCount: 1)
        const initialMeta: RoomMetaCache = {
          code: candidateCode,
          hostUid,
          createdAtMs: bootstrapNow,
          expiresAtMs,
          phase: 'lobby',
          status: 'open',
          memberCount: 1,
          admittedCount: 1,
          updatedAtMs: bootstrapNow,
          leaseOwnerId: this.runtimeId,
        };
        await set(ref(db, `rooms/${candidateRoomId}/meta`), initialMeta);
        this.cachedMeta = initialMeta;
        this.assertRestorationLive(currentGen);

        // Stage 2: Acquire execution lease (epoch 1) and start early renewal/observation
        await set(ref(db, `rooms/${candidateRoomId}/lease`), {
          ownerId: this.runtimeId,
          hostUid,
          epoch: this.epoch,
          acquiredAtMs: this.acquiredAtMs,
          expiresAtMs: this.leaseExpiresAtMs,
        });
        this.assertRestorationLive(currentGen);

        this.startHeartbeatLoop(db);
        this.startLeaseObserver(db);

        // Stage 2b: Reserve immutable host slot '1'
        const slotNow = this.session.serverNow();
        await set(ref(db, `rooms/${candidateRoomId}/memberSlots/1`), {
          slot: '1',
          uid: hostUid,
          assignedAtMs: slotNow,
          leaseOwnerId: this.runtimeId,
        });
        this.assertRestorationLive(currentGen);

        // Stage 3: Atomically publish initial snapshot envelope, host member record, host view, and heartbeat
        const categories = await this.contentSource.categories();
        this.assertRestorationLive(currentGen);
        const publishNow = this.session.serverNow();
        const hostView = toView(candidateResult.state, hostPlayerId, categories, publishNow);
        const hostPlayer = candidateResult.state.players.find((p) => p.id === hostPlayerId);
        const hostNickname = hostPlayer ? hostPlayer.nickname : nickname;

        await this.publishRoomUpdate(db, {
          heartbeat: {
            lastSeenAtMs: publishNow,
            connected: true,
            leaseOwnerId: this.runtimeId,
          },
          [`members/${hostUid}`]: {
            uid: hostUid,
            slot: '1',
            playerId: hostPlayerId,
            nickname: hostNickname,
            role: 'host',
            joinedAtMs: publishNow,
            leaseOwnerId: this.runtimeId,
          },
          snapshot: this.createSnapshotRecord(candidateResult.state, publishNow),
          [`views/${hostUid}`]: {
            slot: '1',
            json: JSON.stringify(hostView),
            version: candidateResult.state.version,
            updatedAtMs: publishNow,
            leaseOwnerId: this.runtimeId,
          },
        });
        this.assertRestorationLive(currentGen);

        // Stage 4: Expose public room code mapping (checking for check-to-publish race)
        const codeNow = this.session.serverNow();
        const codeExpiresAtMs = Math.min(expiresAtMs, codeNow + SIX_HOURS_MS - 5_000);
        let codePublished = false;
        try {
          const prePubSnap = await get(ref(db, `codes/${candidateCode}`));
          this.assertRestorationLive(currentGen);
          if (
            prePubSnap.exists() &&
            prePubSnap.val()?.roomId !== candidateRoomId &&
            prePubSnap.val()?.expiresAtMs > codeNow
          ) {
            const raceRoomId = String(prePubSnap.val()?.roomId || '');
            const raceMetaSnap = raceRoomId ? await get(ref(db, `rooms/${raceRoomId}/meta`)) : null;
            this.assertRestorationLive(currentGen);
            if (
              raceMetaSnap &&
              raceMetaSnap.exists() &&
              raceMetaSnap.val()?.status === 'open' &&
              raceMetaSnap.val()?.expiresAtMs > this.session.serverNow()
            ) {
              codePublished = false;
            } else {
              await set(ref(db, `codes/${candidateCode}`), {
                roomId: candidateRoomId,
                hostUid,
                createdAtMs: codeNow,
                expiresAtMs: codeExpiresAtMs,
              });
              codePublished = true;
            }
          } else {
            await set(ref(db, `codes/${candidateCode}`), {
              roomId: candidateRoomId,
              hostUid,
              createdAtMs: codeNow,
              expiresAtMs: codeExpiresAtMs,
            });
            codePublished = true;
          }
        } catch {
          codePublished = false;
        }
        this.assertRestorationLive(currentGen);

        if (!codePublished) {
          // Another creator won the code between check and publish; close unexposed bootstrap and retry
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
          }
          const leaseUnsub = this.leaseUnsub as (() => void) | null;
          this.leaseUnsub = null;
          if (leaseUnsub) {
            leaseUnsub();
          }
          this.acquiredAtMs = 0;
          this.leaseExpiresAtMs = 0;
          await update(ref(db, `rooms/${candidateRoomId}/meta`), {
            status: 'closed',
            closedReason: 'تعارض في الكود أثناء الإنشاء',
            updatedAtMs: this.session.serverNow(),
            leaseOwnerId: this.runtimeId,
          });
          this.assertRestorationLive(currentGen);
          continue;
        }

        this.assertRestorationLive(currentGen);
        if (!this.isLive()) {
          throw new Error('Host bootstrap preempted before completion');
        }

        this.notifyCommittedView(hostView);

        // Start remaining background loops
        this.startEngineTickLoop(db);
        this.startInboxes(db);

        return {
          code: candidateCode,
          roomId: candidateRoomId,
          playerId: hostPlayerId,
          token: candidateResult.token,
        };
      }

      throw new Error('تعذر حجز كود غرفة متاح حالياً — جرب تاني');
    } catch (err) {
      this.stopExecution(err instanceof Error ? err.message : 'فشل إنشاء الغرفة');
      throw err;
    } finally {
      this.isRestoring = false;
      if (unsubActiveRoom) {
        try {
          unsubActiveRoom();
        } catch {}
      }
    }
  }

  /**
   * Resumes host execution for an existing room after page refresh, temporary host disconnect,
   * or automatic host transfer to an admitted member when the previous host's lease has expired.
   */
  async resumeHost(
    roomId: string,
    code: string,
    options?: { maxWaitMs?: number; allowTakeover?: boolean },
  ): Promise<BootstrapRoomResult> {
    if (this.disposed) {
      throw new Error('Host runtime is disposed');
    }
    this.isRestoring = true;
    this.isStopped = false;
    const currentGen = ++this.generation;
    this.assertRestorationLive(currentGen);

    try {
      const authCtx = await this.session.ensureAuth();
      this.assertRestorationLive(currentGen);
      this.hostUid = authCtx.uid;
      const db = authCtx.database;

      this.roomId = roomId;
      this.code = code;

      // 1. Read room meta first to check room validity and host identity
      const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
      this.assertRestorationLive(currentGen);

      if (!metaSnap.exists() || metaSnap.val().status === 'closed') {
        throw new Error('الغرفة مقفولة أو مش موجودة');
      }
      const metaVal = metaSnap.val() as RoomMetaCache;
      const previousHostUid = String(metaVal.hostUid);
      const isMemberTakeover = previousHostUid !== this.hostUid;
      if (isMemberTakeover && !options?.allowTakeover) {
        throw new Error('أنت لست الهوست لهذه الغرفة');
      }

      const now = this.session.serverNow();
      if (metaVal.expiresAtMs <= now) {
        throw new Error('انتهت صلاحية الغرفة');
      }

      // Read lease (non-host member takeover can only read lease once it is expired per security rules)
      let leaseSnap;
      try {
        leaseSnap = await get(ref(db, `rooms/${roomId}/lease`));
      } catch {
        throw new Error('يوجد هوست نشط آخر يدير هذه الغرفة حالياً');
      }
      this.assertRestorationLive(currentGen);

      // 2. Lease acquisition / recovery
      let leaseVal = leaseSnap.val();
      if (!leaseVal) {
        throw new Error('بيانات الحجز غير موجودة');
      }

      let currentServerNow = this.session.serverNow();

      if (leaseVal.ownerId === this.runtimeId && leaseVal.expiresAtMs > currentServerNow) {
        // Continuing under same runtime lease
        this.epoch = leaseVal.epoch;
        this.acquiredAtMs = leaseVal.acquiredAtMs;
        this.leaseExpiresAtMs = currentServerNow + this.leaseTtlMs;
        this.cachedMeta = metaVal;
      } else {
        // Foreign lease owner: check if currently unexpired
        if (leaseVal.expiresAtMs > currentServerNow) {
          if (isMemberTakeover) {
            throw new Error('يوجد هوست نشط آخر يدير هذه الغرفة حالياً');
          }
          // Bounded wait for stale lease expiry in slices to react immediately to disposal or disconnect
          const maxWaitMs = options?.maxWaitMs ?? 10_000;
          const startTime = Date.now();
          while (leaseVal.expiresAtMs > currentServerNow && Date.now() - startTime < maxWaitMs) {
            const remaining = maxWaitMs - (Date.now() - startTime);
            const waitMs = Math.min(Math.max(leaseVal.expiresAtMs - currentServerNow + 200, 300), remaining);
            if (waitMs <= 0) break;
            const checkIntervalMs = 100;
            let elapsed = 0;
            while (elapsed < waitMs) {
              this.assertRestorationLive(currentGen);
              const slice = Math.min(checkIntervalMs, waitMs - elapsed);
              await new Promise((resolve) => setTimeout(resolve, slice));
              elapsed += slice;
              this.assertRestorationLive(currentGen);
            }

            const freshLeaseSnap = await get(ref(db, `rooms/${roomId}/lease`));
            this.assertRestorationLive(currentGen);
            if (!freshLeaseSnap.exists()) {
              throw new Error('بيانات الحجز غير موجودة');
            }
            leaseVal = freshLeaseSnap.val();
            currentServerNow = this.session.serverNow();
          }

          if (leaseVal.expiresAtMs > currentServerNow) {
            throw new Error('يوجد هوست نشط آخر يدير هذه الغرفة حالياً');
          }
        }

        if (leaseVal.expiresAtMs <= currentServerNow && currentServerNow - leaseVal.expiresAtMs <= 60_000) {
          // Prior lease expired within 60s recovery window -> claim with next epoch
          this.assertRestorationLive(currentGen);
          this.epoch = (leaseVal.epoch ?? 1) + 1;
          this.acquiredAtMs = currentServerNow;
          this.leaseExpiresAtMs = currentServerNow + this.leaseTtlMs;

          await set(ref(db, `rooms/${roomId}/lease`), {
            ownerId: this.runtimeId,
            hostUid: this.hostUid,
            epoch: this.epoch,
            acquiredAtMs: this.acquiredAtMs,
            expiresAtMs: this.leaseExpiresAtMs,
          });
          this.assertRestorationLive(currentGen);

          // Update meta.leaseOwnerId (and meta.hostUid if a member took over) to match successor runtime
          const metaPatch: Record<string, unknown> = {
            leaseOwnerId: this.runtimeId,
            updatedAtMs: currentServerNow,
          };
          if (isMemberTakeover) {
            metaPatch.hostUid = this.hostUid;
          }
          await update(ref(db, `rooms/${roomId}/meta`), metaPatch);
          this.cachedMeta = {
            ...metaVal,
            hostUid: isMemberTakeover ? this.hostUid : metaVal.hostUid,
            leaseOwnerId: this.runtimeId,
            updatedAtMs: currentServerNow,
          };
          this.assertRestorationLive(currentGen);
        } else {
          throw new Error('انتهت مهلة استعادة الغرفة (60 ثانية)');
        }
      }

      this.assertRestorationLive(currentGen);

      // Start lease observer and heartbeat renewal early so live ownership is observed and maintained during restoration
      this.startHeartbeatLoop(db);
      this.startLeaseObserver(db);

      // 3. REREAD canonical state (snapshot, memberSlots, members) AFTER acquiring ownership!
      // This ensures any command or admission committed by predecessor during the wait is included.
      const [snapSnap, slotsSnap, membersSnap] = await Promise.all([
        get(ref(db, `rooms/${roomId}/snapshot`)),
        get(ref(db, `rooms/${roomId}/memberSlots`)),
        get(ref(db, `rooms/${roomId}/members`)),
      ]);
      this.assertRestorationLive(currentGen);

      if (!snapSnap.exists() || !snapSnap.val().json) {
        throw new Error('بيانات الغرفة المحفوظة غير صالحة');
      }

      this.uidToPlayerId.clear();
      this.playerIdToUid.clear();
      this.uidToSlot.clear();
      this.occupiedSlots.clear();

      const parsedSnap = JSON.parse(snapSnap.val().json);
      this.projectionFormat = parsedSnap?.projectionFormat === 2 ? 2 : 1;
      let savedRoomState: RoomState;
      if (parsedSnap && parsedSnap.envelopeVersion === 1) {
        savedRoomState = parsedSnap.state;
        if (parsedSnap.dedup) {
          this.dedup.fromJSON(parsedSnap.dedup);
        }
        for (const b of parsedSnap.bindings || []) {
          if (b && b.uid && b.playerId) {
            this.uidToPlayerId.set(b.uid, b.playerId);
            this.playerIdToUid.set(b.playerId, b.uid);
            if (b.slot) this.uidToSlot.set(b.uid, b.slot);
          }
        }
        for (const os of parsedSnap.occupiedSlots || []) {
          if (os && os.slot && os.uid) {
            this.occupiedSlots.set(os.slot, os.uid);
          }
        }
      } else {
        savedRoomState = parsedSnap as RoomState;
      }

      // Reconcile ALL memberSlots from RTDB unconditionally
      if (slotsSnap.exists()) {
        const slotsVal = slotsSnap.val() as Record<string, { slot: string; uid: string }>;
        for (const item of Object.values(slotsVal)) {
          if (item && item.slot && item.uid) {
            this.occupiedSlots.set(item.slot, item.uid);
            this.uidToSlot.set(item.uid, item.slot);
          }
        }
      }

      if (membersSnap.exists()) {
        const membersVal = membersSnap.val() as Record<string, { uid: string; playerId: string; role: string; slot?: string }>;
        for (const m of Object.values(membersVal)) {
          if (m && m.uid && m.playerId) {
            if (!this.uidToPlayerId.has(m.uid)) {
              this.uidToPlayerId.set(m.uid, m.playerId);
              this.playerIdToUid.set(m.playerId, m.uid);
            }
            if (m.slot && !this.uidToSlot.has(m.uid)) {
              this.uidToSlot.set(m.uid, m.slot);
            }
          }
        }
      }
      this.hostPlayerId = this.uidToPlayerId.get(this.hostUid) ?? null;

      if (isMemberTakeover) {
        if (!this.hostPlayerId) {
          throw new Error('اللاعب غير مسجل في الغرفة');
        }
        savedRoomState.hostId = this.hostPlayerId;
        const oldHostPlayerId = this.uidToPlayerId.get(previousHostUid);
        if (oldHostPlayerId) {
          const oldHostPlayer = savedRoomState.players.find((p: RoomPlayer) => p.id === oldHostPlayerId);
          if (oldHostPlayer && oldHostPlayer.connected) {
            oldHostPlayer.connected = false;
            oldHostPlayer.disconnectedAtMs = currentServerNow;
          }
        }
        const promotedPlayer = savedRoomState.players.find((p: RoomPlayer) => p.id === this.hostPlayerId);
        if (promotedPlayer && !promotedPlayer.connected) {
          promotedPlayer.connected = true;
          promotedPlayer.disconnectedAtMs = null;
        }
        savedRoomState.version += 1;
      }

      this.committedViewSignatures.clear();
      this.store = new MemoryStore();
      await this.store.create(savedRoomState);
      this.assertRestorationLive(currentGen);

      this.engine = new MatchEngine(this.store, this.contentSource, {
        transferHostOnLeave: false,
        now: () => this.session.serverNow(),
        rng: () => Math.random(),
      });

      let hostToken = '';
      const hostPlayer = savedRoomState.players.find((p: RoomPlayer) => p.id === this.hostPlayerId);
      if (hostPlayer) {
        hostToken = hostPlayer.token;
      }

      if (isMemberTakeover && this.hostPlayerId) {
        // Trigger connected check in engine so any round waiting only on the disconnected old host advances immediately
        await this.engine.setConnected(code, this.hostPlayerId, true);
        this.assertRestorationLive(currentGen);

        const roleUpdates: Record<string, unknown> = {
          [`members/${this.hostUid}/role`]: 'host',
          [`members/${this.hostUid}/leaseOwnerId`]: this.runtimeId,
        };
        if (membersSnap.exists() && membersSnap.val()?.[previousHostUid]) {
          roleUpdates[`members/${previousHostUid}/role`] = 'guest';
          roleUpdates[`members/${previousHostUid}/leaseOwnerId`] = this.runtimeId;
        }
        await update(ref(db, `rooms/${roomId}`), roleUpdates);
        this.assertRestorationLive(currentGen);
      }

      // 4. Check and execute any overdue deadlines from the saved state using fresh server time
      const freshNow = this.session.serverNow();
      if (savedRoomState.phaseEndsAtMs !== null && freshNow >= savedRoomState.phaseEndsAtMs) {
        await this.engine.tick(freshNow);
        this.assertRestorationLive(currentGen);
        await this.publishEngineState(db);
        this.assertRestorationLive(currentGen);
      } else if (isMemberTakeover) {
        await this.publishEngineState(db);
        this.assertRestorationLive(currentGen);
      } else {
        const categories = await this.contentSource.categories();
        this.assertRestorationLive(currentGen);
        const currentState = await this.store.get(code);
        this.assertRestorationLive(currentGen);
        if (currentState && this.hostPlayerId) {
          const hostView = toView(currentState, this.hostPlayerId, categories, freshNow);
          this.notifyCommittedView(hostView);
        }
      }

      this.assertRestorationLive(currentGen);
      if (!this.isLive()) {
        throw new Error('Host restoration preempted: lease expired or disconnected before completion');
      }

      // Start remaining background loops
      this.startEngineTickLoop(db);
      this.startInboxes(db);

      return {
        code,
        roomId,
        playerId: this.hostPlayerId!,
        token: hostToken,
      };
    } catch (err) {
      this.stopExecution(err instanceof Error ? err.message : 'فشل استعادة الهوست');
      throw err;
    } finally {
      this.isRestoring = false;
    }
  }

  private startHeartbeatLoop(db: Database): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(async () => {
      if (this.disposed || !this.roomId) return;
      if (!this.session.getIsConnected()) return;

      const now = this.session.serverNow();
      if (now >= this.leaseExpiresAtMs) {
        // Lease expired
        this.stopExecution('انتهت صلاحية الحجز');
        return;
      }

      const nextExpiresAtMs = now + this.leaseTtlMs;
      try {
        await Promise.all([
          set(ref(db, `rooms/${this.roomId}/lease`), {
            ownerId: this.runtimeId,
            hostUid: this.hostUid,
            epoch: this.epoch,
            acquiredAtMs: this.acquiredAtMs,
            expiresAtMs: nextExpiresAtMs,
          }),
          set(ref(db, `rooms/${this.roomId}/heartbeat`), {
            lastSeenAtMs: now,
            connected: true,
            leaseOwnerId: this.runtimeId,
          }),
        ]);
        // Advance local lease expiry ONLY after server commit succeeds!
        this.leaseExpiresAtMs = nextExpiresAtMs;
      } catch (err) {
        // Failed renewal means lost lease or lost connection
        this.stopExecution('فشل تجديد الحجز مع قاعدة البيانات');
      }
    }, this.heartbeatIntervalMs);
  }

  private startEngineTickLoop(db: Database): void {
    if (this.tickTimer) return;

    this.tickTimer = setInterval(() => {
      if (this.disposed || !this.roomId || !this.code || !this.engine || !this.isLive()) return;

      this.enqueue(async () => {
        const currentGen = this.generation;
        this.assertLive(currentGen);
        if (!this.engine || !this.code || !this.roomId || this.disposed) return;
        const state = await this.store.get(this.code);
        this.assertLive(currentGen);
        if (!state) return;

        const now = this.session.serverNow();
        let changed = false;

        // 1. Phase timer transition
        if (state.phaseEndsAtMs !== null && now >= state.phaseEndsAtMs) {
          await this.engine.tick(now);
          this.assertLive(currentGen);
          changed = true;
        }

        // 2. Disconnected seat grace deadline reaping (only when an actual seat is due)
        const disconnectedDue = state.players.some(
          (p: RoomPlayer) => !p.connected && !p.leftEarly && p.disconnectedAtMs !== null && now >= p.disconnectedAtMs + 90_000,
        );
        if (disconnectedDue) {
          const afterReap = await this.engine.reapDisconnected(this.code, now);
          this.assertLive(currentGen);
          if (afterReap && afterReap.version !== state.version) {
            changed = true;
          }
        }

        if (changed) {
          this.assertLive(currentGen);
          await this.publishEngineState(db);
          this.assertLive(currentGen);
        }
      }).catch(() => {});
    }, 250);
  }

  private startInboxes(db: Database): void {
    if (!this.roomId) return;

    // 0. Room Meta Cache Subscription
    const metaRef = ref(db, `rooms/${this.roomId}/meta`);
    this.metaUnsub = onValue(metaRef, (snap) => {
      if (this.disposed || !snap.exists()) return;
      this.cachedMeta = snap.val() as RoomMetaCache;
    });

    // 1. Join Requests Inbox
    const joinReqRef = ref(db, `rooms/${this.roomId}/joinRequests`);
    this.joinRequestsUnsub = onValue(joinReqRef, (snap) => {
      if (this.disposed || !this.isLive()) return;
      this.latestJoinRequests.clear();
      if (!snap.exists()) return;
      const val = snap.val() as Record<string, unknown>;
      const receivedAtMs = Date.now();
      for (const [slotKey, reqData] of Object.entries(val)) {
        if (reqData && typeof reqData === 'object') {
          const req = reqData as {
            commandId: string;
            uid: string;
            nickname: string;
            expiresAtMs: number;
          };
          this.latestJoinRequests.set(slotKey, req);
          this.enqueue(() => this.processJoinRequest(db, slotKey, req, receivedAtMs)).catch(() => {});
        }
      }
    });

    // 2. Member Commands Inbox
    const commandsRef = ref(db, `rooms/${this.roomId}/commands`);
    this.commandsUnsub = onValue(commandsRef, (snap) => {
      if (this.disposed || !this.isLive()) return;
      this.latestCommands.clear();
      if (!snap.exists()) return;
      const val = snap.val() as Record<string, unknown>;
      const receivedAtMs = Date.now();
      for (const [uid, cmdData] of Object.entries(val)) {
        if (cmdData && typeof cmdData === 'object') {
          const cmd = cmdData as {
            commandId: string;
            uid: string;
            type: string;
            payloadJson: string;
            expiresAtMs: number;
            roundNo?: number;
          };
          this.latestCommands.set(uid, cmd);
          this.enqueue(() => this.processMemberCommand(db, uid, cmd, receivedAtMs)).catch(() => {});
        }
      }
    });

    // 3. Member Presence
    const presenceRef = ref(db, `rooms/${this.roomId}/presence`);
    this.presenceUnsub = onValue(presenceRef, (snap) => {
      if (this.disposed || !snap.exists() || !this.engine || !this.code || !this.isLive()) return;
      const val = snap.val() as Record<string, { uid: string; connected: boolean }>;
      this.enqueue(async () => {
        const currentGen = this.generation;
        this.assertLive(currentGen);
        if (!this.engine || !this.code || !this.roomId || this.disposed) return;
        let changed = false;
        for (const [uid, pData] of Object.entries(val)) {
          this.assertLive(currentGen);
          const playerId = this.uidToPlayerId.get(uid);
          if (playerId && typeof pData.connected === 'boolean') {
            const before = await this.store.get(this.code);
            this.assertLive(currentGen);
            const playerBefore = before?.players.find((p) => p.id === playerId);
            if (playerBefore && playerBefore.connected !== pData.connected) {
              await this.engine.setConnected(this.code, playerId, pData.connected);
              this.assertLive(currentGen);
              changed = true;
            }
          }
        }
        if (changed) {
          this.assertLive(currentGen);
          await this.publishEngineState(db);
          this.assertLive(currentGen);
        }
      }).catch(() => {});
    });
  }

  private async getRoomMeta(db: Database, currentGen: number): Promise<RoomMetaCache> {
    if (this.cachedMeta) {
      return this.cachedMeta;
    }
    const metaSnap = await get(ref(db, `rooms/${this.roomId}/meta`));
    this.assertLive(currentGen);
    const metaVal = metaSnap.val() as RoomMetaCache;
    this.cachedMeta = metaVal;
    return metaVal;
  }

  private async processJoinRequest(
    db: Database,
    reqSlot: string,
    req: { commandId: string; uid: string; nickname: string; expiresAtMs: number },
    receivedAtMs = 0,
  ): Promise<void> {
    const currentGen = this.generation;
    if (this.disposed || this.isStopped || !this.roomId || !this.code || !this.engine || !this.isLive() || this.generation !== currentGen) return;

    let currentJoinReq: { commandId: string; uid: string; nickname: string; expiresAtMs: number } | null = null;
    if (receivedAtMs > 0 && Date.now() - receivedAtMs < 15 && this.latestJoinRequests.get(reqSlot)?.commandId === req.commandId) {
      currentJoinReq = this.latestJoinRequests.get(reqSlot)!;
    } else {
      // Read current joinRequests/$reqSlot to ensure request was not cleared or replaced
      const currentJoinReqSnap = await get(ref(db, `rooms/${this.roomId}/joinRequests/${reqSlot}`));
      this.assertLive(currentGen);
      if (!currentJoinReqSnap.exists()) {
        return; // Request was cleared by client
      }
      currentJoinReq = currentJoinReqSnap.val();
    }
    if (!currentJoinReq || currentJoinReq.commandId !== req.commandId) {
      return; // Request was replaced in this slot
    }

    const now = this.session.serverNow();
    if (typeof currentJoinReq.expiresAtMs === 'number' && currentJoinReq.expiresAtMs <= now) {
      // Stale or expired request; rules reject ok: true after expiry anyway.
      // Publish explicit failure acknowledgement
      try {
        this.assertLive(currentGen);
        await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
          commandId: req.commandId,
          uid: req.uid,
          ok: false,
          error: 'انتهت مهلة طلب الانضمام',
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
      } catch {
        // Ignore
      }
      return;
    }

    const state = await this.store.get(this.code);
    this.assertLive(currentGen);
    if (!state) return;

    // Check if UID is already admitted (rejoin / replayed joinRequest idempotency)
    const existingPlayerId = this.uidToPlayerId.get(req.uid);
    if (existingPlayerId) {
      const player = state.players.find((p) => p.id === existingPlayerId);
      if (player) {
        const stateBackup = JSON.parse(JSON.stringify(state)) as RoomState;
        try {
          let nextState = state;
          if (!player.connected) {
            const connectedState = await this.engine.setConnected(this.code, existingPlayerId, true);
            this.assertLive(currentGen);
            if (connectedState) {
              nextState = connectedState;
            }
          }

          const catStartMs = Date.now();
          const categories = await this.contentSource.categories();
          const catElapsedMs = Date.now() - catStartMs;
          this.assertLive(currentGen);

          const metaVal = await this.getRoomMeta(db, currentGen);

          // Recheck joinRequest before atomic commit if async delay occurred
          let preWriteReq: { commandId?: string; expiresAtMs?: number } | null = null;
          let preWriteExists = true;
          if (catElapsedMs < 15 && receivedAtMs > 0 && Date.now() - receivedAtMs < 25) {
            const cachedReq = this.latestJoinRequests.get(reqSlot);
            preWriteExists = Boolean(cachedReq);
            preWriteReq = cachedReq ?? null;
          } else {
            const preWriteJoinSnap = await get(ref(db, `rooms/${this.roomId}/joinRequests/${reqSlot}`));
            this.assertLive(currentGen);
            preWriteExists = preWriteJoinSnap.exists();
            preWriteReq = preWriteJoinSnap.val();
          }
          const preWriteNow = this.session.serverNow();
          const preWriteExpiresAtMs =
            typeof preWriteReq?.expiresAtMs === 'number'
              ? preWriteReq.expiresAtMs
              : typeof req.expiresAtMs === 'number'
                ? req.expiresAtMs
                : undefined;

          if (
            !preWriteExists ||
            preWriteReq?.commandId !== req.commandId ||
            (preWriteExpiresAtMs !== undefined && preWriteExpiresAtMs <= preWriteNow)
          ) {
            await this.store.create(stateBackup);

            if (
              preWriteReq &&
              preWriteReq.commandId === req.commandId &&
              preWriteExpiresAtMs !== undefined &&
              preWriteExpiresAtMs <= preWriteNow
            ) {
              try {
                this.assertLive(currentGen);
                await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
                  commandId: req.commandId,
                  uid: req.uid,
                  ok: false,
                  error: 'انتهت مهلة طلب الانضمام',
                  processedAtMs: preWriteNow,
                  leaseOwnerId: this.runtimeId,
                });
              } catch {
                // Ignore response write error
              }
            }
            return;
          }

          const updates: Record<string, unknown> = {
            snapshot: this.createSnapshotRecord(nextState, now),
            [`members/${req.uid}/role`]: req.uid === this.hostUid ? 'host' : 'guest',
            [`members/${req.uid}/removed`]: false,
            [`members/${req.uid}/leaseOwnerId`]: this.runtimeId,
            [`joinResponses/${reqSlot}`]: {
              commandId: req.commandId,
              uid: req.uid,
              ok: true,
              dataJson: JSON.stringify({
                code: this.code,
                playerId: existingPlayerId,
                token: player.token,
              }),
              processedAtMs: now,
              leaseOwnerId: this.runtimeId,
            },
          };

          if (metaVal) {
            const nextMeta: RoomMetaCache = {
              code: this.code,
              hostUid: this.hostUid!,
              createdAtMs: metaVal.createdAtMs,
              expiresAtMs: metaVal.expiresAtMs,
              phase: nextState.phase,
              status: 'open',
              memberCount: nextState.players.length,
              admittedCount: metaVal.admittedCount,
              updatedAtMs: now,
              leaseOwnerId: this.runtimeId,
            };
            updates['meta'] = nextMeta;
            this.cachedMeta = nextMeta;
          }

          for (const p of nextState.players) {
            const pUid = this.playerIdToUid.get(p.id);
            const pSlot = pUid ? this.uidToSlot.get(pUid) : null;
            if (pUid && pSlot) {
              const view = toView(nextState, p.id, categories, now);
              updates[`views/${pUid}`] = {
                slot: pSlot,
                json: JSON.stringify(view),
                version: nextState.version,
                updatedAtMs: now,
                leaseOwnerId: this.runtimeId,
              };
            }
          }

          this.assertLive(currentGen);
          await this.publishRoomUpdate(db, updates);
          this.assertLive(currentGen);

          if (this.hostPlayerId) {
            const hostView = toView(nextState, this.hostPlayerId, categories, now);
            this.notifyCommittedView(hostView);
          }
          return;
        } catch (err) {
          try {
            await this.store.create(stateBackup);
          } catch {
            // Ignore rollback failure
          }

          if (this.disposed || this.generation !== currentGen || !this.isLive()) {
            return;
          }

          const message = err instanceof EngineError ? err.message : 'فشل الانضمام للغرفة';
          try {
            await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
              commandId: req.commandId,
              uid: req.uid,
              ok: false,
              error: message,
              processedAtMs: now,
              leaseOwnerId: this.runtimeId,
            });
          } catch {
            // Ignore response write error
          }
          return;
        }
      }
    }

    // Check capacity: max 8 active players
    if (state.players.length >= 8) {
      await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
        commandId: req.commandId,
        uid: req.uid,
        ok: false,
        error: 'الغرفة كاملة (8 لاعبين)',
        processedAtMs: now,
        leaseOwnerId: this.runtimeId,
      });
      return;
    }

    // Determine slot
    let slot = this.uidToSlot.get(req.uid);
    let isNewAdmission = false;

    if (!slot) {
      // Check 32 historical UID cap
      if (this.occupiedSlots.size >= 32) {
        await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
          commandId: req.commandId,
          uid: req.uid,
          ok: false,
          error: 'الغرفة وصلت للحد الأقصى من اللاعبين (32)',
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
        return;
      }

      // Find free slot '2'..'32'
      for (let s = 2; s <= 32; s += 1) {
        const key = String(s);
        if (!this.occupiedSlots.has(key)) {
          slot = key;
          break;
        }
      }

      if (!slot) {
        await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
          commandId: req.commandId,
          uid: req.uid,
          ok: false,
          error: 'لا توجد خانات متاحة للانضمام',
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
        return;
      }

      isNewAdmission = true;

      // Step A: Reserve immutable memberSlot before state publication
      await set(ref(db, `rooms/${this.roomId}/memberSlots/${slot}`), {
        slot,
        uid: req.uid,
        assignedAtMs: now,
        leaseOwnerId: this.runtimeId,
      });
      this.assertLive(currentGen);

      this.occupiedSlots.set(slot, req.uid);
      this.uidToSlot.set(req.uid, slot);
    } else {
      // Slot was already reserved (e.g. from prior interrupted attempt)
      // Check if UID is already in members table
      const membersSnap = await get(ref(db, `rooms/${this.roomId}/members/${req.uid}`));
      this.assertLive(currentGen);
      if (!membersSnap.exists()) {
        isNewAdmission = true;
      }
    }

    // Backup state and map structures for exact rollback on failure
    const stateBackup = JSON.parse(JSON.stringify(state)) as RoomState;
    const uidToPlayerIdBackup = new Map(this.uidToPlayerId);
    const playerIdToUidBackup = new Map(this.playerIdToUid);
    const uidToSlotBackup = new Map(this.uidToSlot);
    const occupiedSlotsBackup = new Map(this.occupiedSlots);

    try {
      // Execute engine join
      const joinResult = await this.engine.join(this.code, req.nickname);
      this.assertLive(currentGen);
      this.uidToPlayerId.set(req.uid, joinResult.playerId);
      this.playerIdToUid.set(joinResult.playerId, req.uid);

      const joinedPlayer = joinResult.state.players.find((p) => p.id === joinResult.playerId);
      const guestNickname = joinedPlayer ? joinedPlayer.nickname : req.nickname;

      // Step B: Atomically commit state, projections, metadata, membership, and joinResponse
      const catStartMs = Date.now();
      const categories = await this.contentSource.categories();
      const catElapsedMs = Date.now() - catStartMs;
      this.assertLive(currentGen);
      const metaVal = await this.getRoomMeta(db, currentGen);
      const admittedCount = isNewAdmission ? (metaVal.admittedCount ?? 1) + 1 : metaVal.admittedCount;

      // Recheck joinRequest before atomic commit
      let preWriteReq: { commandId?: string; expiresAtMs?: number } | null = null;
      let preWriteExists = true;
      if (catElapsedMs < 15 && receivedAtMs > 0 && Date.now() - receivedAtMs < 25) {
        const cachedReq = this.latestJoinRequests.get(reqSlot);
        preWriteExists = Boolean(cachedReq);
        preWriteReq = cachedReq ?? null;
      } else {
        const preWriteJoinSnap = await get(ref(db, `rooms/${this.roomId}/joinRequests/${reqSlot}`));
        this.assertLive(currentGen);
        preWriteExists = preWriteJoinSnap.exists();
        preWriteReq = preWriteJoinSnap.val();
      }
      const preWriteNow = this.session.serverNow();
      const preWriteExpiresAtMs = typeof preWriteReq?.expiresAtMs === 'number'
        ? preWriteReq.expiresAtMs
        : typeof req.expiresAtMs === 'number'
          ? req.expiresAtMs
          : undefined;

      if (
        !preWriteExists ||
        preWriteReq?.commandId !== req.commandId ||
        (preWriteExpiresAtMs !== undefined && preWriteExpiresAtMs <= preWriteNow)
      ) {
        await this.store.create(stateBackup);
        this.uidToPlayerId.clear();
        for (const [k, v] of uidToPlayerIdBackup) this.uidToPlayerId.set(k, v);
        this.playerIdToUid.clear();
        for (const [k, v] of playerIdToUidBackup) this.playerIdToUid.set(k, v);
        this.uidToSlot.clear();
        for (const [k, v] of uidToSlotBackup) this.uidToSlot.set(k, v);
        this.occupiedSlots.clear();
        for (const [k, v] of occupiedSlotsBackup) this.occupiedSlots.set(k, v);

        if (preWriteReq && preWriteReq.commandId === req.commandId && preWriteExpiresAtMs !== undefined && preWriteExpiresAtMs <= preWriteNow) {
          try {
            this.assertLive(currentGen);
            await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
              commandId: req.commandId,
              uid: req.uid,
              ok: false,
              error: 'انتهت مهلة طلب الانضمام',
              processedAtMs: preWriteNow,
              leaseOwnerId: this.runtimeId,
            });
          } catch {
            // Ignore response write error
          }
        }
        return;
      }

      const nextMeta: RoomMetaCache = {
        code: this.code,
        hostUid: this.hostUid!,
        createdAtMs: metaVal.createdAtMs,
        expiresAtMs: metaVal.expiresAtMs,
        phase: joinResult.state.phase,
        status: 'open',
        memberCount: joinResult.state.players.length,
        admittedCount,
        updatedAtMs: now,
        leaseOwnerId: this.runtimeId,
      };

      const updates: Record<string, unknown> = {
        meta: nextMeta,
        [`members/${req.uid}`]: {
          uid: req.uid,
          slot,
          playerId: joinResult.playerId,
          nickname: guestNickname,
          role: 'guest',
          joinedAtMs: now,
          leaseOwnerId: this.runtimeId,
        },
        snapshot: this.createSnapshotRecord(joinResult.state, now),
        [`joinResponses/${reqSlot}`]: {
          commandId: req.commandId,
          uid: req.uid,
          ok: true,
          dataJson: JSON.stringify({
            code: this.code,
            playerId: joinResult.playerId,
            token: joinResult.token,
          }),
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        },
      };

      for (const p of joinResult.state.players) {
        const pUid = this.playerIdToUid.get(p.id);
        const pSlot = pUid ? this.uidToSlot.get(pUid) : null;
        if (pUid && pSlot) {
          const view = toView(joinResult.state, p.id, categories, now);
          updates[`views/${pUid}`] = {
            slot: pSlot,
            json: JSON.stringify(view),
            version: joinResult.state.version,
            updatedAtMs: now,
            leaseOwnerId: this.runtimeId,
          };
        }
      }

      this.assertLive(currentGen);
      await this.publishRoomUpdate(db, updates);
      this.cachedMeta = nextMeta;
      this.assertLive(currentGen);

      if (this.hostPlayerId) {
        const hostView = toView(joinResult.state, this.hostPlayerId, categories, now);
        this.notifyCommittedView(hostView);
      }
    } catch (err) {
      // Unconditionally roll back in-memory engine state and map references exactly
      try {
        await this.store.create(stateBackup);
        this.uidToPlayerId.clear();
        for (const [k, v] of uidToPlayerIdBackup) this.uidToPlayerId.set(k, v);
        this.playerIdToUid.clear();
        for (const [k, v] of playerIdToUidBackup) this.playerIdToUid.set(k, v);
        this.uidToSlot.clear();
        for (const [k, v] of uidToSlotBackup) this.uidToSlot.set(k, v);
        this.occupiedSlots.clear();
        for (const [k, v] of occupiedSlotsBackup) this.occupiedSlots.set(k, v);
      } catch {
        // Ignore rollback failure
      }

      if (this.disposed || this.generation !== currentGen || !this.isLive()) {
        return;
      }

      const message = err instanceof EngineError ? err.message : 'فشل الانضمام للغرفة';
      try {
        await set(ref(db, `rooms/${this.roomId}/joinResponses/${reqSlot}`), {
          commandId: req.commandId,
          uid: req.uid,
          ok: false,
          error: message,
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
      } catch {
        // Ignore response write error
      }
    }
  }

  private async processMemberCommand(
    db: Database,
    uid: string,
    cmd: {
      commandId: string;
      uid: string;
      type: string;
      payloadJson: string;
      expiresAtMs: number;
      roundNo?: number;
    },
    receivedAtMs = 0,
  ): Promise<void> {
    const currentGen = this.generation;
    if (this.disposed || this.isStopped || !this.roomId || !this.code || !this.engine || !this.isLive() || this.generation !== currentGen) return;

    // 1. Inbox verification on entry: use live cache on immediate fast path, or read commands/${uid}
    let currentCmd: { commandId: string; expiresAtMs?: number } | null = null;
    if (receivedAtMs > 0 && Date.now() - receivedAtMs < 15 && this.latestCommands.get(uid)?.commandId === cmd.commandId) {
      currentCmd = this.latestCommands.get(uid)!;
    } else {
      const currentCmdSnap = await get(ref(db, `rooms/${this.roomId}/commands/${uid}`));
      this.assertLive(currentGen);
      if (!currentCmdSnap.exists()) {
        return; // Command was cleared by client
      }
      currentCmd = currentCmdSnap.val();
    }
    if (!currentCmd || currentCmd.commandId !== cmd.commandId) {
      return; // Command was replaced in this inbox
    }

    const now = this.session.serverNow();
    const slot = this.uidToSlot.get(uid);
    if (!slot) return;

    // Check expiry
    const cmdExpiresAtMs = typeof currentCmd.expiresAtMs === 'number' ? currentCmd.expiresAtMs : cmd.expiresAtMs;
    if (cmdExpiresAtMs <= now) {
      try {
        this.assertLive(currentGen);
        await set(ref(db, `rooms/${this.roomId}/responses/${uid}`), {
          slot,
          commandId: cmd.commandId,
          ok: false,
          error: 'انتهت صلاحية الأمر',
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
      } catch {
        // Ignore
      }
      if (uid === this.hostUid) {
        this.notifyCommittedAck({
          commandId: cmd.commandId,
          ok: false,
          error: 'انتهت صلاحية الأمر',
        });
      }
      return;
    }

    // Deduplication evaluation
    const dedupResult = this.dedup.evaluate(uid, cmd.commandId);
    if (dedupResult.action === 'replay') {
      const ack = dedupResult.ack;
      if (ack.ok) {
        const dataJson = typeof (ack as Record<string, unknown>).dataJson === 'string'
          ? ((ack as Record<string, unknown>).dataJson as string)
          : undefined;
        try {
          this.assertLive(currentGen);
          const replayRecord: Record<string, unknown> = {
            slot,
            commandId: cmd.commandId,
            ok: true,
            processedAtMs: now,
            leaseOwnerId: this.runtimeId,
          };
          if (dataJson) {
            replayRecord.dataJson = dataJson;
          }
          await set(ref(db, `rooms/${this.roomId}/responses/${uid}`), replayRecord);
          this.assertLive(currentGen);
          if (uid === this.hostUid) {
            this.notifyCommittedAck({
              commandId: cmd.commandId,
              ok: true,
              dataJson,
            });
          }
        } catch (err) {
          if (uid === this.hostUid) {
            this.notifyCommittedAck({
              commandId: cmd.commandId,
              ok: false,
              error: err instanceof Error ? err.message : 'فشل إعادة إرسال الرد',
            });
          }
        }
      } else {
        const errorMsg = ack.error || 'فشل تنفيذ الأمر';
        try {
          this.assertLive(currentGen);
          await set(ref(db, `rooms/${this.roomId}/responses/${uid}`), {
            slot,
            commandId: cmd.commandId,
            ok: false,
            error: errorMsg,
            processedAtMs: now,
            leaseOwnerId: this.runtimeId,
          });
          this.assertLive(currentGen);
          if (uid === this.hostUid) {
            this.notifyCommittedAck({
              commandId: cmd.commandId,
              ok: false,
              error: errorMsg,
            });
          }
        } catch (err) {
          if (uid === this.hostUid) {
            this.notifyCommittedAck({
              commandId: cmd.commandId,
              ok: false,
              error: err instanceof Error ? err.message : errorMsg,
            });
          }
        }
      }
      return;
    }

    if (dedupResult.action === 'reject') {
      try {
        this.assertLive(currentGen);
        await set(ref(db, `rooms/${this.roomId}/responses/${uid}`), {
          slot,
          commandId: cmd.commandId,
          ok: false,
          error: dedupResult.error || 'تم رفض الأمر',
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
        this.assertLive(currentGen);
        if (uid === this.hostUid) {
          this.notifyCommittedAck({
            commandId: cmd.commandId,
            ok: false,
            error: dedupResult.error || 'تم رفض الأمر',
          });
        }
      } catch (err) {
        if (uid === this.hostUid) {
          this.notifyCommittedAck({
            commandId: cmd.commandId,
            ok: false,
            error: err instanceof Error ? err.message : dedupResult.error || 'تم رفض الأمر',
          });
        }
      }
      return;
    }

    const playerId = this.uidToPlayerId.get(uid);
    if (!playerId) {
      try {
        this.assertLive(currentGen);
        await set(ref(db, `rooms/${this.roomId}/responses/${uid}`), {
          slot,
          commandId: cmd.commandId,
          ok: false,
          error: 'اللاعب غير مسجل في الغرفة',
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
        this.assertLive(currentGen);
        if (uid === this.hostUid) {
          this.notifyCommittedAck({
            commandId: cmd.commandId,
            ok: false,
            error: 'اللاعب غير مسجل في الغرفة',
          });
        }
      } catch (err) {
        if (uid === this.hostUid) {
          this.notifyCommittedAck({
            commandId: cmd.commandId,
            ok: false,
            error: err instanceof Error ? err.message : 'اللاعب غير مسجل في الغرفة',
          });
        }
      }
      return;
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(cmd.payloadJson || '{}') as Record<string, unknown>;
    } catch {
      payload = {};
    }

    // State backup before mutation
    const stateBefore = (await this.store.get(this.code))!;
    this.assertLive(currentGen);
    if (!stateBefore) return;

    const stateBackup = JSON.parse(JSON.stringify(stateBefore)) as RoomState;
    const dedupBackup = this.dedup.toJSON();

    try {
      let nextState: RoomState;

      switch (cmd.type) {
        case 'ready':
          nextState = await this.engine.setReady(this.code, playerId, payload.ready as boolean | undefined);
          break;
        case 'configure':
          nextState = await this.engine.configure(this.code, playerId, payload as Partial<MatchConfig>);
          break;
        case 'start': {
          const connectedCount = stateBefore.players.filter((p) => p.connected).length;
          if (connectedCount < 2) {
            throw new EngineError('لازم لاعبين متصلين على الأقل عشان تبدأ الماتش');
          }
          nextState = await this.engine.start(this.code, playerId);
          break;
        }
        case 'skip':
          nextState = await this.engine.skipPhase(this.code, playerId);
          break;
        case 'kick': {
          const targetPlayerId = String(payload.playerId || '');
          nextState = await this.engine.kick(this.code, playerId, targetPlayerId);
          break;
        }
        case 'rematch':
          nextState = await this.engine.rematch(this.code, playerId);
          break;
        case 'leave': {
          const res = await this.engine.leave(this.code, playerId);
          if (!res) {
            nextState = stateBefore;
          } else {
            nextState = res;
          }
          break;
        }
        case 'round:action': {
          if (typeof cmd.roundNo !== 'number') {
            throw new EngineError('رقم الجولة مطلوب');
          }
          nextState = await this.engine.submitAction(this.code, playerId, cmd.roundNo, payload.action);
          break;
        }
        case 'resume': {
          const token = String(payload.token || '');
          const res = await this.engine.resume(this.code, token);
          nextState = res.state;
          break;
        }
        default:
          throw new EngineError(`أمر غير معروف: ${cmd.type}`);
      }

      this.assertLive(currentGen);

      const catStartMs = Date.now();
      const categories = await this.contentSource.categories();
      const catElapsedMs = Date.now() - catStartMs;
      this.assertLive(currentGen);
      const metaVal = await this.getRoomMeta(db, currentGen);

      // Pre-write recheck before atomic commit: ensure command in inbox was not cleared, replaced, or expired
      let preWriteCmd: { commandId?: string; expiresAtMs?: number } | null = null;
      let preWriteExists = true;
      if (catElapsedMs < 15 && receivedAtMs > 0 && Date.now() - receivedAtMs < 25) {
        const cachedCmd = this.latestCommands.get(uid);
        preWriteExists = Boolean(cachedCmd);
        preWriteCmd = cachedCmd ?? null;
      } else {
        const preWriteCmdSnap = await get(ref(db, `rooms/${this.roomId}/commands/${uid}`));
        this.assertLive(currentGen);
        preWriteExists = preWriteCmdSnap.exists();
        preWriteCmd = preWriteCmdSnap.val();
      }
      const preWriteNow = this.session.serverNow();
      const preWriteExpiresAtMs = typeof preWriteCmd?.expiresAtMs === 'number'
        ? preWriteCmd.expiresAtMs
        : typeof cmd.expiresAtMs === 'number'
          ? cmd.expiresAtMs
          : undefined;

      if (
        !preWriteExists ||
        preWriteCmd?.commandId !== cmd.commandId ||
        (preWriteExpiresAtMs !== undefined && preWriteExpiresAtMs <= preWriteNow)
      ) {
        await this.store.create(stateBackup);
        if (typeof dedupBackup !== 'undefined') {
          this.dedup.fromJSON(dedupBackup);
        }
        if (preWriteCmd && preWriteCmd.commandId === cmd.commandId && preWriteExpiresAtMs !== undefined && preWriteExpiresAtMs <= preWriteNow) {
          try {
            this.assertLive(currentGen);
            await set(ref(db, `rooms/${this.roomId}/responses/${uid}`), {
              slot,
              commandId: cmd.commandId,
              ok: false,
              error: 'انتهت صلاحية الأمر',
              processedAtMs: preWriteNow,
              leaseOwnerId: this.runtimeId,
            });
          } catch {
            // Ignore response write error
          }
          if (uid === this.hostUid) {
            this.notifyCommittedAck({
              commandId: cmd.commandId,
              ok: false,
              error: 'انتهت صلاحية الأمر',
            });
          }
        }
        return;
      }

      // Atomic commit: snapshot, projections, responses, and kicked member updates
      this.dedup.recordAck(uid, cmd.commandId, dedupResult.seq, { ok: true }, preWriteNow);

      const nextMeta: RoomMetaCache = {
        code: this.code,
        hostUid: this.hostUid!,
        createdAtMs: metaVal.createdAtMs,
        expiresAtMs: metaVal.expiresAtMs,
        phase: nextState.phase,
        status: 'open',
        memberCount: nextState.players.length,
        admittedCount: metaVal.admittedCount,
        updatedAtMs: now,
        leaseOwnerId: this.runtimeId,
      };

      const updates: Record<string, unknown> = {
        meta: nextMeta,
        snapshot: this.createSnapshotRecord(nextState, now),
        [`responses/${uid}`]: {
          slot,
          commandId: cmd.commandId,
          ok: true,
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        },
      };

      for (const p of nextState.players) {
        const pUid = this.playerIdToUid.get(p.id);
        const pSlot = pUid ? this.uidToSlot.get(pUid) : null;
        if (pUid && pSlot) {
          const view = toView(nextState, p.id, categories, now);
          updates[`views/${pUid}`] = {
            slot: pSlot,
            json: JSON.stringify(view),
            version: nextState.version,
            updatedAtMs: now,
            leaseOwnerId: this.runtimeId,
          };
        }
      }

      // If kick or leave removed a player, update their member record to removed with current leaseOwnerId fence
      if (cmd.type === 'kick') {
        const targetPlayerId = String(payload.playerId || '');
        const targetUid = this.playerIdToUid.get(targetPlayerId);
        const targetSlot = targetUid ? this.uidToSlot.get(targetUid) : null;
        if (targetUid && targetSlot) {
          updates[`members/${targetUid}/removed`] = true;
          updates[`members/${targetUid}/leaseOwnerId`] = this.runtimeId;
          updates[`responses/${targetUid}`] = {
            slot: targetSlot,
            commandId: `kick_${cmd.commandId}`,
            ok: false,
            kicked: true,
            error: 'تم استبعادك من الغرفة',
            processedAtMs: now,
            leaseOwnerId: this.runtimeId,
          };
        }
      } else if (cmd.type === 'leave') {
        updates[`members/${uid}/removed`] = true;
        updates[`members/${uid}/leaseOwnerId`] = this.runtimeId;
      }

      this.assertLive(currentGen);
      await this.publishRoomUpdate(db, updates);
      this.cachedMeta = nextMeta;
      this.assertLive(currentGen);

      if (this.hostPlayerId) {
        const hostView = toView(nextState, this.hostPlayerId, categories, now);
        this.notifyCommittedView(hostView);
      }

      if (uid === this.hostUid) {
        this.notifyCommittedAck({
          commandId: cmd.commandId,
          ok: true,
        });
      }
    } catch (err) {
      // Unconditionally roll back in-memory engine state and dedup to backup
      try {
        await this.store.create(stateBackup);
        if (typeof dedupBackup !== 'undefined') {
          this.dedup.fromJSON(dedupBackup);
        }
      } catch {
        // Ignore rollback failure
      }

      if (this.disposed || this.generation !== currentGen || !this.isLive()) {
        if (uid === this.hostUid) {
          this.notifyCommittedAck({
            commandId: cmd.commandId,
            ok: false,
            error: err instanceof Error ? err.message : 'فشل تنفيذ الأمر',
          });
        }
        return;
      }

      const isEngineError = err instanceof EngineError;
      const errorMsg = isEngineError ? err.message : 'فشل تنفيذ الأمر';
      try {
        await set(ref(db, `rooms/${this.roomId}/responses/${uid}`), {
          slot,
          commandId: cmd.commandId,
          ok: false,
          error: errorMsg,
          processedAtMs: now,
          leaseOwnerId: this.runtimeId,
        });
        if (isEngineError) {
          this.dedup.recordAck(uid, cmd.commandId, dedupResult.seq, { ok: false, error: errorMsg }, now);
        }
      } catch {
        // Ignore ack write failure
      }
      if (uid === this.hostUid) {
        this.notifyCommittedAck({
          commandId: cmd.commandId,
          ok: false,
          error: errorMsg,
        });
      }
    }
  }

  private async publishEngineState(db: Database): Promise<void> {
    const currentGen = this.generation;
    if (this.disposed || this.isStopped || !this.roomId || !this.code || !this.engine || !this.isLive() || this.generation !== currentGen) return;

    const state = await this.store.get(this.code);
    this.assertLive(currentGen);
    if (!state) return;

    const now = this.session.serverNow();
    const categories = await this.contentSource.categories();
    this.assertLive(currentGen);
    const metaVal = await this.getRoomMeta(db, currentGen);

    const nextMeta: RoomMetaCache = {
      code: this.code,
      hostUid: this.hostUid!,
      createdAtMs: metaVal.createdAtMs,
      expiresAtMs: metaVal.expiresAtMs,
      phase: state.phase,
      status: metaVal.status,
      memberCount: state.players.length,
      admittedCount: metaVal.admittedCount,
      updatedAtMs: now,
      leaseOwnerId: this.runtimeId,
    };

    const updates: Record<string, unknown> = {
      meta: nextMeta,
      snapshot: this.createSnapshotRecord(state, now),
    };

    for (const p of state.players) {
      const pUid = this.playerIdToUid.get(p.id);
      const pSlot = pUid ? this.uidToSlot.get(pUid) : null;
      if (pUid && pSlot) {
        const view = toView(state, p.id, categories, now);
        updates[`views/${pUid}`] = {
          slot: pSlot,
          json: JSON.stringify(view),
          version: state.version,
          updatedAtMs: now,
          leaseOwnerId: this.runtimeId,
        };
      }
    }

    try {
      this.assertLive(currentGen);
      await this.publishRoomUpdate(db, updates);
      this.cachedMeta = nextMeta;
      this.assertLive(currentGen);
      if (this.hostPlayerId) {
        const hostView = toView(state, this.hostPlayerId, categories, now);
        this.notifyCommittedView(hostView);
      }
    } catch (err) {
      // Lease might be lost or expired
      this.stopExecution('فشل نشر تحديث الغرفة إلى قاعدة البيانات');
    }
  }

  /**
   * Relinquishes host duties when the host leaves while other connected members remain in the room.
   * Marks the host as disconnected/left in engine state, sets heartbeat.connected = false, and
   * expires the lease immediately so the oldest connected member can take over seamlessly.
   * Returns true if handoff state was published (other connected members exist), or false if room should close.
   */
  async relinquishHost(): Promise<boolean> {
    if (this.disposed || !this.roomId || !this.code || !this.engine || !this.hostPlayerId) {
      return false;
    }

    try {
      const state = await this.store.get(this.code);
      if (!state) return false;

      const otherConnected = state.players.filter(
        (p) => p.id !== this.hostPlayerId && p.connected && !p.leftEarly,
      );
      if (otherConnected.length === 0) {
        return false;
      }

      const authCtx = await this.session.ensureAuth();
      const db = authCtx.database;
      const hostUid = this.hostUid ?? authCtx.uid;
      const now = this.session.serverNow();

      // Mark departing host as disconnected (non-destructive if they later reconnect as a guest, or advance round if waiting on them)
      const nextState = (await this.engine.setConnected(this.code, this.hostPlayerId, false)) ?? state;
      const categories = await this.contentSource.categories();
      const metaVal = this.cachedMeta ?? (await get(ref(db, `rooms/${this.roomId}/meta`))).val();

      const updates: Record<string, unknown> = {
        heartbeat: {
          lastSeenAtMs: now,
          connected: false,
          leaseOwnerId: this.runtimeId,
        },
        [`presence/${hostUid}`]: {
          uid: hostUid,
          connected: false,
          updatedAtMs: now,
        },
        snapshot: this.createSnapshotRecord(nextState, now),
      };

      if (metaVal) {
        updates['meta'] = {
          code: this.code,
          hostUid,
          createdAtMs: metaVal.createdAtMs,
          expiresAtMs: metaVal.expiresAtMs,
          phase: nextState.phase,
          status: 'open',
          memberCount: nextState.players.length,
          admittedCount: metaVal.admittedCount,
          updatedAtMs: now,
          leaseOwnerId: this.runtimeId,
        };
      }

      for (const p of nextState.players) {
        const pUid = this.playerIdToUid.get(p.id);
        const pSlot = pUid ? this.uidToSlot.get(pUid) : null;
        if (pUid && pSlot) {
          const view = toView(nextState, p.id, categories, now);
          updates[`views/${pUid}`] = {
            slot: pSlot,
            json: JSON.stringify(view),
            version: nextState.version,
            updatedAtMs: now,
            leaseOwnerId: this.runtimeId,
          };
        }
      }

      await this.publishRoomUpdate(db, updates);

      // Immediately expire the lease so the oldest connected member can claim it without waiting for TTL
      await set(ref(db, `rooms/${this.roomId}/lease`), {
        ownerId: this.runtimeId,
        hostUid,
        epoch: this.epoch,
        acquiredAtMs: this.acquiredAtMs,
        expiresAtMs: now - 100,
      });

      this.stopExecution('غادر الهوست الغرفة وتم نقل الاستضافة');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Safely closes the room on host exit, marking meta.status = 'closed'.
   */
  async closeRoom(reason = 'أغلق الهوست الغرفة'): Promise<void> {
    if (this.disposed || !this.roomId) return;
    const closingRoomId = this.roomId;
    const closingCode = this.code;

    const now = this.session.serverNow();
    try {
      const authCtx = await this.session.ensureAuth();
      const db = authCtx.database;
      const hostUid = this.hostUid ?? authCtx.uid;

      await update(ref(db, `rooms/${closingRoomId}/meta`), {
        status: 'closed',
        closedReason: reason,
        updatedAtMs: now,
        leaseOwnerId: this.runtimeId,
      });

      if (closingCode && /^[A-Z0-9]{5}$/.test(closingCode)) {
        const codeRef = ref(db, `codes/${closingCode}`);
        const codeSnap = await get(codeRef);
        if (codeSnap.exists() && codeSnap.val()?.roomId === closingRoomId && codeSnap.val()?.hostUid === hostUid) {
          const unsubCode = onValue(codeRef, () => {});
          try {
            await get(codeRef);
            await runTransaction(
              codeRef,
              (curr) => {
                if (!curr) return null;
                if (curr.roomId === closingRoomId && curr.hostUid === hostUid) {
                  return null;
                }
                return undefined;
              },
              { applyLocally: false },
            ).catch(() => {});
          } finally {
            unsubCode();
          }
        }
      }

      if (hostUid) {
        const activeRef = ref(db, `hosts/${hostUid}/activeRoom`);
        const activeSnap = await get(activeRef);
        if (activeSnap.exists() && activeSnap.val()?.roomId === closingRoomId) {
          const unsubActive = onValue(activeRef, () => {});
          try {
            await get(activeRef);
            await runTransaction(
              activeRef,
              (curr) => {
                if (!curr) return null;
                if (curr.roomId === closingRoomId) {
                  return null;
                }
                return undefined;
              },
              { applyLocally: false },
            ).catch(() => {});
          } finally {
            unsubActive();
          }
        }
      }
    } catch {
      // Ignore
    } finally {
      this.stopExecution(reason);
    }
  }

  private stopExecution(reason: string): void {
    this.isStopped = true;
    this.generation += 1;
    this.notifyExecutionStopped(reason);

    const pending = this.queue;
    this.queue = [];
    for (const task of pending) {
      try {
        task.reject(new Error(`Host execution stopped: ${reason}`));
      } catch {
        // Ignore
      }
    }

    if (this.leaseUnsub) {
      this.leaseUnsub();
      this.leaseUnsub = null;
    }
    if (this.metaUnsub) {
      this.metaUnsub();
      this.metaUnsub = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.joinRequestsUnsub) {
      this.joinRequestsUnsub();
      this.joinRequestsUnsub = null;
    }
    if (this.commandsUnsub) {
      this.commandsUnsub();
      this.commandsUnsub = null;
    }
    if (this.presenceUnsub) {
      this.presenceUnsub();
      this.presenceUnsub = null;
    }
    this.latestJoinRequests.clear();
    this.latestCommands.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.isRestoring = false;
    this.stopExecution('Disposed');
    this.queue = [];
    if (this.connectionUnsub) {
      this.connectionUnsub();
      this.connectionUnsub = null;
    }
  }
}
