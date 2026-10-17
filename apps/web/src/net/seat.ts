import { nanoid } from 'nanoid';
import { clearSession } from './client.js';

export const TAB_SEAT_STORAGE_KEY = 'party-game-tab-seat-id';
export const TAB_SEATS_CHANNEL_NAME = 'party-game-tab-seats';

const SEAT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function generateSeatId(): string {
  return nanoid(16).replace(/[^A-Za-z0-9_-]/g, 'A');
}

export interface TabSeatManagerOptions {
  storage?: Storage | null;
  channel?: BroadcastChannel | null;
  probeTimeoutMs?: number;
  onClonedDetected?: () => void;
}

interface SeatProbeMessage {
  type: 'probe-seat';
  seatId: string;
  tabInstanceId: string;
}

interface SeatClaimedMessage {
  type: 'seat-claimed';
  seatId: string;
  tabInstanceId: string;
}

type SeatMessage = SeatProbeMessage | SeatClaimedMessage;

/**
 * Manages the tab seat identifier.
 *
 * Each browser tab must represent a distinct seat with its own anonymous Auth UID.
 * However, when a browser tab is duplicated (or opened via window.open), `sessionStorage`
 * is copied verbatim into the child tab.
 *
 * To guarantee seat isolation:
 * 1. Checks `sessionStorage` for an existing `seatId`.
 * 2. If an existing `seatId` is present, sends a probe on `BroadcastChannel` to check if another tab currently holds it.
 * 3. If another tab claims the seat within `probeTimeoutMs`, generates a fresh `seatId` and clears the inherited session.
 * 4. Listens on `BroadcastChannel` to defend its seat from subsequent cloned tabs.
 */
export class TabSeatManager {
  readonly tabInstanceId: string;
  private readonly storage: Storage | null;
  private readonly explicitChannel: BroadcastChannel | null | undefined;
  private channel: BroadcastChannel | null = null;
  private readonly probeTimeoutMs: number;
  private readonly onClonedDetected?: () => void;
  private currentSeatId: string | null = null;
  private channelListener: ((event: MessageEvent<SeatMessage>) => void) | null = null;
  private disposed = false;

  constructor(options: TabSeatManagerOptions = {}) {
    this.tabInstanceId = nanoid(12);
    this.storage = options.storage !== undefined ? options.storage : defaultSessionStorage();
    this.probeTimeoutMs = options.probeTimeoutMs ?? 50;
    this.onClonedDetected = options.onClonedDetected;
    this.explicitChannel = options.channel;
    // Pure construction: do NOT instantiate default BroadcastChannel during render
  }

  private getChannel(): BroadcastChannel | null {
    if (this.disposed) return null;
    if (this.channel !== null) return this.channel;
    if (this.explicitChannel !== undefined) {
      this.channel = this.explicitChannel;
    } else {
      this.channel = createDefaultBroadcastChannel(TAB_SEATS_CHANNEL_NAME);
    }
    return this.channel;
  }

  /**
   * Synchronously or asynchronously resolves the unique seat ID for this tab.
   * If a conflict with another live tab is detected, generates a fresh seat ID and clears inherited session.
   */
  async resolveSeatId(): Promise<string> {
    if (this.disposed) {
      return this.currentSeatId ?? generateSeatId();
    }
    if (this.currentSeatId) {
      return this.currentSeatId;
    }

    let candidate: string | null = null;
    try {
      candidate = this.storage?.getItem(TAB_SEAT_STORAGE_KEY) ?? null;
      if (candidate && !SEAT_ID_PATTERN.test(candidate)) {
        candidate = null;
      }
    } catch {
      candidate = null;
    }

    if (!candidate) {
      // First time in this tab: generate fresh seat ID
      this.currentSeatId = generateSeatId();
      this.persistSeatId(this.currentSeatId);
      this.startDefendingSeat(this.currentSeatId);
      return this.currentSeatId;
    }

    // Existing candidate found in storage — probe channel to detect cloned tab
    const isCloned = await this.probeCandidate(candidate);
    if (this.disposed) {
      return this.currentSeatId ?? candidate;
    }
    if (isCloned) {
      // Cloned tab detected! Discard inherited seat and clear inherited room session
      this.currentSeatId = generateSeatId();
      this.persistSeatId(this.currentSeatId);
      try {
        clearSession();
      } catch {
        // Ignore storage errors
      }
      this.onClonedDetected?.();
    } else {
      this.currentSeatId = candidate;
    }

    this.startDefendingSeat(this.currentSeatId);
    return this.currentSeatId;
  }

