// Handshake deadlines and rate limits (ARCHITECTURE §4.2; noise.md gotcha 3): a plain-XX HELLO is 32 arbitrary
// bytes, so the daemon bounds how long a handshake may take, how many run at once and per minute, and how many may
// fail on one relay connection before the relay is told to drop it.
import { afterEach, describe, expect, it } from 'vitest';
import { CHANNEL_FRAME, HANDSHAKE_MODE_BYTES, HANDSHAKE_WIRE_VERSION, randomBytes } from '@smurg/protocol';
import { waitForState } from '@smurg/protocol/client';
import { wsClientUrl } from '@smurg/protocol/relay';
import { MEMORY_RELAY_ORIGIN, type MemoryClientSocket } from '../src/testing/memory-relay.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function rawClient(t: TestDaemon): Promise<{ socket: MemoryClientSocket; binary: Uint8Array[]; texts: string[] }> {
  const socket = t.relay.connectClient(wsClientUrl(MEMORY_RELAY_ORIGIN, t.workspaceId), { userId: 'dev:mallory', displayName: 'Mallory' });
  const binary: Uint8Array[] = [];
  const texts: string[] = [];
  socket.addEventListener('message', (event: { data: unknown }) => {
    if (typeof event.data === 'string') texts.push(event.data);
    else binary.push(new Uint8Array(event.data as ArrayBuffer));
  });
  await waitFor(() => texts.some((text) => text.includes('"hello"')), { what: 'relay hello' });
  return { socket, binary, texts };
}

