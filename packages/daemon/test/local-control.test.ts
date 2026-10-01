// The host's local control path (ARCHITECTURE §7.1 run/<short>.ctl, §8; contract review C2): attachLocal admits the
// host's own machine without Noise but through the same hub, router and audit as a relay client; the control-socket
// frame codec is strict. Also the hub's own refusals (contract review C3) and auth.disconnect (C4), which a local
// connection makes easy to drive with raw, forged bytes.
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, decodeEnvelope, encodeEnvelope, type AnyEnvelope, type AuditEntry } from '@smurg/protocol';
import { LOCAL_DEVICE_ID, type LocalAttachment } from '../src/core/interfaces.ts';
import { SocketPathError, assertSocketPath, runPathsFor, shortRunId } from '../src/core/sockets.ts';
import {
  CTL_CONTROL_MAX_BYTES,
  CTL_FRAME_KIND,
  CtlFrameDecoder,
  CtlProtocolError,
  encodeCtlControl,
  encodeCtlFrame,
  parseCtlRequest,
  parseCtlResponse,
} from '../src/local/protocol.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

interface LocalClient {
  readonly attachment: LocalAttachment;
  readonly received: AnyEnvelope[];
  closedByDaemon: boolean;
  seq: number;
  request(type: string, payload: unknown): Promise<AnyEnvelope>;
}

function attachHost(td: TestDaemon, resume?: { channelId: string; lastSeq: number }): LocalClient {
  const client: LocalClient = {
    attachment: null as unknown as LocalAttachment,
    received: [],
    closedByDaemon: false,
    seq: 0,
    request: async (type, payload) => {
      client.seq += 1;
      const id = `local-${client.seq}`;
      client.attachment.receive(encodeEnvelope({ type, id, seq: client.seq, payload } as never, { from: 'client', channel: 'interactive' }));
      await waitFor(() => client.received.some((e) => e.id === id), { what: `the answer to ${type}` });
      return client.received.find((e) => e.id === id) as AnyEnvelope;
    },
  };
  (client as { attachment: LocalAttachment }).attachment = td.ctx.lifecycle.attachLocal({
    userId: td.hostUserId,
    deviceName: 'smurg CLI (local)',
    ...(resume ? { resume } : {}),
    send: (bytes) => {
      const decoded = decodeEnvelope(bytes, { from: 'daemon', channel: 'interactive' });
      if (decoded.ok) client.received.push(decoded.envelope as AnyEnvelope);
    },
    close: () => {
      client.closedByDaemon = true;
    },
  });
  return client;
}

/** A valid client Envelope with `from` replaced by `to` (same UTF-8 length): what a hostile client sends. */
function forge(envelope: { type: string; id: string; seq: number; payload: unknown }, from: string, to: string): Uint8Array {
  const bytes = Buffer.from(encodeEnvelope(envelope as never, { from: 'client', channel: 'interactive' }));
  const at = bytes.indexOf(Buffer.from(from));
  if (at < 0 || Buffer.from(from).length !== Buffer.from(to).length) throw new Error('bad forge');
  Buffer.from(to).copy(bytes, at);
  return new Uint8Array(bytes);
}

async function auditOf(td: TestDaemon): Promise<AuditEntry[]> {
  await td.ctx.audit.flush();
  return td.ctx.audit.query({ limit: 500 });
}

