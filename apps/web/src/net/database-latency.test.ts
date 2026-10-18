import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureDatabaseLatency } from './database-latency.js';

afterEach(() => vi.unstubAllGlobals());

describe('Firebase network latency', () => {
  it('uses an authenticated uncached REST read and waits for its response body', async () => {
    let requestUrl!: URL;
    let requestOptions!: RequestInit;
    let bodyRead = false;
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      requestUrl = url;
      requestOptions = options;
      return { ok: true, arrayBuffer: async () => { bodyRead = true; return new ArrayBuffer(0); } };
    });
    expect(await measureDatabaseLatency('http://127.0.0.1:9000/rooms/example/meta?ns=demo-game', 'test-token')).toBeGreaterThanOrEqual(0);
    expect(requestUrl.pathname).toBe('/rooms/example/meta.json');
    expect(requestUrl.searchParams.get('ns')).toBe('demo-game');
    expect(requestUrl.searchParams.get('auth')).toBe('test-token');
    expect(requestOptions.cache).toBe('no-store');
    expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
    expect(bodyRead).toBe(true);
  });

  it('does not report a latency when permissions or the network fail', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false }));
    expect(await measureDatabaseLatency('https://example.firebaseio.com/rooms/example/meta', 'test-token')).toBeNull();
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    expect(await measureDatabaseLatency('https://example.firebaseio.com/rooms/example/meta', 'test-token')).toBeNull();
  });
});