describe('handshake limits', () => {
  it('answers garbage with the generic ABORT and has the relay drop a connection after 5 failed handshakes', async () => {
    t = await createTestDaemon();
    const client = await rawClient(t);
    for (let i = 1; i <= 5; i++) {
      client.socket.send(new Uint8Array([CHANNEL_FRAME.HELLO, 0xff, 0xff, 1, 2, 3]));
      await waitFor(() => client.binary.length === i, { what: `abort ${i}` });
      expect([...(client.binary[i - 1] as Uint8Array)]).toEqual([0x7f, 0x00]);
    }
    await waitFor(() => client.socket.readyState === 3, { what: 'relay drops the socket' });
    expect(client.texts).toContain(JSON.stringify({ t: 'bye', code: 4003, reason: 'too many failed handshakes' }));
    expect(t.daemon.status().handshakes.kickedForFailures).toBe(1);
    const audit = await t.ctx.audit.query({ limit: 20 });
    expect(audit.find((e) => e.action === 'auth.rejected')?.detail).toMatchObject({ reason: 'too-many-failed-handshakes', failures: 5 });
  });

  it('gives up on a handshake that stalls after msg1 (deadline)', async () => {
    t = await createTestDaemon({ timing: { handshakeDeadlineMs: 100 } });
    const client = await rawClient(t);
    // A syntactically valid device-mode HELLO: 32 random bytes are an acceptable X25519 ephemeral.
    client.socket.send(new Uint8Array([CHANNEL_FRAME.HELLO, HANDSHAKE_WIRE_VERSION, HANDSHAKE_MODE_BYTES.device, ...randomBytes(32)]));
    await waitFor(() => client.binary.length === 1, { what: 'REPLY' });
    expect(client.binary[0]?.[0]).toBe(CHANNEL_FRAME.REPLY);
    await waitFor(() => t?.daemon.status().handshakes.failed === 1, { what: 'deadline' });
    expect(client.binary.at(-1)).toEqual(new Uint8Array([0x7f, 0x00]));
    expect(client.socket.readyState).toBe(1); // one failure is not a reason to drop the socket
  });

  it('refuses handshakes beyond the per-minute budget with the generic ABORT', async () => {
    t = await createTestDaemon({ limits: { handshakesPerMinute: 2 } });
    await t.connect({ userId: 'dev:one' });
    await t.connect({ userId: 'dev:two' });
    const third = await t.connect({ userId: 'dev:three', waitOnline: false, connection: { maxAbortedHandshakes: 1 } });
    expect(await waitForState(third.conn, (s) => s.kind === 'rejected' || s.kind === 'online', { timeoutMs: 10_000 })).toMatchObject({ kind: 'rejected', reason: 'aborted' });
    expect(t.daemon.status().handshakes.refusedByRateLimit).toBeGreaterThanOrEqual(1);
    expect(t.ctx.members.get('dev:three')).toBeNull();
  });

  // Security review F4: the budget used to be one global bucket, so any logged-in relay account that knows the
  // workspace id could keep it empty with junk HELLOs (no credential needed) and lock every member out.
  it('relay accounts flooding junk HELLOs cannot starve a member reconnecting (per-user budget + member reserve)', async () => {
    t = await createTestDaemon({ limits: { handshakesPerMinute: 6, handshakesPerUserPerMinute: 4 } });
    const td = t;
    const amy = await td.connect({ userId: 'dev:amy', role: 'editor' });
    amy.close();
    const url = wsClientUrl(MEMORY_RELAY_ORIGIN, td.workspaceId);
    const floodUsers = ['dev:mallory1', 'dev:mallory2', 'dev:mallory3'];
    const junkHello = (): Uint8Array<ArrayBuffer> => new Uint8Array([CHANNEL_FRAME.HELLO, HANDSHAKE_WIRE_VERSION, HANDSHAKE_MODE_BYTES.device, ...randomBytes(32)]);
    const tick = (): void => {
      for (const userId of floodUsers) {
        // At most 8 sockets per account (the real relay's cap); each is replaced once the daemon has it dropped.
        for (let i = td.relay.clientsOf(userId).length; i < 8; i++) td.relay.connectClient(url, { userId, displayName: 'Mallory' });
        for (const socket of td.relay.clientsOf(userId)) {
          socket.send(junkHello());
          socket.send(new Uint8Array([0x55])); // not FINISH: the handshake fails at once
        }
      }
    };
    const flood = setInterval(tick, 10);
    try {
      await waitFor(() => td.daemon.status().handshakes.refusedByRateLimit > 50, { timeoutMs: 5_000, what: 'the flood to exhaust the budgets' });
      const again = await amy.reconnect({ waitOnline: false });
      await waitForState(again.conn, (s) => s.kind === 'online', { timeoutMs: 8_000 });
      again.conn.close();
    } finally {
      clearInterval(flood);
    }
    // The strangers got no more than their own budgets out of the shared bucket.
    expect(td.daemon.status().handshakes.accepted).toBe(2);
  }, 30_000);

  // Security review F6: the handshake deadline used to start at the first frame, so a socket that never sent one
  // (it only pings the relay) was kept forever and held one of the relay's per-account / per-workspace slots.
  it('drops a relay connection that never starts a handshake, and leaves admitted clients alone', async () => {
    t = await createTestDaemon({ timing: { handshakeDeadlineMs: 300, idleConnGraceMs: 200 } });
    const td = t;
    const amy = await td.connect({ userId: 'dev:amy' });
    const idle = td.relay.connectClient(wsClientUrl(MEMORY_RELAY_ORIGIN, td.workspaceId), { userId: 'dev:mallory', displayName: 'Mallory' });
    await waitFor(() => td.relay.clientsOf('dev:mallory').includes(idle), { what: 'the idle socket to open' });
    await waitFor(() => !td.relay.clientsOf('dev:mallory').includes(idle), { timeoutMs: 3_000, what: 'the idle socket to be dropped' });
    expect(td.daemon.status().handshakes.kickedIdle).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(amy.conn.getState().kind).toBe('online');
    expect(td.daemon.status().handshakes.kickedIdle).toBe(1);
  });

  it('caps the connections of one member', async () => {
    t = await createTestDaemon({ limits: { maxConnectionsPerUser: 1 } });
    const amy = await t.connect({ userId: 'dev:amy' });
    const second = await amy.reconnect({ waitOnline: false });
    // 'busy' is an authenticated, retryable refusal: the client keeps trying while the first connection is open.
    await waitForState(second.conn, (s) => s.kind === 'connecting' && s.cause === 'busy', { timeoutMs: 10_000 });
    expect(t.ctx.hub.connections({ userId: 'dev:amy' })).toHaveLength(1);
    amy.conn.close();
    await waitForState(second.conn, (s) => s.kind === 'online', { timeoutMs: 10_000 });
    second.conn.close();
  });
});
