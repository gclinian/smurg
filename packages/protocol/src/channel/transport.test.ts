import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../bytes.ts';
import { createMemoryTransportPair, transportFromWebSocket, type Transport, type TransportCloseEvent, type WebSocketLike } from './transport.ts';

// Compile-time: a real WHATWG WebSocket (browser DOM, Node 22's global) fits the adapter (its send takes BufferSource).
const fitsTheGlobalWebSocket: (ws: WebSocket) => Transport = (ws) => transportFromWebSocket(ws);
void fitsTheGlobalWebSocket;

const tick = () => new Promise((res) => setTimeout(res, 0));

describe('createMemoryTransportPair', () => {
  it('delivers asynchronously, in order, copying frames', async () => {
    const pair = createMemoryTransportPair();
    const got: number[] = [];
    pair.daemon.onMessage((f) => got.push(f[0]!));
    const frame = new Uint8Array([1]);
    pair.client.send(frame);
    frame[0] = 9; // the sender reusing its buffer must not affect what was sent
    pair.client.send(new Uint8Array([2]));
    expect(got).toEqual([]);
    await tick();
    expect(got).toEqual([1, 2]);
  });

  it('buffers until a message handler exists; close waits behind pending frames and reaches both ends once', async () => {
    const pair = createMemoryTransportPair();
    const events: string[] = [];
    pair.client.onClose((e) => events.push(`client-close:${e.code}:${e.reason}`));
    pair.daemon.onClose(() => events.push('daemon-close'));
    pair.client.send(utf8Encode('a'));
    pair.client.send(utf8Encode('b'));
    pair.client.close(4003, 'kicked');
    pair.client.close();
    pair.client.send(utf8Encode('after close'));
    await tick();
    expect(events).toEqual(['client-close:4003:kicked']);
    pair.daemon.onMessage((f) => events.push(`msg:${new TextDecoder().decode(f)}`));
    await tick();
    expect(events).toEqual(['client-close:4003:kicked', 'msg:a', 'msg:b', 'daemon-close']);
    const late = await new Promise<TransportCloseEvent>((res) => pair.daemon.onClose(res));
    expect(late).toEqual({ code: 4003, reason: 'kicked' });
  });

  it('logs every frame and lets a tap drop, rewrite or inject', async () => {
    const pair = createMemoryTransportPair({
      tap: (f, dir) => (dir === 'client->daemon' && f[0] === 0 ? [] : [f, f]),
    });
    const got: number[] = [];
    pair.daemon.onMessage((f) => got.push(f[0]!));
    pair.client.send(new Uint8Array([0]));
    pair.client.send(new Uint8Array([5]));
    await tick();
    expect(got).toEqual([5, 5]);
    expect(pair.log.map((l) => [l.direction, l.frame[0]])).toEqual([
      ['client->daemon', 0],
      ['client->daemon', 5],
    ]);
  });
});

class FakeWebSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 1;
  sent: Uint8Array[] = [];
  closedWith: [number | undefined, string | undefined] | null = null;
  private listeners = new Map<string, Set<(e: never) => void>>();
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new Error('InvalidAccessError');
    this.closedWith = [code, reason];
    this.readyState = 3;
    this.emit('close', { code: code ?? 1005, reason: reason ?? '' });
  }
  addEventListener(type: string, listener: (e: never) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (e: never) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: unknown): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event as never);
  }
}

describe('transportFromWebSocket', () => {
  it('sets binaryType, routes binary frames to onMessage and text to onText', async () => {
    const ws = new FakeWebSocket();
    const texts: string[] = [];
    const t = transportFromWebSocket(ws, { onText: (s) => texts.push(s) });
    expect(ws.binaryType).toBe('arraybuffer');
    const frames: Uint8Array[] = [];
    t.onMessage((f) => frames.push(f));
    ws.emit('message', { data: new Uint8Array([1, 2]).buffer });
    ws.emit('message', { data: 'pong' });
    ws.emit('message', { data: new Uint8Array([9, 3, 4]).subarray(1) });
    await tick();
    expect(frames).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    expect(texts).toEqual(['pong']);
  });

  it('sends only while open and reports close once', async () => {
    const ws = new FakeWebSocket();
    const t = transportFromWebSocket(ws);
    const closes: TransportCloseEvent[] = [];
    t.onClose((e) => closes.push(e));
    t.send(new Uint8Array([1]));
    t.close(1, 'bad code falls back to a plain close');
    t.send(new Uint8Array([2]));
    await tick();
    expect(ws.sent).toEqual([new Uint8Array([1])]);
    expect(ws.closedWith).toEqual([undefined, undefined]);
    expect(closes).toEqual([{ code: 1005, reason: '' }]);
  });
});
