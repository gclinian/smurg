// The app's one clock (lib/use-now.ts on lib/clock.ts): it is the host's, every age on screen reads the same tick, and
// an age that is printed to the second is redrawn each second.
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeConnection } from '../testing/fake-connection.ts';
import { makeWelcome } from '../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../testing/services.tsx';
import { formatAge, formatRelativeTime } from './format.ts';
import { useLocalNow, useNow } from './use-now.ts';

// A whole half minute, so the ticks of every interval used here fall where the tests expect them.
const T = 1_790_000_010_000;

/** An age as a card, a status bar or an inbox row shows it: `interval` is how often its component asks to be redrawn. */
function Age({ id, at, interval, enabled = true }: { id: string; at: number; interval: number; enabled?: boolean }) {
  const now = useNow(interval, enabled);
  draws.set(id, (draws.get(id) ?? 0) + 1);
  return <span data-testid={id}>{formatAge(at, now)}</span>;
}

const draws = new Map<string, number>();
const text = (id: string): string | null => screen.getByTestId(id).textContent;
const pass = (ms: number): void => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T);
  draws.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the clock is the host’s', () => {
  /** A member whose own clock is `behindMs` behind the host's: the Welcome carries the host's time. */
  function admitted(behindMs: number) {
    const conn = new FakeConnection();
    const context = createTestWorkspace({ conn, admit: false });
    act(() => conn.admit(makeWelcome({ serverTime: Date.now() + behindMs })));
    return context;
  }

  function Both({ at }: { at: number }) {
    return (
      <>
        <span data-testid="host">{formatAge(at, useNow())}</span>
        <span data-testid="local">{formatAge(at, useLocalNow())}</span>
      </>
    );
  }

  it('a member whose computer is two minutes behind reads the age the host would, not "0 sec" for two minutes', () => {
    const context = admitted(120_000);
    // Asked 40 seconds ago by the host's clock: in the future by this browser's.
    const askedAt = Date.now() + 120_000 - 40_000;
    render(
      <WorkspaceTestProviders context={context}>
        <Both at={askedAt} />
      </WorkspaceTestProviders>,
    );
    expect(text('host')).toBe('40 sec');
    expect(text('local')).toBe('0 sec');
    pass(30_000);
    expect(text('host')).toBe('1 min');
  });

  it('a member whose computer is ahead does not read "3 min" on a card that just appeared', () => {
    const context = admitted(-180_000);
    render(
      <WorkspaceTestProviders context={context}>
        <Both at={Date.now() - 180_000} />
      </WorkspaceTestProviders>,
    );
    expect(text('host')).toBe('0 sec');
    expect(text('local')).toBe('3 min');
  });

  it('a difference under two seconds is the Welcome’s time on the way: nothing is corrected', () => {
    const context = admitted(-1_500);
    expect(context.stores.workspace.getState().clockSkewMs).toBe(0);
    render(
      <WorkspaceTestProviders context={context}>
        <Both at={Date.now() - 40_000} />
      </WorkspaceTestProviders>,
    );
    expect(text('host')).toBe('40 sec');
  });

  it('a new Welcome measures again', () => {
    const context = admitted(120_000);
    render(
      <WorkspaceTestProviders context={context}>
        <Both at={Date.now()} />
      </WorkspaceTestProviders>,
    );
    expect(text('host')).toBe('2 min');
    act(() => context.conn.admit(makeWelcome({ serverTime: Date.now() }), { resumed: true }));
    expect(text('host')).toBe('0 sec');
  });

  it('outside a workspace the clock is the browser’s own', () => {
    render(<Age id="a" at={T - 5_000} interval={30_000} />);
    expect(text('a')).toBe('5 sec');
  });
});

describe('one wait, one number', () => {
  it('an age under a minute counts each second whatever its caller asked for, and two callers say the same', () => {
    render(
      <>
        <Age id="card" at={T} interval={30_000} />
        <Age id="bar" at={T} interval={10_000} />
        <Age id="row" at={T} interval={30_000} />
      </>,
    );
    expect([text('card'), text('bar'), text('row')]).toEqual(['0 sec', '0 sec', '0 sec']);
    for (let second = 1; second <= 12; second++) {
      pass(1_000);
      expect([text('card'), text('bar'), text('row')]).toEqual([`${second} sec`, `${second} sec`, `${second} sec`]);
    }
    pass(47_000);
    expect([text('card'), text('bar'), text('row')]).toEqual(['59 sec', '59 sec', '59 sec']);
    pass(1_000);
    expect([text('card'), text('bar'), text('row')]).toEqual(['1 min', '1 min', '1 min']);
  });

  it('an item that arrives between two ticks is not "0 sec" five seconds later', () => {
    function Rows() {
      const now = useNow(30_000);
      const [items, setItems] = useState<readonly number[]>([T - 10 * 60_000]);
      add = (at) => setItems((previous) => [...previous, at]);
      return (
        <ul>
          {items.map((at) => (
            <li key={at}>{formatAge(at, now)}</li>
          ))}
        </ul>
      );
    }
    let add: (at: number) => void = () => {};
    render(<Rows />);
    pass(7_000);
    // A question was asked two seconds ago; its row arrives now, between two ticks of a list that showed only minutes.
    act(() => add(Date.now() - 2_000));
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['10 min', '2 sec']);
    pass(5_000);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['10 min', '7 sec']);
  });

  it('with nothing under a minute on screen a caller is redrawn at its own pace, callers of one pace together', () => {
    render(
      <>
        <Age id="a" at={T - 5 * 60_000} interval={30_000} />
        <Age id="b" at={T - 5 * 60_000} interval={30_000} />
        <Age id="hour" at={T - 5 * 60_000} interval={3_600_000} />
      </>,
    );
    const before = new Map(draws);
    pass(29_000);
    expect((draws.get('a') ?? 0) - (before.get('a') ?? 0)).toBeLessThanOrEqual(1);
    pass(31_000);
    expect([text('a'), text('b')]).toEqual(['6 min', '6 min']);
    expect(draws.get('a')).toBe(draws.get('b'));
    expect((draws.get('a') ?? 0) - (before.get('a') ?? 0)).toBeLessThanOrEqual(3);
    // The slow caller (a settled card) was not drawn again at all.
    expect(draws.get('hour')).toBe(before.get('hour'));
  });

  it('a caller that redraws once an hour does not follow the seconds of others', () => {
    render(
      <>
        <Age id="young" at={T} interval={30_000} />
        <Age id="settled" at={T - 2 * 3_600_000} interval={3_600_000} />
      </>,
    );
    const before = draws.get('settled');
    pass(10_000);
    expect(text('young')).toBe('10 sec');
    expect(draws.get('settled')).toBe(before);
  });

  it('a relative time under a minute is redrawn in time too', () => {
    function Ago({ at }: { at: number }) {
      return <span data-testid="ago">{formatRelativeTime(at, useNow())}</span>;
    }
    render(<Ago at={T} />);
    expect(text('ago')).toBe('just now');
    pass(12_000);
    expect(text('ago')).toBe('12 seconds ago');
    pass(3_000);
    expect(text('ago')).toBe('15 seconds ago');
  });

  it('a stopped clock does not tick, and reads the time at once when it runs again', () => {
    const view = render(<Age id="a" at={T} interval={1_000} enabled={false} />);
    const before = draws.get('a');
    pass(20_000);
    expect(draws.get('a')).toBe(before);
    view.rerender(<Age id="a" at={T} interval={1_000} enabled />);
    expect(text('a')).toBe('20 sec');
    pass(1_000);
    expect(text('a')).toBe('21 sec');
  });
});
