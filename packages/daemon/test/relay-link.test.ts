// The daemon's host socket (ARCHITECTURE §4 "Liveness", §6; relay.md §1.2, gotchas 2, 8, 23): bearer auth, the
// literal "ping" heartbeat, the pong watchdog for silently dead paths, immediate action on `bye`, reconnect with
// backoff, `bye 4001` (replaced) stops for good, and conn-id demultiplexing both ways.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { wsHostUrl, wsClientUrl, type RelayPeerOpenFrame } from '@smurg/protocol/relay';
import { DEFAULT_TIMING, type TimingConfig } from '../src/core/config.ts';
import { systemClock } from '../src/core/lifecycle.ts';
import { createLineLogger, silentLogger, type Logger } from '../src/core/logger.ts';
import { wsHostSocketFactory, type HostSocketFactory } from '../src/net/host-socket.ts';
import { RelayLink, type RelayLinkDownReason } from '../src/net/relay-connection.ts';
import { MEMORY_RELAY_ORIGIN, MemoryRelay, type MemoryClientSocket } from '../src/testing/memory-relay.ts';
import { createTestDaemon, waitFor } from '../src/testing/index.ts';

const WS = 'ws_test_relay_link_01';
const FAST: TimingConfig = { ...DEFAULT_TIMING, relayPingIntervalMs: 20, pongWatchdogMs: 150, reconnectBaseMs: 10, reconnectMaxMs: 40, relayOpenTimeoutMs: 300 };

interface Recorder {
  online: number;
  offline: RelayLinkDownReason[];
  opened: RelayPeerOpenFrame[];
  closed: number[];
  frames: { conn: number; payload: number[] }[];
  replaced: number;
  pings: number;
}

const links: RelayLink[] = [];

afterEach(() => {
  for (const link of links.splice(0)) link.stop();
});

function makeLink(relay: MemoryRelay, token = 'dummy-host-token'): { link: RelayLink; rec: Recorder } {
  const rec: Recorder = { online: 0, offline: [], opened: [], closed: [], frames: [], replaced: 0, pings: 0 };
  const base = relay.hostSocketFactory();
  const counting: HostSocketFactory = (url, headers, handlers) => {
    const socket = base(url, headers, handlers);
    return {
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      send: (data) => {
        if (data === 'ping') rec.pings++;
        socket.send(data);
      },
      close: (code, reason) => socket.close(code, reason),
      terminate: () => socket.terminate(),
    };
  };
  const link = new RelayLink({
    url: wsHostUrl(MEMORY_RELAY_ORIGIN, WS),
    token,
    label: 'ws',
    socketFactory: counting,
    timing: FAST,
    clock: systemClock,
    log: silentLogger,
    random: () => 0.5,
    handlers: {
      online: () => rec.online++,
      offline: (reason) => rec.offline.push(reason),
      peerOpen: (frame) => rec.opened.push(frame),
      peerClose: (conn) => rec.closed.push(conn),
      frame: (conn, payload) => rec.frames.push({ conn, payload: [...payload] }),
      replaced: () => rec.replaced++,
    },
  });
  links.push(link);
  link.start();
  return { link, rec };
}

async function openClient(relay: MemoryRelay, userId = 'dev:amy'): Promise<{ socket: MemoryClientSocket; received: unknown[] }> {
  const socket = relay.connectClient(wsClientUrl(MEMORY_RELAY_ORIGIN, WS), { userId, displayName: 'Amy' });
  const received: unknown[] = [];
  socket.addEventListener('message', (event: { data: unknown }) => received.push(event.data));
  await waitFor(() => socket.readyState === 1);
  return { socket, received };
}

