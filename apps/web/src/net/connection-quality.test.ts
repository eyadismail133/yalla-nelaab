import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameTransport } from './transport.js';
import { ConnectionQuality } from './connection-quality.js';

afterEach(() => vi.useRealTimers());

describe('connection quality badge', () => {
  it('shows measured RTT, clears stale quality offline, and samples again on reconnect', async () => {
    vi.useFakeTimers();
    const client = { sampleLatency: async () => 42, latencyLabel: 'Firebase' } as unknown as GameTransport;
    let screen!: ReactTestRenderer;
    await act(async () => { screen = create(createElement(ConnectionQuality, { client, connected: true })); });
    expect(JSON.stringify(screen.toJSON())).toContain('42');
    expect(JSON.stringify(screen.toJSON())).toContain('ممتاز');
    act(() => screen.update(createElement(ConnectionQuality, { client, connected: false })));
    expect(JSON.stringify(screen.toJSON())).toContain('غير متصل');
    expect(JSON.stringify(screen.toJSON())).not.toContain('42');
    await act(async () => screen.update(createElement(ConnectionQuality, { client, connected: true })));
    expect(JSON.stringify(screen.toJSON())).toContain('42');
    act(() => screen.unmount());
  });
});
