// Host liveness (SPEC R1: guests see the host offline within 10 s), behaviour across forced hibernation, and the
// stale-client sweep. The "silent host" keeps its TCP connection open and simply stops sending "ping", which is what
// a sleeping laptop or a dead network path looks like to the relay.
import { randomBytes } from 'node:crypto';
import { HOST_OFFLINE_DEADLINE_MS } from '@smurg/protocol';
import { RELAY_CLOSE_CODES, RELAY_HOST_TIMEOUT_MS } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type DevSession, type LocalRelay, type RelaySocket } from '../test-support/index.ts';
import { closeAll, frameFor, open, openClient, pingOnce, sleep, tunnelUrl, unframe } from './helpers.ts';

let relay: LocalRelay;
let alice: DevSession;
let bob: DevSession;

beforeAll(async () => {
  // Production liveness values (HOST_TIMEOUT_MS 6000), so the measured latencies are the real ones.
  relay = await startLocalRelay();
  alice = await relay.devLogin('alice');
  bob = await relay.devLogin('bob');
});

afterAll(async () => {
  await relay?.stop();
});

describe('host offline detection', () => {
  it('reports a silent host (socket open, no pings) to every client within 10 s, and never while it pings', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const host = await open(tunnelUrl(relay, 'ws', 'host', workspaceId), { token: alice.token });
    const clients: RelaySocket[] = [];
    let late: RelaySocket | undefined;
    let reconnected: RelaySocket | undefined;
    try {
      for (let i = 0; i < 2; i++) {
        const client = await openClient(relay, 'ws', workspaceId, { token: bob.token });
        expect(client.hostOnline).toBe(true);
        clients.push(client.socket);
      }

      // Healthy host, pinging every 2 s: no false "offline" for well past the timeout.
      await sleep(RELAY_HOST_TIMEOUT_MS + 2_500);
      for (const client of clients) {
        expect(client.history.some((f) => f.kind === 'text' && f.json?.['t'] === 'host.offline')).toBe(false);
      }
      expect(host.lastPongAt).toBeDefined();

      // The host stops pinging but keeps the TCP connection open.
      host.stopHeartbeat();
      const silentSince = await pingOnce(host); // one last sign of life, so "silent since" is exact
      const latencies: number[] = [];
      for (const client of clients) {
        const offline = await client.nextControl('host.offline', HOST_OFFLINE_DEADLINE_MS + 2_000);
        expect(offline['reason']).toBe('timeout');
        latencies.push(offline.at - silentSince);
      }
      // SPEC R1 bound, and not earlier than the configured timeout (it is the heartbeat path, not a close).
      for (const latency of latencies) {
        expect(latency).toBeLessThan(HOST_OFFLINE_DEADLINE_MS);
        expect(latency).toBeGreaterThanOrEqual(RELAY_HOST_TIMEOUT_MS - 250);
      }
      console.log(`[R1] silent host reported offline after ${latencies.join(', ')} ms`);

      // The relay also tells the silent host, with bye 4000 before closing it.
      expect(await host.nextControl('bye')).toMatchObject({ code: RELAY_CLOSE_CODES.heartbeatTimeout });

      // A client joining now is told right away.
      const joined = await openClient(relay, 'ws', workspaceId, { token: bob.token });
      late = joined.socket;
      expect(joined.hostOnline).toBe(false);

      // The host reconnects: everyone sees it online again.
      reconnected = await open(tunnelUrl(relay, 'ws', 'host', workspaceId), { token: alice.token });
      for (const client of [...clients, late]) await client.nextControl('host.online');
      const peers = new Set<unknown>();
      for (let i = 0; i < 3; i++) peers.add((await reconnected.nextControl('peer.open'))['conn']);
      expect(peers.size).toBe(3);
    } finally {
      closeAll(host, reconnected, late, ...clients);
    }
  });

  it('checks liveness when a client joins even if nobody was watching (no alarm without clients)', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const host = await open(tunnelUrl(relay, 'ws', 'host', workspaceId), { token: alice.token, heartbeatMs: false });
    let client: RelaySocket | undefined;
    try {
      const state = await relay.inspect('ws', workspaceId);
      expect(state.hostStatus).toBe('online');
      expect(state.alarm).toBeNull();
      await sleep(RELAY_HOST_TIMEOUT_MS + 300);
      const joined = await openClient(relay, 'ws', workspaceId, { token: bob.token });
      client = joined.socket;
      expect(joined.hostOnline).toBe(false);
      expect(await host.nextControl('bye')).toMatchObject({ code: RELAY_CLOSE_CODES.heartbeatTimeout });
    } finally {
      closeAll(host, client);
    }
  });
});

