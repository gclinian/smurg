import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { equalBytes, toHex } from '../bytes.ts';
import { CHANNEL_FRAME, HANDSHAKE_WIRE_VERSION } from '../channel/frames.ts';
import { HANDSHAKE_MODE_BYTES } from '../invite.ts';
import { PEER_KICK_REASON_IDLE } from '../relay/close-codes.ts';
import { MAIN_ROOT } from '../schema/paths.ts';
import { SmurgError } from '../errors.ts';
import { ClientRequestError, RelayApiError } from './errors.ts';
import type { ConnectionState } from './state.ts';
import { createMemoryResumeStore } from './storage.ts';
import { FakeDaemon } from './testing/fake-daemon.ts';
import { AMY, FAKE_TIMERS, connect, createDevice, createWorld, settle, type World } from './testing/world.ts';
import type { Connection } from './connection.ts';

function recordStates(conn: Connection): ConnectionState[] {
  const states: ConnectionState[] = [];
  conn.subscribe((state) => states.push(state));
  return states;
}

const kinds = (states: readonly ConnectionState[]): string[] => states.map((s) => s.kind);

/** Frame types the client sent through the relay on one socket. */
function clientFrameTypes(world: World, socketIndex: number): number[] {
  const ws = world.relay.sockets[socketIndex];
  if (!ws) throw new Error(`no socket ${socketIndex}`);
  return world.relay.framesOf(ws, 'client->daemon').map((f) => f[0] as number);
}

let open: Connection[] = [];
function track(conn: Connection): Connection {
  open.push(conn);
  return conn;
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS);
});

afterEach(() => {
  for (const conn of open) conn.close();
  open = [];
  vi.useRealTimers();
});

async function joinWithInvite(world: World, device = createDevice(world)) {
  const invite = world.daemon.createInvite();
  const conn = track(connect(world, device, { invite: invite.trust }));
  conn.start();
  await settle();
  return { conn, device, invite };
}

describe('first contact with an invite', () => {
  it('joins in invite mode, pins the verified daemon key before msg3 and consumes one invite use', async () => {
    const world = createWorld();
    const device = createDevice(world);
    const invite = world.daemon.createInvite({ uses: 2 });
    const conn = track(connect(world, device, { invite: invite.trust }));
    const states = recordStates(conn);
    const welcomes: boolean[] = [];
    conn.onWelcome((_w, info) => welcomes.push(info.resumed));
    expect(conn.getState()).toEqual({ kind: 'idle' });
    conn.start();
    await settle();

    expect(conn.getState().kind).toBe('online');
    expect(kinds(states)).toEqual(['connecting', 'handshaking', 'online']);
    expect(states[1]).toMatchObject({ kind: 'handshaking', mode: 'invite' });
    expect(welcomes).toEqual([false]); // the first admission is always a full sync
    expect(conn.welcome?.member).toMatchObject({ userId: AMY, role: 'editor' });
    const pinned = device.pins.pins.get(world.daemon.workspaceId);
    expect(pinned && equalBytes(pinned, world.daemon.staticKey.publicKey)).toBe(true);
    expect(world.daemon.usesLeft(invite.secret)).toBe(1);
    const key = await device.deviceKeys.getKeyPair(world.daemon.workspaceId);
    expect(world.daemon.devices.get(toHex(key.publicKey))).toEqual({ userId: AMY, revoked: false });
    // HELLO carried the invite mode byte; the relay saw HELLO, FINISH, DATA (acks/requests) only.
    const hello = world.relay.framesOf(world.relay.sockets[0]!, 'client->daemon')[0]!;
    expect([hello[0], hello[1], hello[2]]).toEqual([CHANNEL_FRAME.HELLO, HANDSHAKE_WIRE_VERSION, HANDSHAKE_MODE_BYTES.invite]);
  });

  it('asks the relay for an identity token bound to the device key through a fresh blinded cnf per handshake', async () => {
    const world = createWorld();
    const { conn, device } = await joinWithInvite(world);
    expect(conn.getState().kind).toBe('online');
    expect(device.api.identityTokenCalls).toHaveLength(1);
    const [call] = device.api.identityTokenCalls;
    expect(call?.workspaceId).toBe(world.daemon.workspaceId);
    expect(call?.cnf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The cnf is not the device key (nor its hex): the relay never sees a stable device id.
    const key = await device.deviceKeys.getKeyPair(world.daemon.workspaceId);
    expect(call?.cnf).not.toContain(toHex(key.publicKey).slice(0, 16));
  });

  it('ends in closed(no-trust) without an invite and without a pin', async () => {
    const world = createWorld();
    const conn = track(connect(world, createDevice(world)));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'no-trust' });
    expect(clientFrameTypes(world, 0)).toEqual([]);
  });
});

