// What protocol 4 added to the Hub (ARCHITECTURE §4.3): volatile messages (`session.delta`: unsequenced, never
// stored or replayed, skipped while the host socket is backed up), fan-out to named channels (the watchers of a
// session), and a separate copy for the host (`hostPayload`).
import { afterEach, describe, expect, it } from 'vitest';
import { MESSAGE_REGISTRY, VOLATILE_SKIP_BUFFERED_BYTES, lineEvent, type ConversationEvent, type PayloadOf } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildPermission, buildQuestion } from '../src/core/fakes/index.ts';
import { createTestDaemon, waitFor, type TestClient, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const FAST_RECONNECT = { reconnectBaseMs: 20, reconnectMaxMs: 60 };

function delta(text: string, offset = 0): PayloadOf<'session.delta'> {
  return { sessionId: 'ses_a', turnId: 'turn_1', blockId: 'blk_1', offset, text };
}

function line(seq: number): ConversationEvent {
  return { ...lineEvent(msg('conversation.stopped', { name: 'Ian' })), seq, at: 1_727_000_000_000 + seq };
}

function channelOf(daemon: TestDaemon, client: TestClient): string {
  const channelId = daemon.ctx.hub.connections({ userId: client.userId })[0]?.channelId;
  if (channelId === undefined) throw new Error(`no channel for ${client.userId}`);
  return channelId;
}

/** The in-memory relay's host socket of the interactive tunnel (its `bufferedAmount` is a plain field). */
function hostSocket(daemon: TestDaemon): { bufferedAmount: number } {
  const socket = (daemon.relay as unknown as { hosts: Map<string, { bufferedAmount: number }> }).hosts.get('ws');
  if (!socket) throw new Error('no host socket');
  return socket;
}

describe('volatile messages (session.delta)', () => {
  it('reach a connected channel unsequenced (seq 0), in order, without touching the sequence of the reliable stream', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const seen: { type: string; seq: number; text?: string }[] = [];
    amy.conn.on('session.delta', (payload, meta) => seen.push({ type: 'delta', seq: meta.seq, text: payload.text }));
    amy.conn.on('session.events', (payload, meta) => seen.push({ type: 'events', seq: meta.seq, text: String(payload.events[0]?.seq) }));
    const channelId = channelOf(t, amy);

    expect(t.ctx.hub.sendToChannels([channelId], 'session.events', { sessionId: 'ses_a', events: [line(1)] })).toBe(1);
    expect(t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('Hel'))).toBe(1);
    expect(t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('lo', 3))).toBe(1);
    expect(t.ctx.hub.sendToChannels([channelId], 'session.events', { sessionId: 'ses_a', events: [line(2)] })).toBe(1);
    await waitFor(() => seen.length === 4, { what: 'four messages' });

    expect(seen.map((entry) => `${entry.type}:${entry.text}`)).toEqual(['events:1', 'delta:Hel', 'delta:lo', 'events:2']);
    const [first, d1, d2, second] = seen as [(typeof seen)[number], (typeof seen)[number], (typeof seen)[number], (typeof seen)[number]];
    expect([d1.seq, d2.seq]).toEqual([0, 0]);
    // The two reliable messages are consecutive: the deltas between them took no sequence number.
    expect(second.seq).toBe(first.seq + 1);
  });

  it('are never stored: a channel that was away gets the reliable events again, exactly once, and none of the deltas', async () => {
    t = await createTestDaemon({ timing: FAST_RECONNECT });
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const deltas: string[] = [];
    const events: number[] = [];
    let resumed = 0;
    amy.conn.on('session.delta', (payload) => deltas.push(payload.text));
    amy.conn.on('session.events', (payload) => events.push(...payload.events.map((event) => event.seq)));
    amy.conn.onWelcome((_welcome, info) => {
      if (info.resumed) resumed += 1;
    });
    const channelId = channelOf(t, amy);
    t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('before'));
    await waitFor(() => deltas.length === 1, { what: 'the first delta' });

    t.relay.dropHost('ws');
    await waitFor(() => t?.ctx.hub.connections({ userId: 'dev:amy' }).length === 0, { what: 'hub detach' });
    // While the channel is away: a reliable message is queued, a volatile one is not sent at all.
    expect(t.ctx.hub.sendToChannels([channelId], 'session.events', { sessionId: 'ses_a', events: [line(7)] })).toBe(1);
    expect(t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('lost', 6))).toBe(0);
    expect(t.ctx.hub.send(channelId, 'session.delta', delta('lost too', 6))).toBe(false);
    expect(t.ctx.hub.sendToUser('dev:amy', 'session.delta', delta('lost as well', 6))).toBe(0);

    await waitFor(() => resumed === 1 && amy.conn.getState().kind === 'online', { what: 'resumed reconnect' });
    await waitFor(() => events.length === 1, { what: 'the replayed events' });
    t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('after', 6));
    await waitFor(() => deltas.length === 2, { what: 'a delta after the resume' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([7]);
    expect(deltas).toEqual(['before', 'after']);
  });

  it('are skipped while the host socket has more than VOLATILE_SKIP_BUFFERED_BYTES buffered; reliable messages still go', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const deltas: string[] = [];
    const events: number[] = [];
    amy.conn.on('session.delta', (payload) => deltas.push(payload.text));
    amy.conn.on('session.events', (payload) => events.push(...payload.events.map((event) => event.seq)));
    const channelId = channelOf(t, amy);
    const socket = hostSocket(t);

    socket.bufferedAmount = VOLATILE_SKIP_BUFFERED_BYTES; // at the limit: still sent
    expect(t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('a'))).toBe(1);
    socket.bufferedAmount = VOLATILE_SKIP_BUFFERED_BYTES + 1;
    expect(t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('b', 1))).toBe(0);
    expect(t.ctx.hub.sendToChannels([channelId], 'session.events', { sessionId: 'ses_a', events: [line(3)] })).toBe(1);
    socket.bufferedAmount = 0;
    expect(t.ctx.hub.sendToChannels([channelId], 'session.delta', delta('c', 2))).toBe(1);
    await waitFor(() => deltas.length === 2 && events.length === 1, { what: 'what was sent' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deltas).toEqual(['a', 'c']);
    expect(events).toEqual([3]);
  });

  it('the registry names exactly one volatile type, and the limit is one mebibyte', () => {
    expect(Object.entries(MESSAGE_REGISTRY).filter(([, spec]) => spec.volatile).map(([type]) => type)).toEqual(['session.delta']);
    expect(VOLATILE_SKIP_BUFFERED_BYTES).toBe(1024 * 1024);
  });
});

