// The daemon's control socket (ARCHITECTURE §7.1 run/<short>.ctl, §8): file modes, the status / stop / attach ops,
// envelopes both ways on an attach, stale sockets, a second daemon refused, stop answering before stopping, bounded
// frames and connections, and one client never stalling another.
import { createServer } from 'node:net';
import { lstat, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureModule } from '../../src/core/context.ts';
import { LOCAL_DEVICE_ID, type DaemonLifecycle, type DaemonStatus, type LocalAttachInput, type LocalAttachment } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { ControlServer, ControlSocketError, probeControlSocket } from '../../src/local/control-server.ts';
import { createLocalControlModule, localControlModule } from '../../src/local/module.ts';
import { CTL_CONTROL_MAX_BYTES, CTL_FRAME_KIND, encodeCtlFrame } from '../../src/local/protocol.ts';
import { createTempRunDir, removeTempRunDir, waitFor } from '../../src/testing/index.ts';
import { LOCAL_HOST_USER, connectRaw, startLocalDaemon, type LocalDaemon, type RawCtlClient } from './helpers.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)().catch(() => {});
});

async function daemonWith(options: Parameters<typeof startLocalDaemon>[0]): Promise<LocalDaemon> {
  const d = await startLocalDaemon(options);
  cleanups.push(() => d.cleanup());
  return d;
}

async function client(path: string): Promise<RawCtlClient> {
  const c = await connectRaw(path);
  cleanups.push(async () => c.close());
  return c;
}

function header(length: number, kind: number): Uint8Array {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(length, 0);
  b[4] = kind;
  return new Uint8Array(b);
}

/** A socket file nobody listens on (what a SIGKILLed daemon leaves behind), made without killing anything. */
async function staleSocketAt(path: string): Promise<void> {
  const temp = `${path}.tmp`;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(temp, resolve));
  await rename(temp, path); // the socket inode moves; libuv's unlink on close targets the old name
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect((await lstat(path)).isSocket()).toBe(true);
}

const fakeStatus = (workspaceId: string): DaemonStatus => ({
  workspaceId,
  started: true,
  stopped: false,
  relay: { interactive: 'none', transfer: 'none' },
  connections: 0,
  onlineMembers: 0,
  power: { active: false, mechanism: 'none', pid: null, reason: 'disabled' },
  handshakes: { handshakes: 0, accepted: 0, failed: 0, refusedByRateLimit: 0, kickedForFailures: 0, kickedIdle: 0 },
  fingerprint: '0000 1111',
  relayUrl: null,
  switches: { guestSubscriptionLogin: true, attributeBashEdits: true, guestMainWorkspace: true },
  isGitRepo: false,
  sandbox: null,
});

function fakeLifecycle(workspaceId = 'ws_fake_lifecycle01'): DaemonLifecycle & { stops: string[] } {
  const stops: string[] = [];
  return {
    stops,
    stop: async (reason?: string) => {
      stops.push(reason ?? '');
    },
    status: () => fakeStatus(workspaceId),
    attachLocal: (_input: LocalAttachInput): LocalAttachment => {
      throw new Error('not in this fake');
    },
  };
}

async function runDir(): Promise<string> {
  const dir = await createTempRunDir();
  cleanups.push(() => removeTempRunDir(dir));
  return dir;
}

async function server(path: string, extra: Partial<ConstructorParameters<typeof ControlServer>[0]> = {}): Promise<ControlServer> {
  const s = new ControlServer({ path, hostUserId: LOCAL_HOST_USER, lifecycle: fakeLifecycle(), log: silentLogger, ...extra });
  await s.start();
  cleanups.push(() => s.stop());
  return s;
}

