// The relay's limits against the largest frames of protocol 4 (review DX-17). apps/relay has three limits a message can
// meet: the size of one binary WebSocket message (MAX_RELAY_FRAME on a host socket, 4 bytes less on a client socket,
// because the relay puts the connection id in front on the way to the host), the number of client sockets per
// workspace and per account, and the length of a control text frame. Protocol 4 added replies of several MiB (a page
// of events with its cards, a plan of 80 items, a report, the settings of a Claude Code folder); the largest message
// either side may send is still one Envelope of at most MAX_APP_MESSAGE.
//
// Here: the real relay (local workerd, both Durable Objects), the real daemon and a real client. A module on the
// daemon answers every protocol 4 request with the LARGEST valid result (packages/protocol worst-case.fixture.ts, the
// samples whose size ARCHITECTURE and P0-API §13 quote) after the client sent the largest valid payload, and sends
// every protocol 4 event at its largest. Then the absolute largest: one Envelope at MAX_APP_MESSAGE, both directions.
import { DisposableStack, type DaemonContext, type FeatureModule, type InboundNotifyType } from '@smurg/daemon';
import {
  DOC_SYNC_MAX_BYTES,
  FRAME_TYPE_BYTES,
  MAX_APP_MESSAGE,
  MAX_RELAY_FRAME,
  MESSAGE_REGISTRY,
  RECORD_OVERHEAD_BYTES,
  RELAY_CONN_PREFIX_BYTES,
  RELAY_PLATFORM_MAX_MESSAGE,
  encodeEnvelope,
  encodedSize,
  noiseRecordCount,
  type MessageType,
  type RequestType,
} from '@smurg/protocol';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The largest valid sample of every protocol 4 message: test-only relative import (the fixture of worst-case.test.ts).
import { WORST_CASES, type WorstCase } from '../../../packages/protocol/src/schema/worst-case.fixture.ts';
import { startStack, waitUntil, type Stack } from '../src/harness.ts';

let relay: LocalRelay;
let stack: Stack;

const TYPES = Object.keys(WORST_CASES) as MessageType[];
const worst = (type: MessageType): WorstCase => WORST_CASES[type] as WorstCase;
const interactive = (type: MessageType): boolean => MESSAGE_REGISTRY[type].channel !== 'transfer';
const REQUESTS = TYPES.filter((type) => MESSAGE_REGISTRY[type].dir === 'c2d' && MESSAGE_REGISTRY[type].result !== null && interactive(type));
const NOTIFIES = TYPES.filter((type) => MESSAGE_REGISTRY[type].dir === 'c2d' && MESSAGE_REGISTRY[type].result === null && interactive(type));
const EVENTS = TYPES.filter((type) => MESSAGE_REGISTRY[type].dir === 'd2c' && interactive(type));

/** What the daemon's handlers were given, by type: the encoded size of the payload as it arrived. */
const arrived = new Map<string, number>();
let daemonCtx: DaemonContext | null = null;
/** The largest `doc.sync` the daemon was sent, and what it sends back when asked. */
let echoed: Uint8Array | null = null;

/** The protocol 4 requests the daemon's core answers itself, through the services this module puts in their slots. */
const CORE_HANDLED = ['admin.claudeConfig.get', 'admin.claudeConfig.decide', 'admin.hostRules.get', 'admin.hostRules.seen', 'admin.transcript.redact'];

const worstCases: FeatureModule = {
  name: 'worst-cases',
  // What the core's own admin handlers ask: the services answer with the largest result too.
  create: () =>
    ({
      projectTrust: { describe: async () => worst('admin.claudeConfig.get').result, decide: async () => {} },
      hostRules: { view: () => worst('admin.hostRules.get').result, markSeen: async () => {} },
      agents: { get: () => ({}), redact: async () => {} },
    }) as never,
  register(router, ctx) {
    daemonCtx = ctx;
    const handlers = new DisposableStack();
    for (const type of REQUESTS) {
      if (router.has(type)) {
        if (!CORE_HANDLED.includes(type)) throw new Error(`${type} is handled by the core: give its service the largest result`);
        continue;
      }
      handlers.add(
        router.handle(type as RequestType, ((payload: unknown) => {
          arrived.set(type, encodedSize(payload));
          return worst(type).result;
        }) as never),
      );
    }
    for (const type of NOTIFIES) handlers.add(router.on(type as InboundNotifyType, ((payload: unknown) => void arrived.set(type, encodedSize(payload))) as never));
    // The absolute largest message of the interactive channel: a document sync of DOC_SYNC_MAX_BYTES. The daemon keeps
    // what arrived and sends the same bytes back to that member.
    handlers.add(
      router.on('doc.sync', (payload, request) => {
        echoed = payload.data;
        ctx.hub.sendToUser(request.userId, 'doc.sync', { docId: payload.docId, data: payload.data });
      }),
    );
    return handlers;
  },
};

