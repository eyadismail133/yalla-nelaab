import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScreenWakeLock } from './wake-lock.js';

afterEach(() => vi.unstubAllGlobals());

describe('match screen wake lock', () => {
  it('releases on hide, reacquires on return, and releases when the match stops', async () => {
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release }));
    vi.stubGlobal('document', document);
    vi.stubGlobal('navigator', { wakeLock: { request } });
    function Harness({ active }: { active: boolean }) { useScreenWakeLock(active); return null; }
    let screen!: ReactTestRenderer;
    await act(async () => { screen = create(createElement(Harness, { active: true })); });
    expect(request).toHaveBeenCalledWith('screen');
    document.visibilityState = 'hidden';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(release).toHaveBeenCalledTimes(1);
    document.visibilityState = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => screen.update(createElement(Harness, { active: false })));
    expect(release).toHaveBeenCalledTimes(2);
    act(() => screen.unmount());
  });

  it('releases a lock whose asynchronous acquisition finishes after unmount', async () => {
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const release = vi.fn(async () => {});
    let resolve!: (lock: { release: typeof release }) => void;
    const request = () => new Promise<{ release: typeof release }>((done) => { resolve = done; });
    vi.stubGlobal('document', document);
    vi.stubGlobal('navigator', { wakeLock: { request } });
    function Harness() { useScreenWakeLock(true); return null; }
    let screen!: ReactTestRenderer;
    act(() => { screen = create(createElement(Harness)); });
    act(() => screen.unmount());
    await act(async () => { resolve({ release }); });
    expect(release).toHaveBeenCalledOnce();
  });
});
