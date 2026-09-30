import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../bytes.ts';
import { ClientRequestError } from './errors.ts';
import { RESUME_SEQ_SKIP, ReliableState } from './outbox.ts';

const enc = (id: string, size = 4) => (seq: number) => utf8Encode(`${id}#${seq}`.padEnd(size, '.'));

function push(state: ReliableState, id: string, request = true, size = 4) {
  return state.enqueue({ id, type: request ? 'lock.list' : 'doc.sync', request, encode: enc(id, size) });
}

describe('ReliableState (client side of the resume contract)', () => {
  it('assigns strictly increasing seqs from 1 and keeps the outbox in order', () => {
    const state = new ReliableState(1024);
    expect([push(state, 'a').seq, push(state, 'b').seq, push(state, 'c', false).seq]).toEqual([1, 2, 3]);
    expect(state.unsent().map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(state.nextSeq).toBe(4);
  });

  it('does not consume a seq when encoding fails', () => {
    const state = new ReliableState(1024);
    expect(() =>
      state.enqueue({
        id: 'x',
        type: 'lock.list',
        request: true,
        encode: () => {
          throw new Error('invalid payload');
        },
      }),
    ).toThrow('invalid payload');
    expect(push(state, 'a').seq).toBe(1);
  });

  it('refuses beyond its byte budget with ClientRequestError(overflow)', () => {
    const state = new ReliableState(10);
    push(state, 'a', true, 6);
    expect(() => push(state, 'b', true, 6)).toThrow(ClientRequestError);
    expect(state.outboxBytes).toBe(6);
    expect(state.nextSeq).toBe(2);
  });

  it('trims only SENT entries up to the acknowledged seq', () => {
    const state = new ReliableState(1024);
    const [a, b, c] = [push(state, 'a'), push(state, 'b'), push(state, 'c')];
    a.sent = true;
    b.sent = true;
    expect(state.trim(3)).toBe(2); // c was never sent: an ack cannot cover it
    expect(state.outbox).toEqual([c]);
  });

  it('removes a timed-out request only if it was not sent', () => {
    const state = new ReliableState(1024);
    const [a, b] = [push(state, 'a'), push(state, 'b')];
    a.sent = true;
    expect(state.removeUnsent(a)).toBe(false);
    expect(state.removeUnsent(b)).toBe(true);
    expect(state.outbox).toEqual([a]);
  });

  it('drops inbound duplicates (seq ≤ last processed) and tolerates gaps', () => {
    const state = new ReliableState(1024);
    expect([1, 2, 2, 5, 3, 6].map((seq) => state.acceptInbound(seq))).toEqual([true, true, false, true, false, true]);
    expect(state.lastSeq).toBe(6);
    expect(state.pendingAck()).toBe(6);
    state.markAcked(6);
    expect(state.pendingAck()).toBeNull();
  });

  it('resumed: everything unacknowledged is re-sent with its original seq and bytes', () => {
    const state = new ReliableState(1024);
    state.establish('ch_1', false);
    const [a, b] = [push(state, 'a'), push(state, 'b')];
    a.sent = true;
    b.sent = true;
    state.acceptInbound(4);
    expect(state.resumeRequest()).toEqual({ channelId: 'ch_1', lastSeq: 4 });
    const bytes = a.bytes;
    expect(state.establish('ch_1', true).lost).toEqual([]);
    expect(state.unsent().map((e) => [e.id, e.seq])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(a.bytes).toBe(bytes);
    expect(state.lastSeq).toBe(4);
    expect(state.pendingAck()).toBeNull(); // the resume request already told the daemon
  });

  it('not resumed: sent entries and queued one-way messages are lost, queued requests are renumbered from 1', () => {
    const state = new ReliableState(1024);
    state.establish('ch_1', false);
    const sent = push(state, 'sent');
    sent.sent = true;
    push(state, 'oneway', false);
    const queued = push(state, 'queued');
    state.acceptInbound(9);
    const { lost } = state.establish('ch_2', false);
    expect(lost.map((e) => e.id)).toEqual(['sent', 'oneway']);
    expect(state.outbox).toEqual([queued]);
    expect(queued.seq).toBe(1);
    expect(new TextDecoder().decode(queued.bytes)).toBe('queued#1');
    expect(state.nextSeq).toBe(2);
    expect(state.lastSeq).toBe(0);
    expect(state.channelId).toBe('ch_2');
  });

  it('the very first channel keeps queued one-way messages', () => {
    const state = new ReliableState(1024);
    push(state, 'early', false);
    expect(state.establish('ch_1', false).lost).toEqual([]);
    expect(state.unsent().map((e) => [e.id, e.seq])).toEqual([['early', 1]]);
  });

  it('a mismatched channelId is never treated as resumed', () => {
    const state = new ReliableState(1024);
    state.establish('ch_1', false);
    push(state, 'a').sent = true;
    expect(state.establish('ch_other', true).lost.map((e) => e.id)).toEqual(['a']);
  });

  it('restores a persisted position and skips ahead so no seq is reused', () => {
    const state = new ReliableState(1024);
    state.restore({ channelId: 'ch_1', lastSeq: 7, nextSeq: 12 });
    expect(state.resumeRequest()).toEqual({ channelId: 'ch_1', lastSeq: 7 });
    expect(push(state, 'a').seq).toBe(12 + RESUME_SEQ_SKIP);
    expect(state.snapshot()).toEqual({ channelId: 'ch_1', lastSeq: 7, nextSeq: 13 + RESUME_SEQ_SKIP });
  });

  it('clear() empties the outbox', () => {
    const state = new ReliableState(1024);
    push(state, 'a');
    expect(state.clear()).toHaveLength(1);
    expect(state.outbox).toEqual([]);
    expect(state.outboxBytes).toBe(0);
  });
});