/** The size of the one DATA frame an application message of `bytes` becomes (RecordSealer, channel/records.ts): a type byte, then the message in records with a length, a flags byte and a tag each. */
function dataFrameBytes(bytes: number): number {
  return FRAME_TYPE_BYTES + noiseRecordCount(bytes) * RECORD_OVERHEAD_BYTES + bytes;
}

/** The largest binary frame each side put on its sockets so far. */
function largestFrames(): { client: number; host: number } {
  const size = (side: 'client' | 'host'): number => Math.max(0, ...stack.wire.frames({ side, direction: 'sent', kind: 'binary' }).map((frame) => frame.data.byteLength));
  return { client: size('client'), host: size('host') };
}

beforeAll(async () => {
  relay = await startLocalRelay({ tap: false });
  stack = await startStack({ relay, modules: [worstCases] });
}, 120_000);

afterAll(async () => {
  await stack?.stop();
  await relay?.stop();
}, 120_000);

describe('the relay limits and the largest messages of protocol 4', { timeout: 240_000 }, () => {
  it('the frame limit holds one Envelope of MAX_APP_MESSAGE on either socket, with room, and stays below what the platform accepts', () => {
    const frame = dataFrameBytes(MAX_APP_MESSAGE);
    // A client's frame grows by the connection id on its way to the host: the relay admits 4 bytes less from clients.
    expect(frame).toBeLessThanOrEqual(MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES);
    expect(frame + RELAY_CONN_PREFIX_BYTES).toBeLessThanOrEqual(MAX_RELAY_FRAME);
    expect(MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES - frame).toBeGreaterThan(16 * 1024);
    expect(MAX_RELAY_FRAME).toBeLessThan(RELAY_PLATFORM_MAX_MESSAGE);
    // Every protocol 4 message is one Envelope below MAX_APP_MESSAGE (worst-case.test.ts): none comes near the limit.
    const largest = Math.max(...TYPES.flatMap((type) => [encodedSize(worst(type).payload), worst(type).result === undefined ? 0 : encodedSize(worst(type).result)]));
    expect(largest).toBeGreaterThan(4 * 1024 * 1024);
    expect(dataFrameBytes(largest + 1024)).toBeLessThan(MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES);
  });

  it('every protocol 4 request: its largest payload reaches the daemon and its largest result reaches the client, through the relay', async () => {
    expect(REQUESTS.length).toBeGreaterThan(50);
    const conn = stack.hostClient.conn;
    const sizes: { type: string; payload: number; result: number }[] = [];
    for (const type of REQUESTS) {
      // (three kinds of request share a bucket of 10 a minute per member: the clock of the token buckets is the daemon's)
      const result = await conn.request(type as never, worst(type).payload as never);
      expect(encodedSize(result), `${type}.ok as the client got it`).toBe(encodedSize(worst(type).result));
      if (!CORE_HANDLED.includes(type)) expect(arrived.get(type), `${type} as the daemon got it`).toBe(encodedSize(worst(type).payload));
      sizes.push({ type, payload: encodedSize(worst(type).payload), result: encodedSize(result) });
    }
    // The replies P0-API §13 lists as the large ones really were large here.
    const of = (type: string): number => sizes.find((entry) => entry.type === type)?.result ?? 0;
    expect(of('session.watch')).toBeGreaterThan(3 * 1024 * 1024);
    expect(of('plan.get')).toBeGreaterThan(5 * 1024 * 1024);
    expect(of('report.get')).toBeGreaterThan(4 * 1024 * 1024);
    expect(of('admin.claudeConfig.get')).toBeGreaterThan(5 * 1024 * 1024);
    // The connection is the one it was: nothing was answered with `bye 1009`.
    expect(conn.getState().kind).toBe('online');
    const frames = largestFrames();
    expect(frames.host).toBeGreaterThan(5 * 1024 * 1024);
    expect(frames.host).toBeLessThan(MAX_RELAY_FRAME);
    expect(frames.client).toBeLessThan(MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES);
  });

  it('every protocol 4 notify and event at its largest passes too', async () => {
    const conn = stack.hostClient.conn;
    for (const type of NOTIFIES) conn.notify(type as never, worst(type).payload as never);
    await waitUntil(() => NOTIFIES.every((type) => arrived.get(type) === encodedSize(worst(type).payload)), 30_000, 'every notify to reach the daemon');
    const got = new Map<string, number>();
    for (const type of EVENTS) conn.on(type as never, ((payload: unknown) => void got.set(type, encodedSize(payload))) as never);
    const ctx = daemonCtx as DaemonContext;
    // `session.delta` is volatile (skipped while the host socket is busy): it goes first, alone, onto an idle link.
    const ordered = [...EVENTS.filter((type) => MESSAGE_REGISTRY[type].volatile), ...EVENTS.filter((type) => !MESSAGE_REGISTRY[type].volatile)];
    for (const type of ordered) {
      expect(ctx.hub.sendToUser(stack.hostClient.userId, type as never, worst(type).payload as never), `${type} sent`).toBeGreaterThan(0);
      if (MESSAGE_REGISTRY[type].volatile) await waitUntil(() => got.has(type), 30_000, `${type} to arrive`);
    }
    await waitUntil(() => EVENTS.every((type) => got.has(type)), 60_000, 'every event to reach the client');
    for (const type of EVENTS) expect(got.get(type), type).toBe(encodedSize(worst(type).payload));
    expect(conn.getState().kind).toBe('online');
  });

  it('one Envelope at MAX_APP_MESSAGE passes in both directions; the frames are the largest the relay will ever carry', async () => {
    const conn = stack.hostClient.conn;
    const docId = `doc_${'0'.repeat(40)}`;
    // The largest `doc.sync`: DOC_SYNC_MAX_BYTES of data. With its Envelope it is within a few hundred bytes of MAX_APP_MESSAGE's 8 MiB.
    const data = new Uint8Array(DOC_SYNC_MAX_BYTES);
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) % 251;
    const envelope = encodeEnvelope({ type: 'doc.sync', id: 'x'.repeat(64), seq: Number.MAX_SAFE_INTEGER, payload: { docId, data } } as never, { from: 'client', channel: 'interactive' });
    expect(envelope.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    expect(envelope.byteLength).toBeLessThanOrEqual(MAX_APP_MESSAGE);
    let back: Uint8Array | null = null;
    conn.on('doc.sync', (payload) => {
      back = payload.data;
    });
    conn.notify('doc.sync', { docId, data });
    await waitUntil(() => back !== null, 60_000, 'the largest message to come back through the relay');
    expect((echoed as Uint8Array | null)?.byteLength).toBe(DOC_SYNC_MAX_BYTES);
    expect((back as unknown as Uint8Array).byteLength).toBe(DOC_SYNC_MAX_BYTES);
    expect(Buffer.from(back as unknown as Uint8Array).equals(Buffer.from(data))).toBe(true);
    expect(conn.getState().kind).toBe('online');
    const frames = largestFrames();
    // Both sides sent a frame of more than 8 MiB, and both were inside the relay's limit for that socket.
    expect(frames.client).toBeGreaterThan(8 * 1024 * 1024);
    expect(frames.client).toBeLessThanOrEqual(MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES);
    expect(frames.host).toBeGreaterThan(8 * 1024 * 1024);
    expect(frames.host).toBeLessThanOrEqual(MAX_RELAY_FRAME);
    // (the envelope the SDK really sent has a shorter id and sequence number than the sample above: a few bytes less)
    expect(dataFrameBytes(envelope.byteLength) - frames.client).toBeGreaterThanOrEqual(0);
    expect(dataFrameBytes(envelope.byteLength) - frames.client).toBeLessThan(128);
  });
});
