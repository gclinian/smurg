// Pairing and forwarding through WorkspaceDO and TransferDO: conn-id prefix framing in both directions, several
// clients without cross-delivery, control frames, kicks, host replacement (epoch), the frame cap, and text frames
// that are not valid control frames.
import { randomBytes } from 'node:crypto';
import { MAX_RELAY_FRAME, RELAY_CLOSE_CODES, RELAY_CONN_PREFIX_BYTES, encodeRelayControl } from '@smurg/protocol/relay';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type DevSession, type LocalRelay, type RelaySocket } from '../test-support/index.ts';
import { closeAll, frameFor, open, openClient, sleep, tunnelUrl, unframe, type Kind } from './helpers.ts';

let relay: LocalRelay;
let alice: DevSession;
let bob: DevSession;
let carol: DevSession;

beforeAll(async () => {
  relay = await startLocalRelay();
  alice = await relay.devLogin('alice', { displayName: 'Alice 艾莉絲' });
  bob = await relay.devLogin('bob', { displayName: 'Bob 鮑伯' });
  carol = await relay.devLogin('carol');
});

afterAll(async () => {
  await relay?.stop();
});

describe.each<Kind>(['ws', 'xfer'])('%s tunnel', (kind) => {
  it('pairs a host with several clients and forwards both ways with the conn prefix, without cross-delivery', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    let host: RelaySocket | undefined;
    let early: RelaySocket | undefined;
    let late: RelaySocket | undefined;
    try {
      // A client that arrives before the host is told the host is offline, then online.
      const first = await openClient(relay, kind, workspaceId, { token: bob.token });
      early = first.socket;
      expect(first.hostOnline).toBe(false);
      expect(first.conn).toBeGreaterThanOrEqual(1);

      host = await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: alice.token });
      const replayed = await host.nextControl('peer.open');
      expect(replayed).toEqual({ t: 'peer.open', conn: first.conn, userId: bob.userId, displayName: 'Bob 鮑伯', at: replayed.at });
      await early.nextControl('host.online');

      const second = await openClient(relay, kind, workspaceId, { token: carol.token });
      late = second.socket;
      expect(second.hostOnline).toBe(true);
      expect(second.conn).not.toBe(first.conn);
      const opened = await host.nextControl('peer.open');
      expect(opened).toMatchObject({ conn: second.conn, userId: carol.userId, displayName: 'carol' });

      // client -> host: the relay prepends the sender's conn id and forwards the payload untouched.
      const fromEarly = randomBytes(300);
      const fromLate = randomBytes(77);
      early.send(fromEarly);
      late.send(fromLate);
      const received = [unframe(await host.nextBinary()), unframe(await host.nextBinary())];
      const byConn = new Map(received.map((r) => [r.conn, r.payload]));
      expect(byConn.get(first.conn)?.equals(fromEarly)).toBe(true);
      expect(byConn.get(second.conn)?.equals(fromLate)).toBe(true);

      // host -> client: routed by the prefix, which is stripped; the other client receives nothing.
      const toLate = randomBytes(1024);
      host.send(frameFor(second.conn, toLate));
      expect((await late.nextBinary()).equals(toLate)).toBe(true);
      const toEarly = randomBytes(5);
      host.send(frameFor(first.conn, toEarly));
      expect((await early.nextBinary()).equals(toEarly)).toBe(true);
      await sleep(200);
      expect(early.pending()).toEqual([]);
      expect(late.pending()).toEqual([]);

      // A client leaving is reported to the host.
      early.close(1000, 'done');
      expect(await host.nextControl('peer.close')).toMatchObject({ t: 'peer.close', conn: first.conn });
      // A frame for a connection that is gone is answered with peer.close.
      host.send(frameFor(first.conn, randomBytes(8)));
      expect(await host.nextControl('peer.close')).toMatchObject({ conn: first.conn });

      // The host leaving is reported to the remaining client immediately.
      host.close(1000, 'bye');
      expect(await late.nextControl('host.offline')).toMatchObject({ t: 'host.offline', reason: 'closed' });
      // Frames sent while no host is connected are dropped and answered with host.offline.
      late.send(randomBytes(16));
      expect(await late.nextControl('host.offline')).toMatchObject({ reason: 'closed' });
    } finally {
      closeAll(host, early, late);
    }
  });

  it('closes a kicked client with bye 4003 before the close, and tells the host', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const host = await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: alice.token });
    const { socket: client, conn } = await openClient(relay, kind, workspaceId, { token: bob.token });
    try {
      await host.nextControl('peer.open');
      host.send(encodeRelayControl({ t: 'peer.kick', conn, reason: '你已被主人移出工作區' }));
      const bye = await client.nextControl('bye');
      expect(bye).toMatchObject({ code: RELAY_CLOSE_CODES.kicked, reason: '你已被主人移出工作區' });
      expect(await client.closed).toMatchObject({ via: 'bye', code: RELAY_CLOSE_CODES.kicked });
      expect(await host.nextControl('peer.close')).toMatchObject({ conn });
    } finally {
      closeAll(host, client);
    }
  });

  it('lets a newer host connection replace the older one (epoch) and ignores the stale close', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const oldHost = await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: alice.token });
    const { socket: client, conn } = await openClient(relay, kind, workspaceId, { token: bob.token });
    let newHost: RelaySocket | undefined;
    try {
      await oldHost.nextControl('peer.open');
      newHost = await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: alice.token });
      expect(await oldHost.nextControl('bye')).toMatchObject({ code: RELAY_CLOSE_CODES.hostReplaced });
      // The new host learns about the existing client, which is told to start over with the new host.
      expect(await newHost.nextControl('peer.open')).toMatchObject({ conn, userId: bob.userId });
      await client.nextControl('host.online');

      // The old socket's close arrives late and must not mark the (new) host offline.
      oldHost.terminate();
      await sleep(300);
      expect(client.pending().some((f) => f.kind === 'text' && f.json?.['t'] === 'host.offline')).toBe(false);

      const payload = randomBytes(64);
      client.send(payload);
      const got = unframe(await newHost.nextBinary());
      expect(got.conn).toBe(conn);
      expect(got.payload.equals(payload)).toBe(true);
      const back = randomBytes(33);
      newHost.send(frameFor(conn, back));
      expect((await client.nextBinary()).equals(back)).toBe(true);
    } finally {
      closeAll(oldHost, newHost, client);
    }
  });

  it('enforces the frame cap with bye 1009 on both sides and forwards a frame exactly at the cap', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const host = await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: alice.token });
    const { socket: client, conn } = await openClient(relay, kind, workspaceId, { token: bob.token });
    let second: RelaySocket | undefined;
    try {
      await host.nextControl('peer.open');
      // Largest client frame: after the 4-byte prefix it is exactly MAX_RELAY_FRAME at the host.
      const atCap = Buffer.alloc(MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES, 7);
      client.send(atCap);
      const forwarded = await host.nextBinary(20_000);
      expect(forwarded.length).toBe(MAX_RELAY_FRAME);
      expect(unframe(forwarded).conn).toBe(conn);

      client.send(Buffer.alloc(MAX_RELAY_FRAME - RELAY_CONN_PREFIX_BYTES + 1));
      expect(await client.nextControl('bye', 20_000)).toMatchObject({ code: RELAY_CLOSE_CODES.tooBig });
      expect(await host.nextControl('peer.close')).toMatchObject({ conn });

      const other = await openClient(relay, kind, workspaceId, { token: carol.token });
      second = other.socket;
      await host.nextControl('peer.open');
      host.send(Buffer.alloc(MAX_RELAY_FRAME + 1));
      expect(await host.nextControl('bye', 20_000)).toMatchObject({ code: RELAY_CLOSE_CODES.tooBig });
      expect(await second.nextControl('host.offline')).toMatchObject({ reason: 'closed' });
    } finally {
      closeAll(host, client, second);
    }
  });

  it('drops text frames that are not valid control frames and never forwards text', async () => {
    const workspaceId = await relay.createWorkspace(alice.token);
    const host = await open(tunnelUrl(relay, kind, 'host', workspaceId), { token: alice.token });
    const { socket: client, conn } = await openClient(relay, kind, workspaceId, { token: bob.token });
    try {
      await host.nextControl('peer.open');
      const invalid = [
        'not json',
        '{"t":"peer.kick"}', // missing conn and reason
        JSON.stringify({ t: 'peer.kick', conn, reason: 'x', extra: true }), // unknown key (strict schema)
        JSON.stringify({ t: 'peer.kick', conn: 0, reason: 'x' }), // reserved conn id
        JSON.stringify({ t: 'hello', conn, host: true }), // a relay->client frame from the host
        JSON.stringify({ t: 'peer.kick', conn, reason: 'x'.repeat(5000) }), // longer than RELAY_CONTROL_MAX_CHARS
        'pong',
      ];
      for (const text of invalid) host.send(text);
      for (const text of ['hello host', JSON.stringify({ t: 'peer.kick', conn, reason: 'self' }), 'pong']) client.send(text);
      await sleep(400);
      // Nothing was forwarded, nobody was kicked, and both sockets still work.
      expect(client.pending()).toEqual([]);
      expect(host.pending()).toEqual([]);
      const payload = randomBytes(40);
      client.send(payload);
      expect(unframe(await host.nextBinary()).payload.equals(payload)).toBe(true);
      host.send(frameFor(conn, payload));
      expect((await client.nextBinary()).equals(payload)).toBe(true);
      // Frames too short to carry a prefix and a payload are dropped.
      host.send(Buffer.from([0, 0, 0]));
      host.send(frameFor(conn, new Uint8Array(0)));
      await sleep(200);
      expect(client.pending()).toEqual([]);
    } finally {
      closeAll(host, client);
    }
  });
});

