// Offset handling of a terminal viewer (pty-packaging.md §6.1: snapshot / delta, then live; no gap, no duplicate).
import { describe, expect, it } from 'vitest';
import { makeSession } from '../../testing/fixtures.ts';
import { TerminalFeed, type AttachResult, type FeedSink } from './terminal-feed.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const painted: string[] = [];
  const sink: FeedSink = {
    snapshot: (data, cols, rows) => painted.push(`[snapshot ${cols}x${rows}]${dec.decode(data)}`),
    write: (data) => painted.push(dec.decode(data)),
    resize: (cols, rows) => painted.push(`[resize ${cols}x${rows}]`),
  };
  const attaches: { haveOffset: number | undefined; reply: Deferred<AttachResult> }[] = [];
  const fences: Deferred<unknown>[] = [];
  let detaches = 0;
  const errors: unknown[] = [];
  const feed = new TerminalFeed(
    sink,
    {
      attach: (haveOffset) => {
        const reply = deferred<AttachResult>();
        attaches.push({ haveOffset, reply });
        return reply.promise;
      },
      detach: () => {
        detaches++;
      },
      fence: () => {
        const reply = deferred<unknown>();
        fences.push(reply);
        return reply.promise;
      },
    },
    { onError: (error) => errors.push(error) },
  );
  const result = (mode: 'snapshot' | 'delta', data: string, nextOffset: number, cols = 80, rows = 24): AttachResult => ({
    session: makeSession(),
    mode,
    data: enc.encode(data),
    cols,
    rows,
    nextOffset,
  });
  const output = (offset: number, data: string) => feed.output({ sessionId: 'sess_1', offset, data: enc.encode(data) });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { feed, painted, attaches, fences, errors, result, output, tick, detaches: () => detaches };
}

describe('TerminalFeed: snapshot, then live output placed by offset', () => {
  it('paints the snapshot, then appends live output at nextOffset; duplicates are dropped and overlaps trimmed', async () => {
    const s = setup();
    const attached = s.feed.attach();
    expect(s.attaches[0]?.haveOffset).toBeUndefined();
    s.attaches[0]!.reply.resolve(s.result('snapshot', 'SCREEN', 100, 120, 40));
    await attached;
    expect(s.feed.phase).toBe('live');
    s.output(100, 'abc'); // 100..103
    s.output(100, 'abc'); // exact duplicate
    s.output(98, 'xyabc'); // ends at 103: already rendered
    s.output(101, 'bcdef'); // overlaps 101..103, new 103..106 → "def"
    s.output(106, 'g');
    expect(s.painted).toEqual(['[snapshot 120x40]SCREEN', 'abc', 'def', 'g']);
    expect(s.feed.offset).toBe(107);
  });

  it('applies exec.resize in stream order between the output', async () => {
    const s = setup();
    const attached = s.feed.attach();
    s.attaches[0]!.reply.resolve(s.result('snapshot', '', 0));
    await attached;
    s.output(0, 'a');
    s.feed.resize({ sessionId: 'sess_1', cols: 100, rows: 30 });
    s.output(1, 'b');
    expect(s.painted).toEqual(['[snapshot 80x24]', 'a', '[resize 100x30]', 'b']);
  });

  it('events that arrive before the attach promise settles are applied after the snapshot, in order (live resize included)', async () => {
    const s = setup();
    const attached = s.feed.attach();
    // The SDK may dispatch post-reply events before the awaiting code runs: nothing is lost or reordered.
    s.feed.resize({ sessionId: 'sess_1', cols: 90, rows: 20 });
    s.output(50, 'late');
    s.output(40, 'old'); // before nextOffset: dropped
    s.attaches[0]!.reply.resolve(s.result('snapshot', 'S', 50));
    await attached;
    expect(s.painted).toEqual(['[snapshot 80x24]S', '[resize 90x20]', 'late']);
    expect(s.feed.offset).toBe(54);
  });

  it('a gap (bytes that never arrived) makes it attach again from the rendered offset — no gap, no duplicate', async () => {
    const s = setup();
    const attached = s.feed.attach();
    s.attaches[0]!.reply.resolve(s.result('snapshot', '', 10));
    await attached;
    s.output(10, 'aa'); // → 12
    s.output(20, 'zz'); // 12..20 missing
    expect(s.feed.resyncCount).toBe(1);
    // Same channel: detach, then a fence (its reply orders after every event of the old attachment), then attach.
    expect(s.detaches()).toBe(1);
    expect(s.fences).toHaveLength(1);
    s.output(22, 'ignored while fencing');
    s.fences[0]!.resolve({});
    await s.tick();
    expect(s.attaches[1]?.haveOffset).toBe(12);
    s.attaches[1]!.reply.resolve(s.result('delta', '12345678zz', 22));
    await s.tick();
    s.output(22, 'next');
    expect(s.painted).toEqual(['[snapshot 80x24]', 'aa', '[resize 80x24]', '12345678zz', 'next']);
    expect(s.feed.offset).toBe(26);
  });
});