describe('control socket files', () => {
  it('listens on config.runPaths.ctl, mode 0600 inside the 0700 run dir, with a pid file; both are removed on stop', async () => {
    const d = await startLocalDaemon({ modules: [localControlModule] });
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) await d.cleanup();
    });
    const socketStat = await lstat(d.ctlPath);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o600);
    expect((await stat(d.runDir)).mode & 0o777).toBe(0o700);
    expect((await readFile(d.daemon.config.runPaths.pid, 'utf8')).trim()).toBe(String(process.pid));
    expect((await lstat(d.daemon.config.runPaths.pid)).mode & 0o777).toBe(0o600);
    await d.daemon.stop();
    await localControlModule.whenClosed();
    await expect(lstat(d.ctlPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(d.daemon.config.runPaths.pid)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await probeControlSocket(d.ctlPath)).toBe('absent');
    stopped = true;
    await d.cleanup();
  });

  it('replaces a stale socket file (nobody listening) and serves on it', async () => {
    const dir = await runDir();
    const path = join(dir, 'abcdefghijkl.ctl');
    await staleSocketAt(path);
    expect(await probeControlSocket(path)).toBe('stale');
    await server(path);
    const c = await client(path);
    c.request({ v: 1, op: 'status' });
    expect(await c.response()).toMatchObject({ ok: true, op: 'status', status: { workspaceId: 'ws_fake_lifecycle01' } });
  });

  it('refuses to start while another live daemon owns the socket (probe by connecting); the first keeps working', async () => {
    const dir = await runDir();
    const path = join(dir, 'abcdefghijkl.ctl');
    await server(path);
    const second = new ControlServer({ path, hostUserId: LOCAL_HOST_USER, lifecycle: fakeLifecycle(), log: silentLogger });
    await expect(second.start()).rejects.toMatchObject({ name: 'ControlSocketError', code: 'daemon-running' });
    const c = await client(path);
    c.request({ v: 1, op: 'status' });
    expect(await c.response()).toMatchObject({ ok: true, op: 'status' });
  });

  it('a second daemon of the same workspace is refused at start; the running one is untouched', async () => {
    const first = await daemonWith({ modules: [localControlModule] });
    await expect(startLocalDaemon({ modules: [localControlModule], workspaceId: first.workspaceId, runDir: first.runDir })).rejects.toBeInstanceOf(ControlSocketError);
    expect((await lstat(first.ctlPath)).isSocket()).toBe(true);
    const c = await client(first.ctlPath);
    c.request({ v: 1, op: 'status' });
    expect(await c.response()).toMatchObject({ ok: true, op: 'status', status: { workspaceId: first.workspaceId, stopped: false } });
  });

  it('leaves anything that is not a socket alone and refuses (fail closed)', async () => {
    const dir = await runDir();
    const path = join(dir, 'abcdefghijkl.ctl');
    await writeFile(path, 'not a socket', { mode: 0o600 });
    const s = new ControlServer({ path, hostUserId: LOCAL_HOST_USER, lifecycle: fakeLifecycle(), log: silentLogger });
    await expect(s.start()).rejects.toMatchObject({ code: 'not-a-socket' });
    expect(await readFile(path, 'utf8')).toBe('not a socket');
  });
});