describe('forced hibernation', () => {
  it('keeps sockets, tags, attachments and state across hibernation and routes both ways afterwards', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const host = await open(tunnelUrl(relay, 'ws', 'host', workspaceId), { token: alice.token });
    const first = await openClient(relay, 'ws', workspaceId, { token: bob.token });
    let second: RelaySocket | undefined;
    try {
      await host.nextControl('peer.open');
      const before = await relay.inspect('ws', workspaceId);

      await relay.evictDurableObjects({ workspaceId, kind: 'ws' });
      // Auto-responded pings are answered while hibernated and do not re-create the object.
      await pingOnce(first.socket);
      await pingOnce(host);
      await sleep(300);
      const beforeInspect = Date.now();
      const after = await relay.inspect('ws', workspaceId);
      expect(after.bootedAt).not.toBe(before.bootedAt);
      expect(after.bootedAt).toBeGreaterThanOrEqual(beforeInspect); // constructed by inspect(), not by the pings
      expect(after.clients.map((c) => c.conn)).toEqual(before.clients.map((c) => c.conn));
      expect(after.hostEpoch).toBe(before.hostEpoch);
      expect(after.hostStatus).toBe('online');
      expect(after.owner).toBe(alice.userId);

      await relay.evictDurableObjects({ workspaceId, kind: 'ws' });
      const up = randomBytes(128);
      first.socket.send(up);
      const got = unframe(await host.nextBinary());
      expect(got.conn).toBe(first.conn);
      expect(got.payload.equals(up)).toBe(true);

      await relay.evictDurableObjects({ workspaceId, kind: 'ws' });
      const down = randomBytes(128);
      host.send(frameFor(first.conn, down));
      expect((await first.socket.nextBinary()).equals(down)).toBe(true);

      // Connection ids stay unique after hibernation (the counter lives in storage, not in memory).
      await relay.evictDurableObjects({ workspaceId, kind: 'ws' });
      const next = await openClient(relay, 'ws', workspaceId, { token: bob.token });
      second = next.socket;
      expect(next.conn).not.toBe(first.conn);
      expect(await host.nextControl('peer.open')).toMatchObject({ conn: next.conn });
    } finally {
      closeAll(host, first.socket, second);
    }
  });

  it('detects a silent host within 10 s while the object is hibernated (the alarm wakes it)', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const host = await open(tunnelUrl(relay, 'ws', 'host', workspaceId), { token: alice.token });
    const { socket: client } = await openClient(relay, 'ws', workspaceId, { token: bob.token });
    try {
      await host.nextControl('peer.open');
      host.stopHeartbeat();
      const silentSince = await pingOnce(host);
      await relay.evictDurableObjects({ workspaceId, kind: 'ws' });
      const offline = await client.nextControl('host.offline', HOST_OFFLINE_DEADLINE_MS + 2_000);
      const latency = offline.at - silentSince;
      console.log(`[R1] silent host with hibernated object reported offline after ${latency} ms`);
      expect(offline['reason']).toBe('timeout');
      expect(latency).toBeLessThan(HOST_OFFLINE_DEADLINE_MS);
    } finally {
      closeAll(host, client);
    }
  });
});

describe('stale client sweep', () => {
  it('closes clients that stopped pinging (bye 4000 + peer.close) and keeps pinging clients', async () => {
    const sweepMs = 3_000;
    const sweeping = await startLocalRelay({ vars: { CLIENT_SWEEP_MS: String(sweepMs) } });
    const sockets: RelaySocket[] = [];
    try {
      const owner = await sweeping.devLogin('owner');
      const guest = await sweeping.devLogin('guest');
      const workspaceId = await sweeping.createWorkspace(owner.token);
      const host = await open(tunnelUrl(sweeping, 'ws', 'host', workspaceId), { token: owner.token });
      sockets.push(host);
      const silent = await openClient(sweeping, 'ws', workspaceId, { token: guest.token, heartbeatMs: false });
      const alive = await openClient(sweeping, 'ws', workspaceId, { token: guest.token });
      sockets.push(silent.socket, alive.socket);
      await host.nextControl('peer.open');
      await host.nextControl('peer.open');
      const openedAt = Date.now();

      const bye = await silent.socket.nextControl('bye', sweepMs + 5_000);
      expect(bye).toMatchObject({ code: RELAY_CLOSE_CODES.heartbeatTimeout });
      expect(bye.at - openedAt).toBeGreaterThanOrEqual(sweepMs - 250);
      expect(await host.nextControl('peer.close')).toMatchObject({ conn: silent.conn });

      // The pinging client survives several sweep periods.
      await sleep(sweepMs * 2);
      expect(alive.socket.history.some((f) => f.kind === 'text' && f.json?.['t'] === 'bye')).toBe(false);
      const state = await sweeping.inspect('ws', workspaceId);
      expect(state.clients.map((c) => c.conn)).toEqual([alive.conn]);
      const payload = randomBytes(16);
      host.send(frameFor(alive.conn, payload));
      expect((await alive.socket.nextBinary()).equals(payload)).toBe(true);
    } finally {
      closeAll(...sockets);
      await sweeping.stop();
    }
  });
});