  /** Returns current seat ID if already resolved, or falls back to storage/fresh ID without bypassing probe. */
  getSeatIdSync(): string {
    if (this.currentSeatId) {
      return this.currentSeatId;
    }
    try {
      const existing = this.storage?.getItem(TAB_SEAT_STORAGE_KEY);
      if (existing && SEAT_ID_PATTERN.test(existing)) {
        return existing;
      }
    } catch {
      // Fallback
    }
    return generateSeatId();
  }

  private persistSeatId(id: string): void {
    try {
      this.storage?.setItem(TAB_SEAT_STORAGE_KEY, id);
    } catch {
      // Ignore storage errors
    }
  }

  private probeCandidate(seatId: string): Promise<boolean> {
    const channel = this.getChannel();
    if (!channel || this.disposed) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          channel.removeEventListener('message', onMsg);
          resolve(false);
        }
      }, this.probeTimeoutMs);

      const onMsg = (event: MessageEvent<SeatMessage>) => {
        const data = event.data;
        if (!data || data.seatId !== seatId || data.tabInstanceId === this.tabInstanceId) {
          return;
        }

        if (data.type === 'seat-claimed') {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            channel.removeEventListener('message', onMsg);
            resolve(true);
          }
          return;
        }

        if (data.type === 'probe-seat') {
          // Simultaneous probe detected! Break tie deterministically by tabInstanceId comparison:
          // The tab with lexically smaller tabInstanceId yields (isCloned = true).
          // The tab with lexically larger tabInstanceId defends the candidate and replies seat-claimed.
          if (data.tabInstanceId > this.tabInstanceId) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              channel.removeEventListener('message', onMsg);
              resolve(true);
            }
          } else {
            try {
              channel.postMessage({
                type: 'seat-claimed',
                seatId,
                tabInstanceId: this.tabInstanceId,
              } satisfies SeatClaimedMessage);
            } catch {
              // Ignore
            }
          }
        }
      };

      try {
        channel.addEventListener('message', onMsg);
        channel.postMessage({
          type: 'probe-seat',
          seatId,
          tabInstanceId: this.tabInstanceId,
        } satisfies SeatProbeMessage);
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  private startDefendingSeat(seatId: string): void {
    if (this.disposed || this.channelListener) return;
    const channel = this.getChannel();
    if (!channel) return;

    this.channelListener = (event: MessageEvent<SeatMessage>) => {
      const data = event.data;
      if (
        data &&
        data.type === 'probe-seat' &&
        data.seatId === seatId &&
        data.tabInstanceId !== this.tabInstanceId
      ) {
        try {
          channel.postMessage({
            type: 'seat-claimed',
            seatId,
            tabInstanceId: this.tabInstanceId,
          } satisfies SeatClaimedMessage);
        } catch {
          // Ignore messaging errors
        }
      }
    };

    try {
      channel.addEventListener('message', this.channelListener);
    } catch {
      // Ignore channel errors
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.channel && this.channelListener) {
      try {
        this.channel.removeEventListener('message', this.channelListener);
      } catch {
        // Ignore
      }
      this.channelListener = null;
    }
    if (this.channel) {
      try {
        this.channel.close();
      } catch {
        // Ignore
      }
      this.channel = null;
    }
  }
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

function createDefaultBroadcastChannel(name: string): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      return new BroadcastChannel(name);
    }
  } catch {
    // Ignore environments without BroadcastChannel
  }
  return null;
}