describe('attachLocal', () => {
  it('admits the host without Noise: Welcome, requests through the router, auth.connect / auth.disconnect with mode local', async () => {
    t = await createTestDaemon();
    const local = attachHost(t);
    expect(local.attachment.welcome.member.role).toBe('host');
    expect(local.attachment.welcome.resumed).toBe(false);
    expect(local.attachment.connection).toMatchObject({ mode: 'local', relayConn: null, deviceId: LOCAL_DEVICE_ID, clientKind: 'cli' });
    local.attachment.open();
    const answer = await local.request('admin.invite.list', {});
    expect(answer.type).toBe('admin.invite.list.ok');
    local.attachment.end();
    await waitFor(() => t?.ctx.hub.connections().length === 0, { what: 'the local connection to end' });
    const entries = await auditOf(t);
    expect(entries.find((e) => e.action === 'auth.connect' && e.target === LOCAL_DEVICE_ID)?.detail).toMatchObject({ mode: 'local' });
    expect(entries.find((e) => e.action === 'auth.disconnect' && e.target === LOCAL_DEVICE_ID)?.detail).toMatchObject({ mode: 'local', reason: 'disconnected' });
  });

  it('refuses anyone but the host (the socket is the host OS account; no guest gets there)', async () => {
    t = await createTestDaemon();
    await t.connect({ userId: 'dev:eddie', role: 'editor' });
    expect(() => t?.ctx.lifecycle.attachLocal({ userId: 'dev:eddie', deviceName: 'x', send: () => {}, close: () => {} })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    const rejected = (await auditOf(t)).find((e) => e.action === 'auth.rejected');
    expect(rejected).toMatchObject({ target: 'dev:eddie', detail: { reason: 'local-not-host' } });
  });

  it('holds daemon messages until open(), then replays a resumed channel in order', async () => {
    t = await createTestDaemon();
    const first = attachHost(t);
    first.attachment.open();
    await first.request('admin.invite.list', {});
    const lastSeq = first.received.filter((e) => e.seq > 0).at(-1)?.seq ?? 0;
    first.attachment.end();
    await waitFor(() => t?.ctx.hub.connections().length === 0, { what: 'end' });
    t.ctx.hub.broadcast('presence.heartbeat', { at: Date.now() }); // queued for the disconnected logical channel
    const again = attachHost(t, { channelId: first.attachment.welcome.channelId, lastSeq });
    expect(again.attachment.welcome.resumed).toBe(true);
    expect(again.received).toHaveLength(0); // nothing before the Welcome went out
    again.attachment.open();
    expect(again.received.map((e) => e.type)).toContain('presence.heartbeat');
  });
});

describe('refusals decided by the hub are audited (SPEC R1 「拒絕並記錄」)', () => {
  it('a forged `..` path is refused (bad_request) and audited as path.denied', async () => {
    t = await createTestDaemon();
    const local = attachHost(t);
    local.attachment.open();
    local.attachment.receive(forge({ type: 'file.read', id: 'forged-1', seq: 1, payload: { file: { root: MAIN_ROOT, path: 'xx/secret.txt' } } }, 'xx/secret', '../secret'));
    await waitFor(() => local.received.some((e) => e.id === 'forged-1'), { what: 'the refusal' });
    expect(local.received.find((e) => e.id === 'forged-1')).toMatchObject({ type: 'error', payload: { code: 'bad_request' } });
    const denied = (await auditOf(t)).find((e) => e.action === 'path.denied');
    expect(denied).toMatchObject({ outcome: 'denied', actor: { kind: 'user', userId: t.hostUserId }, target: 'file.read', detail: { reason: 'lexical', problem: 'dot-segment' } });
  });

  it('a daemon-only type sent by a client is refused and audited as authz.denied; malformed bytes are only counted', async () => {
    t = await createTestDaemon();
    const local = attachHost(t);
    local.attachment.open();
    local.attachment.receive(encodeEnvelope({ type: 'exec.output', id: 'forged-2', seq: 1, payload: { sessionId: 's1', offset: 0, data: new Uint8Array([1]) } }, { from: 'daemon', channel: 'interactive' }));
    local.attachment.receive(new Uint8Array([0xc1, 0xc1, 0xc1]));
    await waitFor(() => local.received.some((e) => e.id === 'forged-2'), { what: 'the refusal' });
    const entries = (await auditOf(t)).filter((e) => e.outcome === 'denied');
    expect(entries.map((e) => [e.action, e.target, e.detail?.['reason']])).toEqual([['authz.denied', 'exec.output', 'direction']]);
  });
});

describe('auth.disconnect (R11 登入登出)', () => {
  it('is recorded when a relay client goes away', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy' });
    const deviceId = t.ctx.members.devicesOf('dev:amy')[0]?.deviceId;
    amy.close();
    await waitFor(async () => (await auditOf(t as TestDaemon)).some((e) => e.action === 'auth.disconnect' && e.target === deviceId), { what: 'auth.disconnect' });
    const entry = (await auditOf(t)).find((e) => e.action === 'auth.disconnect' && e.target === deviceId);
    expect(entry).toMatchObject({ actor: { kind: 'user', userId: 'dev:amy' }, outcome: 'ok', detail: { purpose: 'interactive', mode: 'invite' } });
    expect(typeof entry?.detail?.['durationMs']).toBe('number');
  });
});

