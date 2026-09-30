import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelaySocket, type RelaySocketHandlers } from './relay-socket.ts';
import { FakeRelay, type FakeConnEndpoint } from './testing/fake-relay.ts';
import { FAKE_TIMERS, settle } from './testing/world.ts';

const URL_WS = 'wss://relay.test/ws/ws_socket_test_0001/client';

function recorder() {
  const events: string[] = [];
  const handlers: RelaySocketHandlers = {
    hello: (f) => events.push(`hello:${f.conn}:${f.host}`),
    hostOnline: () => events.push('host.online'),
    hostOffline: (reason) => events.push(`host.offline:${reason}`),
    bye: (code) => events.push(`bye:${code}`),
    failed: (cause) => events.push(`failed:${cause}`),
    invalidText: () => events.push('invalid'),
  };
  return { events, handlers };
}

function open(relay: FakeRelay, handlers: RelaySocketHandlers, options: Partial<ConstructorParameters<typeof RelaySocket>[0]> = {}) {
  const socket = new RelaySocket({ url: URL_WS, createWebSocket: (url) => relay.connect(url, 'dev:amy'), handlers, now: () => Date.now(), ...options });
  socket.open();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RelaySocket', () => {
  it('sets binaryType arraybuffer, reports hello and sends "ping" right away and every 2 s', async () => {
    const relay = new FakeRelay();
    const { events, handlers } = recorder();
    const socket = open(relay, handlers);
    await settle();
    const ws = relay.lastSocket();
    expect(ws.binaryType).toBe('arraybuffer');
    expect(events).toEqual(['hello:1:false']);
    expect(ws.sentText).toEqual(['ping']);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(ws.sentText).toEqual(['ping', 'ping', 'ping', 'ping']);
    expect(events).toEqual(['hello:1:false']); // pongs came back: no watchdog
    socket.terminate();
  });

  it('pong watchdog fires 6 s after the first unanswered ping, and only then', async () => {
    const relay = new FakeRelay();
    relay.answerPings = false;
    const { events, handlers } = recorder();
    open(relay, handlers);
    await settle();
    // hello counts as proof of life; the first unanswered ping is the one sent at t = 2 s
    await vi.advanceTimersByTimeAsync(7_500);
    expect(events).toEqual(['hello:1:false']);
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(['hello:1:false', 'failed:watchdog']);
    expect(relay.lastSocket().readyState).toBeGreaterThanOrEqual(2);
  });

  it('throttled timers (a hidden tab) are not mistaken for lost pongs', async () => {
    const relay = new FakeRelay();
    const { events, handlers } = recorder();
    const socket = open(relay, handlers);
    await settle();
    relay.answerPings = false;
    await vi.advanceTimersByTimeAsync(2_000); // a ping goes out and is not answered
    relay.answerPings = true;
    // The page is frozen for a minute: no timer ran, the clock moved on.
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toEqual(['hello:1:false']);
    socket.terminate();
  });

  it('any inbound frame counts as proof of life (a pong can queue behind large frames)', async () => {
    const relay = new FakeRelay();
    relay.answerPings = false;
    const { events, handlers } = recorder();
    const endpoints: FakeConnEndpoint[] = [];
    let send: (frame: Uint8Array) => void = () => {};
    relay.attachHost('ws', {
      openConn(info) {
        send = info.send;
        const endpoint = { receive() {}, close() {} };
        endpoints.push(endpoint);
        return endpoint;
      },
    });
    const socket = open(relay, handlers);
    await settle();
    for (let i = 0; i < 20; i++) {
      send(new Uint8Array([0x10, 1, 2, 3]));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(events).toEqual(['hello:1:true']);
    socket.terminate();
  });

  it('acts on bye at once (terminates, reports the code) without waiting for the close event', async () => {
    const relay = new FakeRelay();
    const { events, handlers } = recorder();
    open(relay, handlers);
    await settle();
    const ws = relay.lastSocket();
    relay.bye(ws, 1009, 'too big', 16_000);
    await settle();
    expect(events).toEqual(['hello:1:false', 'bye:1009']);
    expect(ws.closeCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(events).toEqual(['hello:1:false', 'bye:1009']); // the late close is ignored
  });

  it('host.online / host.offline are forwarded; invalid control text is reported and ignored', async () => {
    const relay = new FakeRelay();
    const { events, handlers } = recorder();
    const socket = open(relay, handlers);
    await settle();
    const ws = relay.lastSocket();
    relay.sendText(ws, '{"t":"host.online"}');
    relay.sendText(ws, '{"t":"host.offline","reason":"timeout"}');
    relay.sendText(ws, 'not json');
    relay.sendText(ws, '{"t":"host.online","extra":1}');
    relay.sendText(ws, '{"t":"peer.open","conn":1,"userId":"dev:x","displayName":"x"}'); // host-only frame
    await settle();
    expect(events).toEqual(['hello:1:false', 'host.online', 'host.offline:timeout', 'invalid', 'invalid', 'invalid']);
    socket.terminate();
  });

  it('a socket that never opens fails as open-failed; one that never says hello fails as no-hello', async () => {
    const relay = new FakeRelay();
    relay.refuseConnections = true;
    const a = recorder();
    open(relay, a.handlers);
    await settle();
    expect(a.events).toEqual(['failed:open-failed']);

    relay.refuseConnections = false;
    const b = recorder();
    // A socket that opens but whose relay stays silent.
    const silent = new RelaySocket({
      url: URL_WS,
      createWebSocket: (url) => {
        const ws = relay.connect(url, 'dev:amy');
        relay.blackhole = true;
        return ws;
      },
      handlers: b.handlers,
      now: () => Date.now(),
      watchdogMs: 60_000,
    });
    silent.open();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.events).toEqual(['failed:no-hello']);
    relay.blackhole = false;
  });

  it('a factory that throws is reported as open-failed, asynchronously', async () => {
    const { events, handlers } = recorder();
    const socket = new RelaySocket({
      url: URL_WS,
      createWebSocket: () => {
        throw new Error('no WebSocket');
      },
      handlers,
      now: () => Date.now(),
    });
    socket.open();
    expect(events).toEqual([]);
    await settle();
    expect(events).toEqual(['failed:open-failed']);
  });

  it('sessions: binary frames reach only the current session; closing a session keeps the socket', async () => {
    const relay = new FakeRelay();
    const received: string[] = [];
    let send: (frame: Uint8Array) => void = () => {};
    relay.attachHost('ws', {
      openConn(info) {
        send = info.send;
        return { receive: (frame) => received.push(`d<-${frame[0]}`), close() {} };
      },
    });
    const { handlers } = recorder();
    const socket = open(relay, handlers);
    await settle();
    const first = socket.openSession();
    const got: string[] = [];
    const closes: string[] = [];
    first.onMessage((f) => got.push(`first:${f[0]}`));
    first.onClose((e) => closes.push(`first:${e.reason}`));
    first.send(new Uint8Array([1]));
    send(new Uint8Array([7]));
    await settle();
    const second = socket.openSession(); // supersedes the first
    second.onMessage((f) => got.push(`second:${f[0]}`));
    first.send(new Uint8Array([9])); // ignored: not the current session
    second.send(new Uint8Array([2]));
    send(new Uint8Array([8]));
    await settle();
    expect(got).toEqual(['first:7', 'second:8']);
    expect(closes).toEqual(['first:superseded']);
    expect(received).toEqual(['d<-1', 'd<-2']);
    second.close();
    await settle();
    expect(socket.isOpen).toBe(true);
    socket.terminate();
    expect(socket.isOpen).toBe(false);
  });
});