describe('reconnect in device mode', () => {
  it('a second connection from the same device uses the pin (XX, mode byte 2) and no invite', async () => {
    const world = createWorld();
    const { conn: first, device, invite } = await joinWithInvite(world);
    expect(first.getState().kind).toBe('online');
    first.close();

    const second = track(connect(world, device, { invite: invite.trust }));
    const states = recordStates(second);
    second.start();
    await settle();
    expect(second.getState().kind).toBe('online');
    expect(states.find((s) => s.kind === 'handshaking')).toMatchObject({ mode: 'device' });
    const hello = world.relay.framesOf(world.relay.sockets[1]!, 'client->daemon')[0]!;
    expect(hello[2]).toBe(HANDSHAKE_MODE_BYTES.device);
    // The invite was not used again.
    expect(world.daemon.usesLeft(invite.secret)).toBe(0);
    expect(world.daemon.admissions.map((a) => a.mode)).toEqual(['invite', 'device']);
  });

  it('falls back to the invite once when the daemon no longer knows the device', async () => {
    const world = createWorld();
    const device = createDevice(world);
    // A pin exists (e.g. from an earlier device key that was replaced) but the daemon never saw this key.
    await device.pins.pin(world.daemon.workspaceId, world.daemon.staticKey.publicKey);
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, device, { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState().kind).toBe('connecting'); // rejected in device mode, retrying at once with the invite
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(conn.getState().kind).toBe('online');
    expect(world.daemon.admissions.map((a) => [a.mode, a.accepted])).toEqual([
      ['device', false],
      ['invite', true],
    ]);
  });
});

describe('a changed daemon key is never accepted silently (noise.md gotcha 16)', () => {
  it('an invite for another daemon key does not replace the pin through the fallback', async () => {
    const world = createWorld();
    const device = createDevice(world);
    const oldKey = new FakeDaemon().staticKey.publicKey; // the host reinstalled: the pin is from the old daemon
    await device.pins.pin(world.daemon.workspaceId, oldKey);
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, device, { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'key-mismatch', mode: 'device', detail: 'fingerprint' });
    expect(equalBytes(device.pins.pins.get(world.daemon.workspaceId)!, oldKey)).toBe(true);
    expect(world.daemon.usesLeft(invite.secret)).toBe(1);
  });

  it('preferInvite (the person chose the fresh invite link) verifies the new key against the invite and re-pins', async () => {
    const world = createWorld();
    const device = createDevice(world);
    await device.pins.pin(world.daemon.workspaceId, new FakeDaemon().staticKey.publicKey);
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, device, { invite: invite.trust, preferInvite: true }));
    conn.start();
    await settle();
    expect(conn.getState().kind).toBe('online');
    expect(equalBytes(device.pins.pins.get(world.daemon.workspaceId)!, world.daemon.staticKey.publicKey)).toBe(true);
  });
});

describe('key mismatch (SPEC R3: the relay substitutes the daemon key)', () => {
  it('pinned mode: an impostor host is refused as key-mismatch, msg3 is never sent and nothing reconnects', async () => {
    const world = createWorld();
    const { conn: first, device } = await joinWithInvite(world);
    first.close();
    // The relay now routes the workspace to a host with another static key.
    const impostor = new FakeDaemon({ workspaceId: world.daemon.workspaceId });
    world.relay.attachHost('ws', impostor);
    const conn = track(connect(world, device));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'key-mismatch', mode: 'device', detail: 'fingerprint' });
    const types = clientFrameTypes(world, 1);
    expect(types).toContain(CHANNEL_FRAME.HELLO);
    expect(types).not.toContain(CHANNEL_FRAME.FINISH); // nothing about this device left the client
    expect(impostor.admissions).toEqual([]);
    const sockets = world.relay.sockets.length;
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(world.relay.sockets.length).toBe(sockets);
    // The pin is untouched.
    expect(equalBytes(device.pins.pins.get(world.daemon.workspaceId)!, world.daemon.staticKey.publicKey)).toBe(true);
  });

  it('invite mode, worst case (the relay knows the invite secret): the fingerprint check refuses the impostor', async () => {
    const world = createWorld({ attach: false });
    const invite = world.daemon.createInvite();
    const impostor = new FakeDaemon({ workspaceId: world.daemon.workspaceId });
    impostor.createInvite({ secret: invite.secret });
    world.relay.attachHost('ws', impostor);
    const device = createDevice(world);
    const conn = track(connect(world, device, { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'key-mismatch', mode: 'invite', detail: 'fingerprint' });
    expect(clientFrameTypes(world, 0)).not.toContain(CHANNEL_FRAME.FINISH);
    expect(device.pins.pins.size).toBe(0);
    expect(impostor.usesLeft(invite.secret)).toBe(1);
  });

  it('invite mode, relay without the secret: msg2 does not authenticate → key-mismatch (unauthenticated)', async () => {
    const world = createWorld({ attach: false });
    const invite = world.daemon.createInvite();
    // Without the invite id the impostor cannot even verify msg1; the best it can do is answer something REPLY-shaped.
    world.relay.attachHost('ws', {
      openConn(info) {
        return {
          receive(frame) {
            if (frame[0] !== CHANNEL_FRAME.HELLO) return;
            const reply = new Uint8Array(1 + 32 + 48 + 16).fill(7);
            reply[0] = CHANNEL_FRAME.REPLY;
            info.send(reply);
          },
          close() {},
        };
      },
    });
    const device = createDevice(world);
    const conn = track(connect(world, device, { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'key-mismatch', mode: 'invite', detail: 'unauthenticated' });
    expect(clientFrameTypes(world, 0)).not.toContain(CHANNEL_FRAME.FINISH);
    expect(device.pins.pins.size).toBe(0);
  });
});