describe('RelayLink', () => {
  it('authenticates with the bearer token and pings on the interval', async () => {
    const relay = new MemoryRelay(WS);
    const { link, rec } = makeLink(relay);
    await waitFor(() => link.state === 'online');
    expect(relay.hostTokens).toEqual(['dummy-host-token']);
    await waitFor(() => rec.pings >= 3, { what: 'pings' });
    expect(rec.offline).toEqual([]);
  });

  it('pong watchdog: a silently dead path is abandoned and the link comes back when the path does', async () => {
    const relay = new MemoryRelay(WS);
    const { link, rec } = makeLink(relay);
    await waitFor(() => link.state === 'online');
    relay.blackholeHost = true;
    await waitFor(() => rec.offline.includes('watchdog'), { what: 'watchdog', timeoutMs: 2_000 });
    relay.blackholeHost = false;
    await waitFor(() => link.state === 'online' && rec.online >= 2, { what: 'reconnect' });
  });

  it('a wall clock stepped back an hour does not freeze the heartbeat or the pong watchdog', async () => {
    const relay = new MemoryRelay(WS);
    let wallShift = 0;
    const stepped = { now: () => Date.now() + wallShift, monotonic: () => performance.now() };
    const rec: Recorder = { online: 0, offline: [], opened: [], closed: [], frames: [], replaced: 0, pings: 0 };
    const link = new RelayLink({
      url: wsHostUrl(MEMORY_RELAY_ORIGIN, WS),
      token: 'dummy-host-token',
      label: 'ws',
      socketFactory: relay.hostSocketFactory(),
      timing: FAST,
      clock: stepped,
      log: silentLogger,
      random: () => 0.5,
      handlers: {
        online: () => rec.online++,
        offline: (reason) => rec.offline.push(reason),
        peerOpen: () => {},
        peerClose: () => {},
        frame: () => {},
      },
    });
    links.push(link);
    link.start();
    await waitFor(() => link.state === 'online');
    wallShift = -3_600_000; // NTP (or the user) steps the clock back
    relay.blackholeHost = true;
    await waitFor(() => rec.offline.includes('watchdog'), { what: 'watchdog despite the backward step', timeoutMs: 2_000 });
  });

  it('acts on bye at once and reconnects (heartbeat timeout 4000)', async () => {
    const relay = new MemoryRelay(WS);
    const { link, rec } = makeLink(relay);
    await waitFor(() => link.state === 'online');
    relay.byeHost('ws', 4000, 'heartbeat timeout');
    await waitFor(() => rec.offline.includes('bye'));
    await waitFor(() => rec.online === 2 && link.state === 'online', { what: 'reconnect after bye' });
  });

  it('reconnects after the socket drops, and every client is announced again', async () => {
    const relay = new MemoryRelay(WS);
    const { link, rec } = makeLink(relay);
    await waitFor(() => link.state === 'online');
    const { socket } = await openClient(relay);
    await waitFor(() => rec.opened.length === 1);
    relay.dropHost('ws');
    await waitFor(() => rec.offline.includes('closed'));
    await waitFor(() => rec.online === 2 && rec.opened.length === 2, { what: 'peer.open replay' });
    expect(rec.opened[1]).toMatchObject({ t: 'peer.open', conn: socket.conn, userId: 'dev:amy' });
  });

  it('stops for good when a newer host connection replaces it (bye 4001)', async () => {
    const relay = new MemoryRelay(WS);
    const first = makeLink(relay);
    await waitFor(() => first.link.state === 'online');
    const second = makeLink(relay);
    await waitFor(() => second.link.state === 'online' && first.link.state === 'replaced', { what: 'replacement' });
    expect(first.rec.replaced).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(first.link.state).toBe('replaced');
    expect(relay.hostOnline('ws')).toBe(true);
  });

  it('demultiplexes connection ids both ways and kicks one client through the relay', async () => {
    const relay = new MemoryRelay(WS);
    const { link, rec } = makeLink(relay);
    await waitFor(() => link.state === 'online');
    const amy = await openClient(relay, 'dev:amy');
    const bob = await openClient(relay, 'dev:bob');
    await waitFor(() => rec.opened.length === 2);
    amy.socket.send(new Uint8Array([1, 2, 3]));
    bob.socket.send(new Uint8Array([9]));
    await waitFor(() => rec.frames.length === 2);
    expect(rec.frames).toEqual([
      { conn: amy.socket.conn, payload: [1, 2, 3] },
      { conn: bob.socket.conn, payload: [9] },
    ]);
    expect(link.sendFrame(bob.socket.conn, new Uint8Array([7, 7]))).toBe(true);
    await waitFor(() => bob.received.some((d) => d instanceof ArrayBuffer));
    expect([...new Uint8Array(bob.received.find((d) => d instanceof ArrayBuffer) as ArrayBuffer)]).toEqual([7, 7]);
    expect(amy.received.some((d) => d instanceof ArrayBuffer)).toBe(false);
    link.kick(amy.socket.conn, 'kicked');
    await waitFor(() => amy.socket.readyState === 3 && rec.closed.includes(amy.socket.conn), { what: 'kick' });
    expect(amy.received).toContain(JSON.stringify({ t: 'bye', code: 4003, reason: 'kicked' }));
    expect(bob.socket.readyState).toBe(1);
  });

  describe('the relay refuses the host session token and link transitions reach the host', () => {
    const capture = (): { log: Logger; lines: string[] } => {
      const lines: string[] = [];
      return { log: createLineLogger({ level: 'debug', write: (line) => lines.push(line) }), lines };
    };
    const directLink = (url: string, token: string, factory: HostSocketFactory, log: Logger, states: string[]): RelayLink => {
      const link = new RelayLink({
        url,
        token,
        label: 'ws',
        socketFactory: factory,
        timing: { ...FAST, relayAuthRetryMs: 60_000 },
        clock: systemClock,
        log,
        random: () => 0.5,
        handlers: {
          online: () => {},
          offline: () => {},
          peerOpen: () => {},
          peerClose: () => {},
          frame: () => {},
          stateChanged: (state, detail) => states.push(detail.status === undefined ? state : `${state}:${detail.status}`),
        },
      });
      links.push(link);
      link.start();
      return link;
    };

    it('goes to auth-rejected, says so once at error level, stops hammering, and reconnects at once with a new token', async () => {
      const relay = new MemoryRelay(WS);
      relay.hostTokenValid = (token) => token !== 'expired-login';
      const { log, lines } = capture();
      const states: string[] = [];
      const link = directLink(wsHostUrl(MEMORY_RELAY_ORIGIN, WS), 'expired-login', relay.hostSocketFactory(), log, states);
      await waitFor(() => link.state === 'auth-rejected', { what: 'auth-rejected' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Plain reconnects (FAST: at most 40 ms apart) would have made a dozen attempts by now.
      expect(relay.hostTokens).toEqual(['expired-login']);
      expect(link.state).toBe('auth-rejected');
      expect(lines.filter((l) => l.includes(' error ') && l.includes('smurg login'))).toHaveLength(1);
      expect(states).toEqual(['connecting', 'auth-rejected:401']);

      link.setToken('fresh-login');
      await waitFor(() => link.state === 'online', { what: 'online with the new token' });
      expect(relay.hostTokens).toEqual(['expired-login', 'fresh-login']);
      expect(states.at(-1)).toBe('online');
    });

    it('the real ws socket reports the HTTP 401 of an upgrade (relay requireAuth: invalid_session)', async () => {
      let upgrades = 0;
      const server = createServer((_req, res) => res.writeHead(404).end());
      server.on('upgrade', (_req, socket) => {
        upgrades++;
        const body = '{"error":"invalid_session"}';
        socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const { log, lines } = capture();
        const states: string[] = [];
        const link = directLink(wsHostUrl(`http://127.0.0.1:${port}`, WS), 'expired-login', wsHostSocketFactory(), log, states);
        await waitFor(() => link.state === 'auth-rejected', { what: 'auth-rejected', timeoutMs: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(upgrades).toBe(1);
        expect(states).toEqual(['connecting', 'auth-rejected:401']);
        expect(lines.some((l) => l.includes(' error ') && l.includes('status=401'))).toBe(true);
        link.stop();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('the daemon: status and the relay.link event show auth-rejected; updateRelayToken brings members back', async () => {
      const t = await createTestDaemon({ timing: { reconnectBaseMs: 10, reconnectMaxMs: 40 } });
      try {
        const events: string[] = [];
        t.ctx.bus.on('relay.link', (e) => events.push(`${e.purpose}:${e.state}${e.status === undefined ? '' : `:${e.status}`}`));
        t.relay.hostTokenValid = (token) => token !== 'test-host-token'; // the 7-day login ran out
        t.relay.dropHost('ws'); // e.g. the laptop woke up on another Wi-Fi
        await waitFor(() => t.daemon.status().relay.interactive === 'auth-rejected', { what: 'auth-rejected' });
        expect(events).toContain('interactive:auth-rejected:401');
        t.daemon.updateRelayToken('renewed-host-token');
        await waitFor(() => t.daemon.status().relay.interactive === 'online', { what: 'online again' });
        expect(events.at(-1)).toBe('interactive:online');
        await t.connect({ userId: 'dev:amy' });
      } finally {
        await t.cleanup();
      }
    });

    it('logs the link going down (warn, with the reason) and coming back, and reports both', async () => {
      const relay = new MemoryRelay(WS);
      const { log, lines } = capture();
      const states: string[] = [];
      const link = directLink(wsHostUrl(MEMORY_RELAY_ORIGIN, WS), 'dummy-host-token', relay.hostSocketFactory(), log, states);
      await waitFor(() => link.state === 'online');
      relay.dropHost('ws');
      await waitFor(() => states.includes('waiting'), { what: 'down reported' });
      await waitFor(() => link.state === 'online' && states.at(-1) === 'online', { what: 'back online' });
      expect(states).toEqual(['connecting', 'online', 'waiting', 'online']);
      expect(lines.some((l) => l.includes(' warn ') && l.includes('relay link down') && l.includes('reason=closed'))).toBe(true);
      expect(lines.some((l) => l.includes('relay link online') && l.includes('offlineMs='))).toBe(true);
    });
  });

  it('ignores malformed control frames', async () => {
    const relay = new MemoryRelay(WS);
    const { link, rec } = makeLink(relay);
    await waitFor(() => link.state === 'online');
    relay.sendToHost('ws', '{"t":"peer.open","conn":0}');
    relay.sendToHost('ws', 'not json');
    relay.sendToHost('ws', JSON.stringify({ t: 'peer.open', conn: 5, userId: 'root', displayName: 'x' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rec.opened).toEqual([]);
    expect(link.state).toBe('online');
  });
});