describe('ops', () => {
  it('status: answers with the daemon status, then the daemon closes the socket', async () => {
    const d = await daemonWith({ modules: [localControlModule] });
    const c = await client(d.ctlPath);
    c.request({ v: 1, op: 'status' });
    const response = await c.response();
    expect(response).toMatchObject({ ok: true, op: 'status', status: { workspaceId: d.workspaceId, started: true, stopped: false } });
    await c.waitClosed();
  });

  it('attach carries envelopes both ways on a logical channel of the host (requests, answers, events, acks), audited as local', async () => {
    const d = await daemonWith({ modules: [localControlModule] });
    const c = await client(d.ctlPath);
    c.request({ v: 1, op: 'attach', deviceName: 'smurg CLI (test)' });
    const response = await c.response();
    if (!response.ok || response.op !== 'attach') throw new Error('attach refused');
    expect(response.welcome.member).toMatchObject({ userId: LOCAL_HOST_USER, role: 'host' });
    expect(response.welcome.resumed).toBe(false);
    // client → daemon → client: a request routed like any relay client's
    const answer = await c.call('admin.invite.list', {});
    expect(answer.type).toBe('admin.invite.list.ok');
    // daemon → client: fan-out reaches the local channel
    d.daemon.ctx.hub.broadcast('presence.heartbeat', { at: 1_700_000_000_000 });
    await waitFor(() => c.envelopes.some((e) => e.type === 'presence.heartbeat' && (e.payload as { at: number }).at === 1_700_000_000_000), { what: 'the broadcast' });
    // the daemon acknowledges what the client sent (channel.ack is unsequenced)
    await waitFor(() => c.envelopes.some((e) => e.type === 'channel.ack'), { what: 'an ack', timeoutMs: 3_000 });
    const conn = d.daemon.ctx.hub.connections()[0];
    expect(conn).toMatchObject({ mode: 'local', deviceId: LOCAL_DEVICE_ID, relayConn: null, clientKind: 'cli', deviceName: 'smurg CLI (test)' });
    c.close();
    await waitFor(() => d.daemon.ctx.hub.connections().length === 0, { what: 'the local connection to end' });
    await d.daemon.ctx.audit.flush();
    const entries = await d.daemon.ctx.audit.query({ limit: 50 });
    expect(entries.find((e) => e.action === 'auth.connect')?.detail).toMatchObject({ mode: 'local' });
    expect(entries.find((e) => e.action === 'auth.disconnect')?.detail).toMatchObject({ mode: 'local' });
  });

  it('a re-attach resumes the logical channel and replays what was queued while away', async () => {
    const d = await daemonWith({ modules: [localControlModule] });
    const first = await client(d.ctlPath);
    first.request({ v: 1, op: 'attach', deviceName: 'smurg CLI' });
    const welcome = await first.response();
    if (!welcome.ok || welcome.op !== 'attach') throw new Error('attach refused');
    await first.call('admin.invite.list', {});
    const lastSeq = Math.max(...first.envelopes.map((e) => e.seq));
    first.close();
    await waitFor(() => d.daemon.ctx.hub.connections().length === 0, { what: 'disconnect' });
    d.daemon.ctx.hub.broadcast('presence.heartbeat', { at: 1_700_000_000_123 });
    const again = await client(d.ctlPath);
    again.request({ v: 1, op: 'attach', deviceName: 'smurg CLI', resume: { channelId: welcome.welcome.channelId, lastSeq } });
    const resumed = await again.response();
    expect(resumed).toMatchObject({ ok: true, op: 'attach', welcome: { resumed: true, channelId: welcome.welcome.channelId } });
    await waitFor(() => again.envelopes.some((e) => e.type === 'presence.heartbeat' && (e.payload as { at: number }).at === 1_700_000_000_123), { what: 'the replay' });
  });

  it('stop answers before stopping: the requester gets its reply, attached clients get channel.closed{stopped}, the files go', async () => {
    const d = await startLocalDaemon({ modules: [localControlModule] });
    cleanups.push(() => d.cleanup());
    const attached = await client(d.ctlPath);
    attached.request({ v: 1, op: 'attach', deviceName: 'watcher' });
    await attached.response();
    const stopper = await client(d.ctlPath);
    stopper.request({ v: 1, op: 'stop', reason: 'test' });
    expect(await stopper.response()).toEqual({ ok: true, op: 'stop' });
    await stopper.waitClosed();
    expect(stopper.errored).toBe(false);
    await waitFor(() => attached.envelopes.some((e) => e.type === 'channel.closed'), { what: 'channel.closed' });
    expect(attached.envelopes.find((e) => e.type === 'channel.closed')?.payload).toMatchObject({ reason: 'stopped' });
    await attached.waitClosed();
    await waitFor(() => d.daemon.status().stopped, { what: 'the daemon to stop' });
    await waitFor(async () => (await probeControlSocket(d.ctlPath)) === 'absent', { what: 'the socket file to go' });
  });

  it('the socket stays while the rest of the daemon stops (status says stopped, attach is refused) and goes only after every other module stopped', async () => {
    // A module that takes its time to stop, like sessions ending their processes and removing guest dirs.
    let releaseSlowStop: () => void = () => {};
    const slowStopGate = new Promise<void>((resolve) => {
      releaseSlowStop = resolve;
    });
    let slowStopped = false;
    const slow: FeatureModule = {
      name: 'slow',
      register: () => toDisposable(() => {}),
      stop: async () => {
        await slowStopGate;
        slowStopped = true;
      },
    };
    const module = createLocalControlModule();
    const d = await startLocalDaemon({ modules: [slow, module] });
    cleanups.push(() => d.cleanup());
    const stopper = await client(d.ctlPath);
    stopper.request({ v: 1, op: 'stop' });
    expect(await stopper.response()).toEqual({ ok: true, op: 'stop' });
    await waitFor(() => d.daemon.status().stopped, { what: 'the stop to begin' });
    // The slow module is still stopping: the socket is still there and answers from the daemon's state.
    expect(await probeControlSocket(d.ctlPath)).toBe('live');
    const status = await client(d.ctlPath);
    status.request({ v: 1, op: 'status' });
    expect(await status.response()).toMatchObject({ ok: true, op: 'status', status: { stopped: true } });
    const attach = await client(d.ctlPath);
    attach.request({ v: 1, op: 'attach', deviceName: 'late' });
    expect(await attach.response()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    const again = await client(d.ctlPath);
    again.request({ v: 1, op: 'stop' });
    expect(await again.response()).toEqual({ ok: true, op: 'stop' });
    expect(slowStopped).toBe(false);
    releaseSlowStop();
    await waitFor(async () => (await probeControlSocket(d.ctlPath)) === 'absent', { what: 'the socket file to go' });
    expect(slowStopped).toBe(true);
    await module.whenClosed();
    await expect(lstat(d.daemon.config.runPaths.pid)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a stop request is carried out once, after its reply was flushed (custom stop routine of a host process)', async () => {
    const calls: { reason: string }[] = [];
    const module = createLocalControlModule({
      requestStop: (_ctx, reason) => {
        calls.push({ reason });
      },
    });
    const d = await daemonWith({ modules: [module] });
    const stopper = await client(d.ctlPath);
    stopper.request({ v: 1, op: 'stop' });
    expect(await stopper.response()).toEqual({ ok: true, op: 'stop' });
    await waitFor(() => calls.length === 1, { what: 'the stop routine' });
    expect(calls[0]?.reason).toBe('smurg stop');
    const again = await client(d.ctlPath);
    again.request({ v: 1, op: 'stop' });
    expect(await again.response()).toEqual({ ok: true, op: 'stop' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
    expect(d.daemon.status().stopped).toBe(false);
  });

  it('an attach while the daemon is not running is refused with an error response', async () => {
    const dir = await runDir();
    const path = join(dir, 'abcdefghijkl.ctl');
    await server(path);
    const c = await client(path);
    c.request({ v: 1, op: 'attach', deviceName: 'x' });
    expect(await c.response()).toMatchObject({ ok: false, error: { code: 'internal' } });
    await c.waitClosed();
  });
});

describe('bounded and fair', () => {
  it('fails closed on malformed input: invalid JSON gets bad_request, unknown kinds / oversized frames / envelopes before a request end the connection', async () => {
    const d = await daemonWith({ modules: [localControlModule] });
    const badJson = await client(d.ctlPath);
    badJson.send(encodeCtlFrame(CTL_FRAME_KIND.control, new TextEncoder().encode('{"v":1,"op":"status","extra":true}')));
    expect(await badJson.response()).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    await badJson.waitClosed();

    const unknownKind = await client(d.ctlPath);
    unknownKind.send(header(3, 0x07));
    await unknownKind.waitClosed();

    const oversized = await client(d.ctlPath);
    oversized.send(header(CTL_CONTROL_MAX_BYTES + 2, CTL_FRAME_KIND.control));
    await oversized.waitClosed();

    const envelopeFirst = await client(d.ctlPath);
    envelopeFirst.send(encodeCtlFrame(CTL_FRAME_KIND.envelope, new Uint8Array([1, 2, 3])));
    await envelopeFirst.waitClosed();

    // An 8 MiB envelope announced before any request is dropped once more than one control frame is buffered.
    const parked = await client(d.ctlPath);
    parked.send(header(8 * 1024 * 1024, CTL_FRAME_KIND.envelope));
    parked.send(new Uint8Array(CTL_CONTROL_MAX_BYTES + 16));
    await parked.waitClosed();

    const controlAfterAttach = await client(d.ctlPath);
    controlAfterAttach.request({ v: 1, op: 'attach', deviceName: 'x' });
    await controlAfterAttach.response();
    controlAfterAttach.request({ v: 1, op: 'status' });
    await controlAfterAttach.waitClosed();
    expect(frameKinds(controlAfterAttach)).not.toContain('status');
  });

  it('one client cannot stall another: a silent client and a half-sent frame do not delay a status request, and are dropped after the deadline', async () => {
    const d = await daemonWith({ modules: [createLocalControlModule({ limits: { requestTimeoutMs: 300 } })] });
    const silent = await client(d.ctlPath);
    const half = await client(d.ctlPath);
    half.send(encodeCtlFrame(CTL_FRAME_KIND.control, new TextEncoder().encode('{"v":1,"op":"status"}')).subarray(0, 8));
    const started = Date.now();
    const fast = await client(d.ctlPath);
    fast.request({ v: 1, op: 'status' });
    expect(await fast.response()).toMatchObject({ ok: true, op: 'status' });
    expect(Date.now() - started).toBeLessThan(2_000);
    await silent.waitClosed();
    await half.waitClosed();
  });

  it('an attached client that stops reading is dropped once its backlog passes the bound; the others keep working', async () => {
    const d = await daemonWith({ modules: [createLocalControlModule({ limits: { maxQueuedBytes: 256 * 1024 } })] });
    const slow = await client(d.ctlPath);
    slow.request({ v: 1, op: 'attach', deviceName: 'slow' });
    const welcome = await slow.response();
    if (!welcome.ok || welcome.op !== 'attach') throw new Error('attach refused');
    slow.socket.pause();
    const chunk = new Uint8Array(512 * 1024).fill(0x61);
    for (let i = 0; i < 64 && d.daemon.ctx.hub.connections().length > 0; i++) {
      d.daemon.ctx.hub.send(welcome.welcome.channelId, 'exec.output', { sessionId: 'ses_flood', offset: i * chunk.length, data: chunk });
      await new Promise((resolve) => setImmediate(resolve));
    }
    await waitFor(() => d.daemon.ctx.hub.connections().length === 0, { what: 'the slow reader to be dropped', timeoutMs: 10_000 });
    const other = await client(d.ctlPath);
    other.request({ v: 1, op: 'status' });
    expect(await other.response()).toMatchObject({ ok: true, op: 'status' });
  });

  it('serves at most maxConnections sockets at once; more are closed immediately', async () => {
    const d = await daemonWith({ modules: [createLocalControlModule({ limits: { maxConnections: 2 } })] });
    const a = await client(d.ctlPath);
    const b = await client(d.ctlPath);
    const c = await client(d.ctlPath);
    await c.waitClosed();
    a.close();
    await waitFor(() => a.closed, { what: 'a to close' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const e = await client(d.ctlPath);
    e.request({ v: 1, op: 'status' });
    expect(await e.response()).toMatchObject({ ok: true });
    expect(b.closed).toBe(false);
  });
});

function frameKinds(c: RawCtlClient): string[] {
  return c.frames
    .filter((f) => f.kind === CTL_FRAME_KIND.control)
    .map((f) => {
      const parsed = JSON.parse(new TextDecoder().decode(f.body)) as { op?: string };
      return parsed.op ?? 'error';
    });
}