describe('rejected verdicts', () => {
  it.each(['kicked', 'device-revoked', 'device-other-account', 'identity-invalid', 'version'] as const)('%s is terminal: rejected(reason), no reconnect', async (reason) => {
    const world = createWorld();
    world.daemon.verdictOverride = reason;
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'rejected', reason });
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(world.relay.sockets).toHaveLength(1);
  });

  it('an expired invite is rejected (invite-invalid) and consumes nothing', async () => {
    const world = createWorld();
    const invite = world.daemon.createInvite({ ttlMs: 1_000 });
    vi.advanceTimersByTime(2_000);
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'rejected', reason: 'invite-invalid' });
  });

  it('busy is transient: the client retries with backoff and gets in once the daemon accepts', async () => {
    const world = createWorld();
    world.daemon.verdictOverride = 'busy';
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    const states = recordStates(conn);
    conn.start();
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'connecting', cause: 'busy', attempt: 2 });
    const retryAt = (conn.getState() as { retryAt: number }).retryAt;
    expect(retryAt - Date.now()).toBe(375); // attempt 1: ceiling 500 ms, jitter 0.5 with random() = 0.5
    world.daemon.verdictOverride = null;
    await vi.advanceTimersByTimeAsync(375);
    await settle();
    // The busy attempt already pinned the key (msg2), so the retry tries the pin first: the daemon does not know
    // the device yet (admit never accepted it), and the client falls back to the unspent invite right away.
    expect(conn.getState()).toMatchObject({ kind: 'connecting', retryAt: Date.now(), cause: null });
    // (fake timers run a 0 ms timer scheduled during a tick 1 ms later)
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(conn.getState().kind).toBe('online');
    expect(world.daemon.admissions.map((a) => [a.mode, a.accepted, a.reason])).toEqual([
      ['invite', false, 'busy'],
      ['device', false, 'device-revoked'],
      ['invite', true, undefined],
    ]);
    expect(states.filter((s) => s.kind === 'handshaking').map((s) => (s as { mode: string }).mode)).toEqual(['invite', 'device', 'invite']);
  });

  it('an empty verdict (the daemon admit() failed) ends as rejected(unknown)', async () => {
    const world = createWorld();
    world.daemon.failAdmit = true;
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'rejected', reason: 'unknown' });
  });

  // Security review F4: a flood can keep a daemon's handshake budget empty; a member's device must come back by
  // itself afterwards instead of ending in a terminal state after three unauthenticated ABORTs.
  it('device mode: generic ABORTs (a daemon over budget) are retried with capped backoff, never terminal', async () => {
    const world = createWorld();
    const { conn: first, device } = await joinWithInvite(world);
    expect(first.getState().kind).toBe('online');
    first.close();
    world.daemon.refuseHandshakes = 12;
    const again = track(connect(world, device, { backoff: { baseMs: 100, maxMs: 1_000 } }));
    const states = recordStates(again);
    const waits: number[] = [];
    again.subscribe((s) => {
      if (s.kind === 'connecting' && s.retryAt !== null) waits.push(s.retryAt - Date.now());
    });
    again.start();
    for (let i = 0; i < 40 && again.getState().kind !== 'online'; i++) await advance(1_000);
    expect(again.getState().kind).toBe('online');
    expect(states.filter((s) => s.kind === 'connecting' && s.cause === 'aborted').length).toBeGreaterThanOrEqual(12);
    expect(states.some((s) => s.kind === 'rejected')).toBe(false);
    // Capped: no retry waited longer than backoff.maxMs.
    expect(Math.max(...waits)).toBeLessThanOrEqual(1_000);
  });

  it('invite mode: consecutive generic ABORTs (no such invite on the daemon) still end as rejected(aborted)', async () => {
    const world = createWorld();
    world.daemon.refuseHandshakes = 100;
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, createDevice(world), { invite: invite.trust, backoff: { baseMs: 10, maxMs: 10 } }));
    conn.start();
    for (let i = 0; i < 10 && conn.getState().kind !== 'rejected'; i++) await advance(100);
    expect(conn.getState()).toEqual({ kind: 'rejected', reason: 'aborted' });
  });

  it('an unknown device in device mode without an invite is refused (terminal)', async () => {
    const world = createWorld();
    const device = createDevice(world);
    await device.pins.pin(world.daemon.workspaceId, world.daemon.staticKey.publicKey);
    const conn = track(connect(world, device));
    conn.start();
    await settle();
    expect(conn.getState()).toEqual({ kind: 'rejected', reason: 'device-revoked' });
  });
});

const LOCK_LIST_OK = { locks: [] };
const changed = (path: string) => ({ root: MAIN_ROOT, changes: [{ path, change: 'change' as const }] });

async function online(world: World, options: Parameters<typeof connect>[2] = {}) {
  const device = createDevice(world);
  const invite = world.daemon.createInvite({ uses: 5 });
  const conn = track(connect(world, device, { invite: invite.trust, ...options }));
  conn.start();
  await settle();
  expect(conn.getState().kind).toBe('online');
  return { conn, device, invite };
}

