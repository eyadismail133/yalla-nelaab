import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { GameClient } from './client.js';

describe('GameClient Socket.IO timeout and lifecycle regressions', () => {
  let socket: Socket;
  let client: GameClient;

  beforeEach(() => {
    vi.useFakeTimers();
    // Real installed socket.io-client created in disconnected state (no real server connection)
    socket = io('http://127.0.0.1:65534', {
      autoConnect: false,
      transports: ['websocket'],
    });
    client = new GameClient(socket);
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it('evicts expired packets and ack handlers from sendBuffer when request times out while disconnected', async () => {
    const promise = client.createRoom('أحمد');

    // Immediately after emit on disconnected socket, packet and ack handler are queued
    expect((socket as unknown as { sendBuffer: unknown[] }).sendBuffer.length).toBe(1);
    const acksBefore = (socket as unknown as { acks: Record<string, unknown> }).acks ?? {};
    expect(Object.keys(acksBefore).length).toBe(1);

    // Fast-forward fake timers past REQUEST_TIMEOUT_MS (10s)
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(result).toEqual({ ok: false, error: 'انتهت مهلة الطلب — جرب تاني' });

    // The expired packet is evicted from sendBuffer and the ack handler is removed
    const sendBufferAfter = (socket as unknown as { sendBuffer: unknown[] }).sendBuffer;
    expect(sendBufferAfter.length).toBe(0);

    const acksAfter = (socket as unknown as { acks: Record<string, unknown> }).acks ?? {};
    expect(Object.keys(acksAfter).length).toBe(0);

    // Connecting afterwards must not flush any leftover packets from the timed-out request
    socket.connect();
    expect((socket as unknown as { sendBuffer: unknown[] }).sendBuffer.length).toBe(0);
  });

  it('resolves successfully when an ack is received before timeout', async () => {
    const promise = client.joinRoom('KX7QM', 'سارة');

    // Retrieve the registered ack ID from sendBuffer options or acks map
    const sendBuffer = (socket as unknown as { sendBuffer: Array<{ options?: { id?: number } }> }).sendBuffer;
    expect(sendBuffer.length).toBe(1);
    const acks = (socket as unknown as { acks: Record<string, unknown> }).acks ?? {};
    const ackId = Number(Object.keys(acks)[0] ?? sendBuffer[0]?.options?.id ?? 0);

    // Dispatch the server ack before timeout
    (socket as unknown as { onack: (packet: { id: number; data: unknown[] }) => void }).onack({
      id: ackId,
      data: [{ ok: true, code: 'KX7QM', playerId: 'p2', token: 'tok_sec_123' }],
    });

    const result = await promise;
    expect(result).toEqual({
      ok: true,
      code: 'KX7QM',
      playerId: 'p2',
      token: 'tok_sec_123',
    });
  });

  it('handles no-payload commands correctly on success ack path', async () => {
    const promise = client.start();

    const sendBuffer = (socket as unknown as { sendBuffer: Array<{ options?: { id?: number } }> }).sendBuffer;
    expect(sendBuffer.length).toBe(1);
    const acks = (socket as unknown as { acks: Record<string, unknown> }).acks ?? {};
    const ackId = Number(Object.keys(acks)[0] ?? sendBuffer[0]?.options?.id ?? 0);

    (socket as unknown as { onack: (packet: { id: number; data: unknown[] }) => void }).onack({
      id: ackId,
      data: [{ ok: true }],
    });

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('does not connect socket on construction until explicit retryConnection or effect startup', () => {
    const renderClient = new GameClient();
    try {
      expect(renderClient.socket.active).toBe(false);
      expect(renderClient.socket.connected).toBe(false);

      renderClient.retryConnection();
      expect(renderClient.socket.active).toBe(true);
    } finally {
      renderClient.dispose();
    }
  });
});