describe('control-socket framing', () => {
  it('round-trips requests and responses, split across arbitrary chunks', () => {
    const frames = [
      encodeCtlControl({ v: 1, op: 'attach', deviceName: 'smurg CLI', resume: { channelId: 'ch_1', lastSeq: 4 } }),
      encodeCtlFrame(CTL_FRAME_KIND.envelope, new Uint8Array([1, 2, 3])),
      encodeCtlControl({ ok: false, error: { code: 'forbidden', message: 'no' } }),
    ];
    const stream = Buffer.concat(frames.map((f) => Buffer.from(f)));
    const decoder = new CtlFrameDecoder();
    const out = [];
    for (let i = 0; i < stream.length; i += 3) out.push(...decoder.push(new Uint8Array(stream.subarray(i, i + 3))));
    expect(out.map((f) => f.kind)).toEqual([CTL_FRAME_KIND.control, CTL_FRAME_KIND.envelope, CTL_FRAME_KIND.control]);
    expect(parseCtlRequest(out[0]?.body as Uint8Array)).toEqual({ v: 1, op: 'attach', deviceName: 'smurg CLI', resume: { channelId: 'ch_1', lastSeq: 4 } });
    expect([...(out[1]?.body as Uint8Array)]).toEqual([1, 2, 3]);
    expect(parseCtlResponse(out[2]?.body as Uint8Array)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(decoder.pending).toBe(0);
  });

  it('fails closed on unknown kinds, oversized frames, bad JSON and unknown fields', () => {
    const header = (length: number, kind: number): Uint8Array => {
      const b = Buffer.alloc(5);
      b.writeUInt32BE(length, 0);
      b[4] = kind;
      return new Uint8Array(b);
    };
    expect(() => new CtlFrameDecoder().push(header(2, 0x07))).toThrow(CtlProtocolError);
    expect(() => new CtlFrameDecoder().push(header(0, 0x01))).toThrow(CtlProtocolError);
    expect(() => new CtlFrameDecoder().push(header(CTL_CONTROL_MAX_BYTES + 2, CTL_FRAME_KIND.control))).toThrow(CtlProtocolError);
    expect(() => new CtlFrameDecoder().push(header(0x7fffffff, CTL_FRAME_KIND.envelope))).toThrow(CtlProtocolError);
    expect(() => parseCtlRequest(new TextEncoder().encode('{"v":1,"op":"status","extra":1}'))).toThrow(CtlProtocolError);
    expect(() => parseCtlRequest(new TextEncoder().encode('{"v":2,"op":"status"}'))).toThrow(CtlProtocolError);
    expect(() => parseCtlRequest(new Uint8Array([0xff, 0xfe]))).toThrow(CtlProtocolError);
    expect(() => encodeCtlControl({ v: 1, op: 'nope' } as never)).toThrow(CtlProtocolError);
  });

  it('a status response carries the daemon status as the schema describes it', async () => {
    t = await createTestDaemon();
    const frame = encodeCtlControl({ ok: true, op: 'status', status: t.ctx.lifecycle.status() });
    const [decoded] = new CtlFrameDecoder().push(frame);
    expect(parseCtlResponse(decoded?.body as Uint8Array)).toMatchObject({ ok: true, op: 'status', status: { workspaceId: t.workspaceId, started: true } });
  });

  it('the status names what `smurg status` shows the host (fingerprint, relay, switches, git, last sandbox check); a status without them (an older daemon) still parses', async () => {
    t = await createTestDaemon();
    const status = t.ctx.lifecycle.status();
    const { config } = t.daemon;
    expect(status).toMatchObject({
      fingerprint: t.daemon.fingerprint,
      relayUrl: config.relayUrl,
      switches: { guestSubscriptionLogin: config.sessions.guestSubscriptionLogin, attributeBashEdits: config.activity.attributeBashEdits, guestMainWorkspace: config.sessions.guestMainWorkspace },
      isGitRepo: t.ctx.workspace.info.isGitRepo,
      // The real sandbox module, never asked yet.
      sandbox: null,
    });
    const { fingerprint: _f, relayUrl: _r, switches: _s, isGitRepo: _g, sandbox: _b, ...older } = status;
    const parsed = parseCtlResponse(new TextEncoder().encode(JSON.stringify({ ok: true, op: 'status', status: older })));
    expect(parsed).toMatchObject({ ok: true, op: 'status', status: { workspaceId: t.workspaceId } });
    expect(parsed.ok && parsed.op === 'status' ? parsed.status.fingerprint : 'no status').toBeUndefined();
  });
});

describe('socket paths (contract review C1)', () => {
  it('refuses paths macOS would silently truncate, and derives short per-workspace names', () => {
    expect(assertSocketPath('/tmp/smurg-run-abc/abcdefghijkl.hook')).toBe('/tmp/smurg-run-abc/abcdefghijkl.hook');
    expect(() => assertSocketPath(`/${'x'.repeat(103)}`)).toThrow(SocketPathError);
    expect(() => assertSocketPath('relative/x.hook')).toThrow(SocketPathError);
    expect(shortRunId('ws_test_0123456789')).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(shortRunId('ws_test_0123456789')).not.toBe(shortRunId('WS_TEST_0123456789'));
    const paths = runPathsFor('/Users/amy/.smurg/run', 'ws_test_0123456789');
    expect(paths.ctl.endsWith('.ctl') && paths.hook.endsWith('.hook')).toBe(true);
    expect(() => runPathsFor(`/${'d'.repeat(90)}`, 'ws_test_0123456789')).toThrow(SocketPathError);
  });

  it('the test harness gives the daemon a run dir whose socket paths fit', async () => {
    t = await createTestDaemon();
    expect(Buffer.byteLength(t.daemon.config.runPaths.hook)).toBeLessThanOrEqual(103);
    expect(t.daemon.config.runDir).toBe(t.runDir);
  });
});