/** Advance fake time and let the in-memory world settle. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

describe('requests and events', () => {
  it('resolves a request with the typed .ok payload and correlates concurrent requests by id', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => LOCK_LIST_OK;
    world.daemon.handlers['file.stat'] = (p: { root: unknown; path: string }) => ({
      entry: { name: p.path, path: p.path, kind: 'file', size: p.path.length, mtime: 1 },
    });
    const { conn } = await online(world);
    const [a, b, locks] = await Promise.all([
      conn.request('file.stat', { root: MAIN_ROOT, path: 'a.txt' }),
      conn.request('file.stat', { root: MAIN_ROOT, path: 'bb.txt' }),
      conn.request('lock.list', {}),
    ]);
    expect(a.entry.size).toBe(5);
    expect(b.entry.size).toBe(6);
    expect(locks).toEqual(LOCK_LIST_OK);
    // c→d seqs are 1, 2, 3 in the order of the calls.
    expect(world.daemon.received.map((r) => [r.type, r.seq])).toEqual([
      ['file.stat', 1],
      ['file.stat', 2],
      ['lock.list', 3],
    ]);
  });

  it('rejects with the daemon SmurgError (code, message, detail)', async () => {
    const world = createWorld();
    world.daemon.handlers['file.write'] = () => {
      throw new SmurgError('forbidden', '旁觀者不能寫入', { reason: 'role' });
    };
    const { conn } = await online(world);
    const error = await conn.request('file.write', { file: { root: MAIN_ROOT, path: 'x' }, content: new Uint8Array([1]) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmurgError);
    expect(error).toMatchObject({ code: 'forbidden', message: '旁觀者不能寫入', detail: { reason: 'role' } });
    expect(error).not.toBeInstanceOf(ClientRequestError);
  });

  it('refuses an invalid payload before anything is sent', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    const sent = world.relay.frames.length;
    // @ts-expect-error — path must be a string
    const error = await conn.request('file.stat', { root: MAIN_ROOT, path: 42 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'bad_request', detail: { reason: 'payload' } });
    await settle();
    expect(world.relay.frames.length).toBe(sent);
  });

  it('times out with ClientRequestError(timeout); a late answer is ignored', async () => {
    const world = createWorld();
    let answer: (value: unknown) => void = () => {};
    world.daemon.handlers['lock.list'] = () => new Promise((resolve) => (answer = resolve));
    const diagnostics: string[] = [];
    const { conn } = await online(world, { requestTimeoutMs: 5_000, onDiagnostic: (d) => diagnostics.push(d.kind) });
    const pending = conn.request('lock.list', {}).catch((e: unknown) => e);
    await advance(4_999);
    const early = await Promise.race([pending, Promise.resolve('still pending')]);
    expect(early).toBe('still pending');
    await advance(1);
    const error = await pending;
    expect(error).toBeInstanceOf(ClientRequestError);
    expect(error).toMatchObject({ failure: 'timeout', code: 'internal', detail: { reason: 'timeout' } });
    answer(LOCK_LIST_OK);
    await settle();
    expect(diagnostics).toContain('uncorrelated-response');
    expect(conn.getState().kind).toBe('online');
  });

  it('a per-call timeout and an AbortSignal override the default', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => new Promise(() => {});
    const { conn } = await online(world);
    const quick = conn.request('lock.list', {}, { timeoutMs: 100 }).catch((e: unknown) => e);
    const controller = new AbortController();
    const cancelled = conn.request('lock.list', {}, { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(await cancelled).toMatchObject({ failure: 'cancelled' });
    await advance(100);
    expect(await quick).toMatchObject({ failure: 'timeout' });
  });

  it('delivers events to typed listeners, isolates a throwing listener and supports unsubscribe', async () => {
    const world = createWorld();
    const diagnostics: string[] = [];
    const { conn } = await online(world, { onDiagnostic: (d) => diagnostics.push(d.kind) });
    const seen: string[] = [];
    conn.on('file.changed', () => {
      throw new Error('listener bug');
    });
    const off = conn.on('file.changed', (payload, meta) => {
      seen.push(`${payload.changes[0]?.path}@${meta.seq}`);
    });
    world.daemon.broadcast('file.changed', changed('a.txt'));
    await settle();
    off();
    world.daemon.broadcast('file.changed', changed('b.txt'));
    await settle();
    expect(seen).toEqual(['a.txt@1']);
    expect(diagnostics.filter((d) => d === 'listener-error')).toHaveLength(2);
    expect(conn.getState().kind).toBe('online');
  });

  it('an error that answers no request goes to on("error")', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    const errors: unknown[] = [];
    conn.on('error', (payload) => errors.push(payload));
    world.daemon.broadcast('error', { code: 'forbidden', message: 'doc.sync dropped' });
    await settle();
    expect(errors).toEqual([{ code: 'forbidden', message: 'doc.sync dropped' }]);
  });

  it('notify() sends one-way messages in the same seq space and acknowledges daemon messages with unsequenced acks', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    expect(conn.notify('presence.update', { activeFile: { root: MAIN_ROOT, path: 'a.txt' } })).toBe(true);
    expect(conn.notify('doc.sync', { docId: 'doc_1', data: new Uint8Array([0, 0, 1, 0]) })).toBe(true);
    world.daemon.broadcast('file.changed', changed('a.txt'));
    world.daemon.broadcast('file.changed', changed('b.txt'));
    await settle();
    expect(world.daemon.received.map((r) => [r.type, r.seq])).toEqual([
      ['presence.update', 1],
      ['doc.sync', 2],
    ]);
    expect(world.daemon.acksReceived).toEqual([]);
    await advance(500); // ACK_DELAY_MS
    expect(world.daemon.acksReceived).toEqual([2]);
    expect(world.daemon.channelOf(AMY)?.outbox).toEqual([]);
  });

  it('rejects with overflow when the outbox budget is exhausted', async () => {
    const world = createWorld({ autoAck: false });
    world.daemon.handlers['file.write'] = () => ({ entry: { name: 'x', path: 'x', kind: 'file', size: 1, mtime: 1 }, hash: 'a'.repeat(64) });
    const { conn } = await online(world, { maxOutboxBytes: 4096 });
    const big = { file: { root: MAIN_ROOT, path: 'x' }, content: new Uint8Array(3000) };
    await conn.request('file.write', big); // answered, but never acknowledged: it stays in the outbox
    const error = await conn.request('file.write', big).catch((e: unknown) => e);
    expect(error).toMatchObject({ failure: 'overflow' });
  });
});

describe('resume after a reconnect (ARCHITECTURE §4)', () => {
  it('replays what the daemon sent while the client was away, exactly once, and re-sends the unanswered request', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => LOCK_LIST_OK;
    const { conn } = await online(world);
    const states = recordStates(conn);
    const welcomes: boolean[] = [];
    conn.onWelcome((_w, info) => welcomes.push(info.resumed));
    const seen: string[] = [];
    conn.on('file.changed', (p) => seen.push(p.changes[0]!.path));
    world.daemon.broadcast('file.changed', changed('1'));
    await advance(500);
    const channelId = conn.welcome?.channelId;

    world.relay.drop(world.relay.lastSocket()); // the socket dies, no bye
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'relay-unreachable', cause: 'closed', attempt: 2 });
    world.daemon.broadcast('file.changed', changed('2'));
    world.daemon.broadcast('file.changed', changed('3'));
    const request = conn.request('lock.list', {}); // queued while disconnected
    await advance(500);
    await settle();

    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
    expect(conn.welcome?.channelId).toBe(channelId);
    expect(await request).toEqual(LOCK_LIST_OK);
    expect(seen).toEqual(['1', '2', '3']);
    expect(welcomes).toEqual([true]);
    expect(kinds(states)).toEqual(['relay-unreachable', 'connecting', 'handshaking', 'online']);
    expect(world.daemon.duplicates).toBe(0);
  });

  it('the ClientHello carries protocol version, identity token, cnf nonce, and the resume position after a reconnect', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    const [first] = world.daemon.hellos;
    expect(first).toMatchObject({ protocolVersion: 1, purpose: 'interactive', clientKind: 'web', deviceName: 'Test browser' });
    expect(first?.resume).toBeUndefined();
    expect(first?.cnfNonce).toHaveLength(32);
    world.daemon.broadcast('file.changed', changed('1'));
    world.daemon.broadcast('file.changed', changed('2'));
    await settle();
    world.relay.drop(world.relay.lastSocket());
    await advance(500);
    const second = world.daemon.hellos[1];
    expect(second?.resume).toEqual({ channelId: conn.welcome?.channelId, lastSeq: 2 });
    expect(second?.identityToken).not.toBe(first?.identityToken); // fresh token and nonce per handshake
    expect(second?.cnfNonce).not.toEqual(first?.cnfNonce);
  });

  it('a request that already failed (timeout) is not replayed on the resumed channel: a retry never makes it happen twice (REL-03)', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => LOCK_LIST_OK;
    const { conn } = await online(world, { requestTimeoutMs: 1_500 });
    const channelId = conn.welcome?.channelId;
    world.relay.blackhole = true; // the path stalls (Wi-Fi drop, lid closed): the request is sent but never arrives
    const first = conn.request('lock.list', {}).catch((e: unknown) => e);
    await advance(1_500);
    // Sent, so the outcome is unknown (the daemon may have it): the caller is told so.
    expect(await first).toMatchObject({ failure: 'timeout', detail: { reason: 'timeout', sent: true } });
    world.relay.blackhole = false;
    world.relay.drop(world.relay.lastSocket());
    await advance(1_000);
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
    expect(conn.welcome?.channelId).toBe(channelId);
    expect(world.daemon.receivedOf('lock.list')).toHaveLength(0); // the failed request did not come back to life
    expect(await conn.request('lock.list', {})).toEqual(LOCK_LIST_OK); // the person's retry
    expect(world.daemon.receivedOf('lock.list')).toHaveLength(1);
  });

  it('an answer lost with the socket is replayed and still resolves the request', async () => {
    const world = createWorld();
    let answer: (value: unknown) => void = () => {};
    world.daemon.handlers['lock.list'] = () => new Promise((resolve) => (answer = resolve));
    const { conn } = await online(world);
    const request = conn.request('lock.list', {});
    await settle();
    world.relay.drop(world.relay.lastSocket());
    await settle();
    answer(LOCK_LIST_OK); // the daemon answers while the client is away: it waits in the outbox
    await settle();
    await advance(500);
    expect(conn.getState().kind).toBe('online');
    expect(await request).toEqual(LOCK_LIST_OK);
    expect(world.daemon.receivedOf('lock.list')).toHaveLength(1);
  });

  it('de-duplicates both ways: the daemon drops a re-sent request it already processed, the client drops replayed events', async () => {
    const world = createWorld({ autoAck: false });
    world.daemon.ignoreClientAcks = true;
    world.daemon.replayOverlap = 2;
    let calls = 0;
    world.daemon.handlers['lock.list'] = () => {
      calls++;
      return LOCK_LIST_OK;
    };
    const { conn } = await online(world);
    const seen: string[] = [];
    conn.on('file.changed', (p) => seen.push(p.changes[0]!.path));
    world.daemon.broadcast('file.changed', changed('1'));
    world.daemon.broadcast('file.changed', changed('2'));
    expect(await conn.request('lock.list', {})).toEqual(LOCK_LIST_OK); // processed, but never acknowledged
    await advance(500);
    world.relay.drop(world.relay.lastSocket());
    await settle();
    world.daemon.broadcast('file.changed', changed('3'));
    await advance(500);
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
    // The client re-sent seq 1 (unacknowledged): the daemon saw it again and dropped it.
    expect(world.daemon.duplicates).toBe(1);
    expect(calls).toBe(1);
    // The daemon replayed two messages the client already had: the client dropped them.
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('a gap the daemon can no longer fill gives resumed = false: resync signal, in-flight requests fail, queued ones go out', async () => {
    const world = createWorld();
    world.daemon.handlers['file.stat'] = () => new Promise(() => {}); // in flight forever
    world.daemon.handlers['lock.list'] = () => LOCK_LIST_OK;
    const { conn } = await online(world);
    const welcomes: boolean[] = [];
    conn.onWelcome((_w, info) => welcomes.push(info.resumed));
    const seen: string[] = [];
    conn.on('file.changed', (p) => seen.push(p.changes[0]!.path));
    const inFlight = conn.request('file.stat', { root: MAIN_ROOT, path: 'a' }).catch((e: unknown) => e);
    await settle();
    const oldChannel = conn.welcome?.channelId;
    world.relay.drop(world.relay.lastSocket());
    await settle();
    world.daemon.broadcast('file.changed', changed('lost'));
    world.daemon.dropOutbox(); // e.g. the outbox overflowed while the client was away
    const queued = conn.request('lock.list', {});
    await advance(500);

    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: false });
    expect(conn.welcome?.channelId).not.toBe(oldChannel);
    expect(welcomes).toEqual([false]);
    expect(await inFlight).toMatchObject({ failure: 'connection-lost' });
    expect(await queued).toEqual(LOCK_LIST_OK);
    expect(seen).toEqual([]); // nothing from the old channel is delivered; the application resyncs
    // The queued request was renumbered into the new channel's seq space.
    const lock = world.daemon.receivedOf('lock.list')[0];
    expect(lock?.seq).toBe(1);
    expect(lock?.channelId).toBe(conn.welcome?.channelId);
  });

  it('continues a persisted position from a ResumeStore without reusing seqs', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => LOCK_LIST_OK;
    const resumeStore = createMemoryResumeStore();
    const { conn, device } = await online(world, { resumeStore });
    await conn.request('lock.list', {});
    world.daemon.broadcast('file.changed', changed('1'));
    await advance(1_500);
    const saved = resumeStore.states.get(world.daemon.workspaceId);
    expect(saved).toMatchObject({ channelId: conn.welcome?.channelId, lastSeq: 2, nextSeq: 2 });
    conn.close();
    world.daemon.broadcast('file.changed', changed('2'));

    const next = track(connect(world, device, { resumeStore }));
    const seen: string[] = [];
    next.on('file.changed', (p) => seen.push(p.changes[0]!.path));
    next.start();
    await settle();
    expect(next.getState()).toMatchObject({ kind: 'online', resumed: true });
    expect(seen).toEqual(['2']);
    await next.request('lock.list', {});
    expect(world.daemon.receivedOf('lock.list').at(-1)?.seq).toBeGreaterThan(1_000_000);
  });
});

describe('liveness', () => {
  it('pong watchdog: a silently dead relay path is detected within PONG_WATCHDOG_MS and the client reconnects', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    world.relay.answerPings = false;
    const deadAt = Date.now();
    let unreachableAt = 0;
    conn.subscribe((s) => {
      if (s.kind === 'relay-unreachable' && unreachableAt === 0) unreachableAt = Date.now();
    });
    for (let i = 0; i < 20 && unreachableAt === 0; i++) await advance(500);
    expect(conn.getState()).toMatchObject({ kind: 'relay-unreachable', cause: 'watchdog' });
    // 6 s after the first unanswered ping, plus timer granularity; the ping went out ≤ 2 s after the path died.
    expect(unreachableAt - deadAt).toBeGreaterThanOrEqual(6_000);
    expect(unreachableAt - deadAt).toBeLessThanOrEqual(8_500);
    world.relay.answerPings = true;
    await advance(1_000);
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
  });

  it('host offline by relay frame: immediate, the socket stays, and host.online re-handshakes with resume', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => LOCK_LIST_OK;
    const { conn } = await online(world);
    const sockets = world.relay.sockets.length;
    world.relay.detachHost('ws', 'timeout');
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'host-offline', reason: 'relay' });
    const request = conn.request('lock.list', {});
    await advance(20_000);
    expect(conn.getState().kind).toBe('host-offline');
    world.relay.attachHost('ws', world.daemon);
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
    expect(await request).toEqual(LOCK_LIST_OK);
    expect(world.relay.sockets.length).toBe(sockets);
  });

  it('host.offline immediately followed by host.online (a fast host reconnect) ends online again', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    world.relay.detachHost('ws', 'closed');
    world.relay.attachHost('ws', world.daemon);
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
  });

  it('a relay hello with host:false waits in host-offline, then connects on host.online', async () => {
    const world = createWorld({ attach: false });
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'host-offline', reason: 'relay' });
    world.relay.attachHost('ws', world.daemon);
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: false });
  });

  it('host offline by silence (R1): no daemon message for 8 s → host-offline although the relay says nothing', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    let lastHeard = 0;
    conn.on('presence.heartbeat', () => {
      lastHeard = Date.now();
    });
    world.daemon.startHeartbeat(3_000);
    await advance(30_000);
    expect(conn.getState().kind).toBe('online');
    world.daemon.stopHeartbeat(); // the daemon froze with its sockets still open
    let offlineAt = 0;
    conn.subscribe((s) => {
      if (s.kind === 'host-offline' && offlineAt === 0) offlineAt = Date.now();
    });
    for (let i = 0; i < 60 && offlineAt === 0; i++) await advance(250);
    expect(conn.getState()).toMatchObject({ kind: 'host-offline', reason: 'silence' });
    expect(offlineAt - lastHeard).toBeGreaterThanOrEqual(8_000);
    expect(offlineAt - lastHeard).toBeLessThanOrEqual(8_500); // threshold + one tick; SPEC R1 allows 10 s
    world.daemon.startHeartbeat(3_000);
    await advance(3_000);
    expect(conn.getState()).toMatchObject({ kind: 'online' });
    world.daemon.stopHeartbeat();
  });

  it('prolonged silence while the relay claims the host is online starts over on a fresh socket', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    const sockets = world.relay.sockets.length;
    const states = recordStates(conn);
    await advance(20_500);
    expect(kinds(states)).toContain('host-offline');
    expect(states.find((s) => s.kind === 'connecting')).toMatchObject({ cause: 'stalled' });
    await advance(1_000);
    expect(world.relay.sockets.length).toBe(sockets + 1);
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
  });
});

describe('kick, bye and other endings', () => {
  it('kick (channel.closed{kicked} then bye 4003): closed(kicked), pending requests fail, never reconnects', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => new Promise(() => {});
    const { conn } = await online(world);
    const pending = conn.request('lock.list', {}).catch((e: unknown) => e);
    const closedReasons: string[] = [];
    conn.on('channel.closed', (p) => closedReasons.push(p.reason));
    world.daemon.kick(AMY);
    await settle();
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'kicked', daemonReason: 'kicked' });
    expect(closedReasons).toEqual(['kicked']);
    expect(await pending).toMatchObject({ failure: 'closed' });
    const sockets = world.relay.sockets.length;
    await advance(120_000);
    expect(world.relay.sockets.length).toBe(sockets);
    await expect(conn.request('lock.list', {})).rejects.toMatchObject({ failure: 'closed' });
    expect(() => conn.notify('presence.update', {})).toThrow(ClientRequestError);
  });

  it('bye 4003 alone (the relay executes a kick) is also final, without waiting for the late close event', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    world.relay.kick(world.relay.lastSocket(), 'kicked', 16_000); // Node sees the FIN 10-16 s later
    await settle();
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'kicked' });
    const sockets = world.relay.sockets.length;
    await advance(60_000);
    expect(world.relay.sockets.length).toBe(sockets);
  });

  it('bye 4003 with the daemon\'s idle reason (a socket that never finished its handshake) is not a removal: it reconnects', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    world.relay.kick(world.relay.lastSocket(), PEER_KICK_REASON_IDLE);
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'relay-unreachable', cause: 'bye' });
    await advance(2_000);
    expect(conn.getState().kind).toBe('online');
  });

  it('any other bye: acts at once (relay-unreachable), reconnects with backoff while the old close is still pending', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    const first = world.relay.lastSocket();
    world.relay.bye(first, 1009, 'too big', 16_000);
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'relay-unreachable', cause: 'bye' });
    await advance(500);
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
    expect(first.readyState).not.toBe(1);
    expect(world.relay.sockets.length).toBe(2);
  });

  it('channel.closed{role-changed}: reconnects immediately and learns the new role', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    expect(conn.welcome?.member.role).toBe('editor');
    world.daemon.setRole(AMY, 'viewer');
    world.daemon.closeChannels(AMY, 'role-changed', { kick: true });
    await settle();
    await advance(1);
    expect(conn.getState()).toMatchObject({ kind: 'online' });
    expect(conn.welcome?.member.role).toBe('viewer');
  });

  it('channel.closed{revoked} is final', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    world.daemon.closeChannels(AMY, 'revoked');
    await settle();
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'revoked', daemonReason: 'revoked' });
  });

  it('logged out: a refused socket is diagnosed through /api/me and ends as closed(login-required)', async () => {
    const world = createWorld();
    const { conn, device } = await online(world);
    device.api.loggedIn = false;
    world.relay.drop(world.relay.lastSocket());
    await advance(500);
    await settle();
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'login-required' });
    expect(device.api.meCalls).toBeGreaterThan(0);
  });

  it('an identity-token refusal (401) ends as closed(login-required); a relay 5xx is retried', async () => {
    const world = createWorld();
    const device = createDevice(world);
    device.api.identityTokenError = new RelayApiError(503, 'http_503', 'unavailable');
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, device, { invite: invite.trust }));
    conn.start();
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'relay-unreachable', cause: 'relay-error' });
    device.api.identityTokenError = new RelayApiError(401, 'unauthorized', 'login required');
    await advance(500);
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'login-required' });
  });

  it('close(): pending requests reject with closed, the socket goes away, nothing reconnects', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => new Promise(() => {});
    const { conn } = await online(world);
    const pending = conn.request('lock.list', {}).catch((e: unknown) => e);
    await settle();
    conn.close();
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'local' });
    expect(await pending).toMatchObject({ failure: 'closed' });
    await settle();
    expect(world.relay.openClients()).toHaveLength(0);
    await advance(60_000);
    expect(world.relay.sockets).toHaveLength(1);
  });

  it('relay unreachable: retries with growing jittered delays and never gives up', async () => {
    const world = createWorld();
    world.relay.refuseConnections = true;
    const invite = world.daemon.createInvite({ ttlMs: 3_600_000 });
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    const delays: number[] = [];
    conn.subscribe((s) => {
      if (s.kind === 'relay-unreachable') delays.push(s.retryAt - Date.now());
    });
    const states = recordStates(conn);
    conn.start();
    await settle();
    for (let i = 0; i < 7; i++) await advance(30_000);
    expect(delays.slice(0, 7)).toEqual([375, 750, 1_500, 3_000, 6_000, 12_000, 22_500]);
    expect(kinds(states)).not.toContain('online');
    world.relay.refuseConnections = false;
    await advance(30_000);
    expect(kinds(states)).toContain('online');
  });
});

describe('more lifecycle details', () => {
  it('requests and notifications made before start() wait in the outbox and go out in order once online', async () => {
    const world = createWorld();
    world.daemon.handlers['lock.list'] = () => LOCK_LIST_OK;
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    const early = conn.request('lock.list', {});
    expect(conn.notify('presence.update', {})).toBe(true);
    expect(conn.notify('presence.update', {}, { whenDisconnected: 'drop' })).toBe(false);
    conn.start();
    await settle();
    expect(await early).toEqual(LOCK_LIST_OK);
    expect(world.daemon.received.map((r) => [r.type, r.seq])).toEqual([
      ['lock.list', 1],
      ['presence.update', 2],
    ]);
  });

  it('whenOnline() resolves with the Welcome, or rejects with ConnectionEndedError on a terminal state', async () => {
    const world = createWorld();
    const invite = world.daemon.createInvite();
    const conn = track(connect(world, createDevice(world), { invite: invite.trust }));
    const welcome = conn.whenOnline();
    conn.start();
    await settle();
    expect((await welcome).member.userId).toBe(AMY);

    world.daemon.verdictOverride = 'kicked';
    const refused = track(connect(world, createDevice(world), { invite: world.daemon.createInvite().trust }));
    const failed = refused.whenOnline().catch((e: unknown) => e);
    refused.start();
    await settle();
    expect(await failed).toMatchObject({ name: 'ConnectionEndedError', state: { kind: 'rejected', reason: 'kicked' } });
  });

  it('channel.closed{stopped}: host-offline(stopped) until the host is back, then a fresh resync', async () => {
    const world = createWorld();
    const { conn } = await online(world);
    world.daemon.closeChannels(AMY, 'stopped');
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'host-offline', reason: 'stopped' });
    world.relay.detachHost('ws', 'closed');
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'host-offline', reason: 'relay' });
    world.daemon.restart(); // `smurg host` again: a new daemon process, same keys
    world.relay.attachHost('ws', world.daemon);
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: false });
  });

  it('an integrity failure on the established channel starts over on a fresh socket and resumes', async () => {
    const world = createWorld();
    const diagnostics: string[] = [];
    const { conn } = await online(world, { onDiagnostic: (d) => diagnostics.push(d.kind === 'channel-error' ? `channel-error:${d.code}` : d.kind) });
    const ws = world.relay.lastSocket();
    // The relay injects a forged DATA frame: AEAD fails, the channel is dead for good.
    ws.fireMessage(new Uint8Array([0x10, 0, 20, ...new Array<number>(20).fill(1)]).buffer);
    await settle();
    expect(conn.getState()).toMatchObject({ kind: 'connecting', cause: 'protocol' });
    await advance(500);
    expect(conn.getState()).toMatchObject({ kind: 'online', resumed: true });
    expect(world.relay.sockets.length).toBe(2);
    expect(diagnostics).toContain('channel-error:integrity');
  });

  it('leave(): sends channel.leave, then closes', async () => {
    const world = createWorld();
    world.daemon.handlers['channel.leave'] = () => ({});
    const { conn } = await online(world);
    await conn.leave();
    expect(world.daemon.receivedOf('channel.leave')).toHaveLength(1);
    expect(conn.getState()).toEqual({ kind: 'closed', reason: 'local' });
  });

  it('never logs payloads: diagnostics carry kinds and codes only', async () => {
    const world = createWorld();
    const seen: unknown[] = [];
    const { conn } = await online(world, { onDiagnostic: (d) => seen.push(d) });
    conn.on('file.changed', () => {
      throw new Error('boom');
    });
    world.daemon.broadcast('file.changed', changed('SECRET-PATH-MARKER-0123456789'));
    await settle();
    expect(JSON.stringify(seen.map((d) => ({ ...(d as object), error: undefined })))).not.toContain('SECRET-PATH-MARKER');
  });
});