describe('TerminalFeed: detach on hide, attach again later', () => {
  it('detach sends session.detach and ignores what is still in flight; re-attach fences first, then asks for a delta', async () => {
    const s = setup();
    const first = s.feed.attach();
    s.attaches[0]!.reply.resolve(s.result('snapshot', 'S', 5));
    await first;
    s.output(5, 'hello'); // → 10
    s.feed.detach();
    expect(s.detaches()).toBe(1);
    s.output(10, 'in flight'); // ignored: the delta will carry it
    s.feed.resize({ sessionId: 'sess_1', cols: 1, rows: 1 }); // stale: ignored
    const again = s.feed.attach();
    expect(s.fences).toHaveLength(1);
    expect(s.attaches).toHaveLength(1); // waits for the fence
    expect(s.detaches()).toBe(1); // already detached: not sent twice
    s.feed.resize({ sessionId: 'sess_1', cols: 2, rows: 2 }); // still the old attachment: ignored
    s.fences[0]!.resolve({});
    await s.tick();
    expect(s.attaches[1]?.haveOffset).toBe(10);
    s.attaches[1]!.reply.resolve(s.result('delta', 'in flight', 19, 100, 30));
    await again;
    expect(s.painted).toEqual(['[snapshot 80x24]S', 'hello', '[resize 100x30]', 'in flight']);
    expect(s.feed.offset).toBe(19);
  });

  it('after a full resync (a new logical channel) it attaches without a fence, from the rendered offset', async () => {
    const s = setup();
    const first = s.feed.attach();
    s.attaches[0]!.reply.resolve(s.result('snapshot', '', 0));
    await first;
    s.output(0, 'abc');
    s.feed.channelReset();
    const again = s.feed.attach();
    expect(s.fences).toHaveLength(0);
    expect(s.attaches[1]?.haveOffset).toBe(3);
    s.attaches[1]!.reply.resolve(s.result('snapshot', 'FULL', 9));
    await again;
    expect(s.painted.at(-1)).toBe('[snapshot 80x24]FULL');
    expect(s.feed.offset).toBe(9);
  });

  it('a delta that does not start at haveOffset cannot be placed: it starts over from a snapshot', async () => {
    const s = setup();
    const first = s.feed.attach();
    s.attaches[0]!.reply.resolve(s.result('snapshot', '', 4));
    await first;
    s.feed.channelReset();
    const again = s.feed.attach();
    s.attaches[1]!.reply.resolve(s.result('delta', 'xx', 10)); // 4 + 2 ≠ 10
    await s.tick();
    s.fences[0]?.resolve({});
    await s.tick();
    expect(s.attaches[2]?.haveOffset).toBeUndefined();
    s.attaches[2]!.reply.resolve(s.result('snapshot', 'OK', 10));
    await again;
    await s.tick();
    expect(s.painted.at(-1)).toBe('[snapshot 80x24]OK');
    expect(s.painted).not.toContain('xx');
  });

  it('a superseded attach result is ignored', async () => {
    const s = setup();
    const first = s.feed.attach();
    s.feed.detach();
    s.attaches[0]!.reply.resolve(s.result('snapshot', 'STALE', 5));
    await first;
    expect(s.painted).toEqual([]);
    expect(s.feed.phase).toBe('detached');
  });

  it('a failed attach leaves it detached and reports the error', async () => {
    const s = setup();
    const attached = s.feed.attach();
    const failure = new Error('nope');
    s.attaches[0]!.reply.reject(failure);
    await expect(attached).rejects.toBe(failure);
    expect(s.feed.phase).toBe('detached');
    expect(s.errors).toEqual([failure]);
  });
});
