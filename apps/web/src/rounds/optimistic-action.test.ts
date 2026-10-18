import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { GameTransport } from '../net/transport.js';
import { McqRaceRound } from './McqRaceRound.js';
import { NumericGuessRound } from './NumericGuessRound.js';
import { useRoundAction } from './useRoundAction.js';

function deferredAck() {
  let resolve!: (ack: { ok: true } | { ok: false; error: string }) => void;
  const promise = new Promise<{ ok: true } | { ok: false; error: string }>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('optimistic round submissions', () => {
  it('highlights and locks an MCQ immediately, rolls back rejection, and keeps an accepted answer locked', async () => {
    let ack = deferredAck();
    const client = { act: () => ack.promise } as unknown as GameTransport;
    let screen!: ReactTestRenderer;
    act(() => { screen = create(createElement(McqRaceRound, {
      client, roundNo: 1,
      view: { textAr: 'سؤال', options: ['أ', 'ب', 'ج', 'د'], myChoice: null, hasAnswered: false, lockedCount: 0, totalPlayers: 2 },
    })); });
    act(() => { screen.root.findAllByType('button')[1]!.props.onClick(); });
    expect(screen.root.findAllByType('button')[1]!.props.className).toContain('border-[var(--accent)]');
    expect(screen.root.findAllByType('button').every((button) => button.props.disabled)).toBe(true);
    await act(async () => { ack.resolve({ ok: false, error: 'جرّب تاني' }); });
    expect(screen.root.findAllByType('button')[1]!.props.className).not.toContain('border-[var(--accent)]');
    expect(screen.root.findAllByType('button')[1]!.props.disabled).toBe(false);
    ack = deferredAck();
    act(() => { screen.root.findAllByType('button')[2]!.props.onClick(); });
    await act(async () => { ack.resolve({ ok: true }); });
    expect(screen.root.findAllByType('button')[2]!.props.className).toContain('border-[var(--accent)]');
    expect(screen.root.findAllByType('button').every((button) => button.props.disabled)).toBe(true);
    act(() => screen.unmount());
  });

  it('shows a submitted numeric guess before acknowledgement and restores the draft after rejection', async () => {
    const ack = deferredAck();
    const client = { act: () => ack.promise } as unknown as GameTransport;
    let screen!: ReactTestRenderer;
    act(() => { screen = create(createElement(NumericGuessRound, {
      client, roundNo: 1,
      view: { textAr: 'كام؟', unitAr: null, myGuess: null, hasGuessed: false, lockedCount: 0, totalPlayers: 2 },
    })); });
    act(() => screen.root.findByType('input').props.onChange({ target: { value: '42' } }));
    act(() => screen.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(screen.root.findAllByType('input')).toHaveLength(0);
    expect(JSON.stringify(screen.toJSON())).toContain('42');
    await act(async () => { ack.resolve({ ok: false, error: 'جرّب تاني' }); });
    expect(screen.root.findByType('input').props.value).toBe('42');
    act(() => screen.unmount());
  });

  it('ignores an old acknowledgement without unlocking a newer round request or invoking its success callback', async () => {
    const first = deferredAck();
    const second = deferredAck();
    const client = { act: (round: number) => round === 1 ? first.promise : second.promise } as unknown as GameTransport;
    let action!: ReturnType<typeof useRoundAction>;
    let oldSuccess = false;
    function Harness({ roundNo }: { roundNo: number }) {
      action = useRoundAction(client, roundNo);
      return null;
    }
    let screen!: ReactTestRenderer;
    act(() => { screen = create(createElement(Harness, { roundNo: 1 })); });
    act(() => { void action.act({}, () => { oldSuccess = true; }); });
    act(() => screen.update(createElement(Harness, { roundNo: 2 })));
    act(() => { void action.act({}); });
    await act(async () => { first.resolve({ ok: true }); });
    expect(action.pending).toBe(true);
    expect(oldSuccess).toBe(false);
    await act(async () => { second.resolve({ ok: true }); });
    expect(action.pending).toBe(false);
    act(() => screen.unmount());
  });
});
