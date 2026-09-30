// Review finding REL-06 with the REAL modules: every member's interactive traffic shares the daemon's ONE socket to the
// relay. A terminal that prints a lot must not be pushed into that socket faster than it drains, or everyone's
// replies, doc sync and heartbeats wait behind it (the reviewer measured 47 s for an unrelated request). The in-memory
// relay's host socket stands in for a slow uplink by reporting a large bufferedAmount.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { sleep } from './support.ts';

let t: TestDaemon | null = null;
const savedShell = process.env['SHELL'];

beforeAll(() => {
  process.env['SHELL'] = '/bin/sh';
});

afterAll(() => {
  if (savedShell === undefined) delete process.env['SHELL'];
  else process.env['SHELL'] = savedShell;
});

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

/** The in-memory relay's end of the daemon's interactive host socket (a test-only peek at a private field). */
function hostSocket(d: TestDaemon): { bufferedAmount: number } {
  const hosts = (d.relay as unknown as { hosts: Map<string, { bufferedAmount: number }> }).hosts;
  const socket = hosts.get('ws');
  if (!socket) throw new Error('the daemon is not connected to the in-memory relay');
  return socket;
}

describe('terminal output and the shared host uplink (real modules, real PTY)', { timeout: 120_000 }, () => {
  it('a congested uplink pauses a chatty terminal; it runs on at full speed once the uplink drains', async () => {
    t = await createTestDaemon();
    const d = t;
    const host = await d.connectHost();
    const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    let received = 0;
    let sawReady = false;
    const decoder = new TextDecoder();
    host.conn.on('exec.output', (payload) => {
      if (payload.sessionId !== session.id) return;
      received += payload.data.byteLength;
      if (!sawReady && decoder.decode(payload.data).includes('READY-2')) sawReady = true;
    });
    await host.conn.request('session.attach', { sessionId: session.id });
    host.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('echo READY-$((1+1))\r') });
    await waitFor(() => sawReady, { timeoutMs: 20_000, what: 'the shell to run' });

    // The uplink is congested: 8 MiB are still queued on the daemon's socket.
    const socket = hostSocket(d);
    socket.bufferedAmount = 8 * 1024 * 1024;
    const before = received;
    host.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('seq 1 30000000\r') });
    await sleep(2_000);
    // At most what was in flight when the check ran (one coalesced chunk or a little more), not the PTY's 10-25 MB/s.
    expect(received - before).toBeLessThan(2 * 1024 * 1024);

    // Drained: the output flows again.
    socket.bufferedAmount = 0;
    const resumedFrom = received;
    await waitFor(() => received > resumedFrom + 8 * 1024 * 1024, { timeoutMs: 20_000, what: 'output after the uplink drained' });
    await host.conn.request('session.end', { sessionId: session.id });
  });
});