describe('per-workspace and per-account socket caps', () => {
  it('refuses client sockets over the caps with HTTP 429', async () => {
    const capped = await startLocalRelay({ vars: { MAX_CLIENT_SOCKETS_PER_WORKSPACE: '3', MAX_SOCKETS_PER_ACCOUNT: '2' } });
    const sockets: RelaySocket[] = [];
    try {
      const owner = await capped.devLogin('owner');
      const dave = await capped.devLogin('dave');
      const erin = await capped.devLogin('erin');
      const workspaceId = await capped.createWorkspace(owner.token);
      sockets.push((await openClient(capped, 'ws', workspaceId, { token: dave.token })).socket);
      sockets.push((await openClient(capped, 'ws', workspaceId, { token: dave.token })).socket);
      await expect(open(tunnelUrl(capped, 'ws', 'client', workspaceId), { token: dave.token })).rejects.toMatchObject({ status: 429 });
      sockets.push((await openClient(capped, 'ws', workspaceId, { token: erin.token })).socket);
      await expect(open(tunnelUrl(capped, 'ws', 'client', workspaceId), { token: erin.token })).rejects.toMatchObject({ status: 429 });
      // A socket that goes away frees its slot.
      sockets[0]?.close(1000, 'done');
      await sleep(300);
      sockets.push((await openClient(capped, 'ws', workspaceId, { token: erin.token })).socket);
    } finally {
      closeAll(...sockets);
      await capped.stop();
    }
  });
});