describe('sendToChannels', () => {
  it('sends to the named channels only, once per channel, and ignores ids that are no channel', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const bob = await t.connect({ userId: 'dev:bob', role: 'agent' });
    const cat = await t.connect({ userId: 'dev:cat', role: 'viewer' });
    const got = new Map<string, string[]>([['dev:amy', []], ['dev:bob', []], ['dev:cat', []]]);
    for (const client of [amy, bob, cat]) client.conn.on('question.updated', (payload) => got.get(client.userId)?.push(payload.question.id));
    const question = buildQuestion({ id: 'q_fanout' });
    const count = t.ctx.hub.sendToChannels([channelOf(t, amy), channelOf(t, cat), channelOf(t, amy), 'ch_nobody'], 'question.updated', { question });
    expect(count).toBe(2);
    await waitFor(() => got.get('dev:amy')?.length === 1 && got.get('dev:cat')?.length === 1, { what: 'both watchers' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(got.get('dev:amy')).toEqual(['q_fanout']);
    expect(got.get('dev:cat')).toEqual(['q_fanout']);
    expect(got.get('dev:bob')).toEqual([]);
    expect(t.ctx.hub.sendToChannels([], 'question.updated', { question })).toBe(0);
  });

  it('the host gets its own copy when one is given; everyone else gets the common one', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const bob = await t.connect({ userId: 'dev:bob', role: 'agent' });
    const seen = new Map<string, string[]>([[host.userId, []], ['dev:bob', []]]);
    for (const client of [host, bob]) client.conn.on('permission.updated', (payload) => seen.get(client.userId)?.push(payload.request.reason ?? ''));
    const common = buildPermission({ id: 'pr_copy', reason: 'for everyone' });
    const forHost = buildPermission({ id: 'pr_copy', reason: 'for the host' });
    expect(t.ctx.hub.sendToChannels([channelOf(t, host), channelOf(t, bob)], 'permission.updated', { request: common }, { hostPayload: { request: forHost } })).toBe(2);
    expect(t.ctx.hub.broadcast('permission.updated', { request: common }, { hostPayload: { request: forHost } })).toBe(2);
    expect(t.ctx.hub.broadcast('permission.updated', { request: common })).toBe(2);
    await waitFor(() => seen.get(host.userId)?.length === 3 && seen.get('dev:bob')?.length === 3, { what: 'three updates each' });
    expect(seen.get(host.userId)).toEqual(['for the host', 'for the host', 'for everyone']);
    expect(seen.get('dev:bob')).toEqual(['for everyone', 'for everyone', 'for everyone']);
  });

  it('a payload that does not fit its schema is refused for every recipient before anything is sent', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    let got = 0;
    amy.conn.on('session.delta', () => got++);
    expect(() => t?.ctx.hub.sendToChannels([channelOf(t as TestDaemon, amy)], 'session.delta', { ...delta('x'), offset: -1 })).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(got).toBe(0);
  });
});
