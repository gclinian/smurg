// The host's local control path (ARCHITECTURE §7.1 run/<short>.ctl, §8; contract review C2): attachLocal admits the
// host's own machine without Noise but through the same hub and router as a relay client, restricted to what `smurg
// attach` sends and audited via control-socket (review F1); the control-socket frame codec is strict. Also the hub's own refusals (contract review C3) and auth.disconnect (C4), which a local
// connection makes easy to drive with raw, forged bytes.
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, MESSAGE_REGISTRY, MESSAGE_TYPES, SmurgError, decodeEnvelope, encodeEnvelope, isSmurgError, mayReceive, type AnyEnvelope, type AuditEntry, type RequestType } from '@smurg/protocol';
import { LOCAL_DEVICE_ID, type InboundNotifyType, type LocalAttachment } from '../src/core/interfaces.ts';
import { SocketPathError, assertSocketPath, runPathsFor, shortRunId } from '../src/core/sockets.ts';
import { LOCAL_CHANNEL_RECEIVES, LOCAL_CHANNEL_TYPES, localChannelAllows, localChannelReceives } from '../src/local/local-channel.ts';
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
import { createProbe } from './fixtures/probe-module.ts';
import { NOTIFY_SAMPLES, REQUEST_SAMPLES } from './fixtures/request-samples.ts';

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
  it('admits the host without Noise: Welcome, requests through the router, auth.connect / auth.disconnect with mode local and via control-socket', async () => {
    t = await createTestDaemon();
    const local = attachHost(t);
    expect(local.attachment.welcome.member.role).toBe('host');
    expect(local.attachment.welcome.resumed).toBe(false);
    expect(local.attachment.connection).toMatchObject({ mode: 'local', relayConn: null, deviceId: LOCAL_DEVICE_ID, clientKind: 'cli' });
    local.attachment.open();
    const answer = await local.request('session.list', {});
    expect(answer).toMatchObject({ type: 'session.list.ok', payload: { sessions: [] } });
    local.attachment.end();
    await waitFor(() => t?.ctx.hub.connections().length === 0, { what: 'the local connection to end' });
    const entries = await auditOf(t);
    expect(entries.find((e) => e.action === 'auth.connect' && e.target === LOCAL_DEVICE_ID)?.detail).toMatchObject({ mode: 'local', via: 'control-socket' });
    expect(entries.find((e) => e.action === 'auth.disconnect' && e.target === LOCAL_DEVICE_ID)?.detail).toMatchObject({ mode: 'local', reason: 'disconnected', via: 'control-socket' });
  });

  it('refuses anyone but the host (the socket is the host OS account; no guest gets there)', async () => {
    t = await createTestDaemon();
    await t.connect({ userId: 'dev:eddie', role: 'editor' });
    expect(() => t?.ctx.lifecycle.attachLocal({ userId: 'dev:eddie', deviceName: 'x', send: () => {}, close: () => {} })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    const rejected = (await auditOf(t)).find((e) => e.action === 'auth.rejected');
    expect(rejected).toMatchObject({ target: 'dev:eddie', detail: { reason: 'local-not-host', via: 'control-socket' } });
  });

  it('holds daemon messages until open(), then replays a resumed channel in order', async () => {
    t = await createTestDaemon();
    const first = attachHost(t);
    first.attachment.open();
    await first.request('session.list', {});
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

describe('refusals decided by the hub are audited (SPEC R1: refuse and record)', () => {
  it('a forged `..` path is refused (bad_request) and audited as path.denied', async () => {
    t = await createTestDaemon();
    const local = attachHost(t);
    local.attachment.open();
    local.attachment.receive(forge({ type: 'file.read', id: 'forged-1', seq: 1, payload: { file: { root: MAIN_ROOT, path: 'xx/secret.txt' } } }, 'xx/secret', '../secret'));
    await waitFor(() => local.received.some((e) => e.id === 'forged-1'), { what: 'the refusal' });
    expect(local.received.find((e) => e.id === 'forged-1')).toMatchObject({ type: 'error', payload: { code: 'bad_request' } });
    const denied = (await auditOf(t)).find((e) => e.action === 'path.denied');
    expect(denied).toMatchObject({ outcome: 'denied', actor: { kind: 'user', userId: t.hostUserId }, target: 'file.read', detail: { reason: 'lexical', problem: 'dot-segment', via: 'control-socket' } });
  });

  it('a daemon-only type sent by a client is refused and audited as authz.denied; malformed bytes are only counted', async () => {
    t = await createTestDaemon();
    const local = attachHost(t);
    local.attachment.open();
    local.attachment.receive(encodeEnvelope({ type: 'exec.output', id: 'forged-2', seq: 1, payload: { sessionId: 's1', offset: 0, data: new Uint8Array([1]) } }, { from: 'daemon', channel: 'interactive' }));
    local.attachment.receive(new Uint8Array([0xc1, 0xc1, 0xc1]));
    await waitFor(() => local.received.some((e) => e.id === 'forged-2'), { what: 'the refusal' });
    const entries = (await auditOf(t)).filter((e) => e.outcome === 'denied');
    expect(entries.map((e) => [e.action, e.target, e.detail?.['reason'], e.detail?.['via']])).toEqual([['authz.denied', 'exec.output', 'direction', 'control-socket']]);
  });
});

// Review F1 (2026-10-02): the control socket admits the host's OS ACCOUNT, and every session runs as that account
// (ARCHITECTURE §11 D-15), so a Agent access member can reach it from any session she types into. A local channel may
// send only what `smurg attach` sends (src/local/local-channel.ts LOCAL_CHANNEL_TYPES); the host's own relay channels
// are not affected. Every audit entry a local channel causes says `via: 'control-socket'`.
describe('the local channel sends only what smurg attach sends (review F1)', () => {
  const ALL_CLIENT_TYPES = MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].dir !== 'd2c');
  const REQUESTS = Object.keys(REQUEST_SAMPLES) as RequestType[];
  const NOTIFIES = Object.keys(NOTIFY_SAMPLES) as InboundNotifyType[];
  const sampleOf = (type: string): unknown => (REQUEST_SAMPLES as Record<string, unknown>)[type] ?? (NOTIFY_SAMPLES as Record<string, unknown>)[type];
  const fresh = (entries: readonly AuditEntry[], since: number): AuditEntry[] => entries.slice(since);

  it('the allow-list is exactly what the CLI attach sends, every entry a client message of the registry', () => {
    expect([...LOCAL_CHANNEL_TYPES].sort()).toEqual(['channel.ack', 'exec.input', 'exec.resize', 'session.attach', 'session.detach', 'session.list']);
    for (const type of LOCAL_CHANNEL_TYPES) expect(ALL_CLIENT_TYPES).toContain(type);
    // Every client message of the registry has a sample below (requests, one-way messages, the hub's channel.ack).
    expect(new Set([...REQUESTS, ...NOTIFIES, 'channel.ack'])).toEqual(new Set(ALL_CLIENT_TYPES));
  });

  it('every client message type not on the list is refused over a local channel (forbidden, audited via control-socket, no handler) and accepted over the host\'s relay channel', async () => {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [probe.module], limits: { maxDenialsPerConnPerMinute: 10_000, auditDeniedPerActorPerMinute: 10_000 } });
    const audit: AuditEntry[] = [];
    t.ctx.audit.subscribe((entry) => audit.push(entry));
    const local = attachHost(t);
    local.attachment.open();
    const host = await t.connectHost();
    const hostTransfer = await host.transfer();
    const problems: string[] = [];
    try {
      // ---- over the local channel (one seq counter with local.request; channel.ack is unsequenced)
      const sendLocal = (type: string, payload: unknown): string => {
        const id = `lc-${type}`;
        const isAck = type === 'channel.ack';
        if (!isAck) local.seq += 1;
        // A transfer-socket type is encoded as the transfer socket would carry it; the local channel is interactive.
        const channel = MESSAGE_REGISTRY[type as keyof typeof MESSAGE_REGISTRY].channel === 'transfer' ? 'transfer' : 'interactive';
        local.attachment.receive(encodeEnvelope({ type, id, seq: isAck ? 0 : local.seq, payload } as never, { from: 'client', channel }));
        return id;
      };
      for (const type of ALL_CLIENT_TYPES) {
        const since = audit.length;
        const hitsBefore = probe.count(type, t.hostUserId);
        const id = sendLocal(type, type === 'channel.ack' ? { upTo: 0 } : sampleOf(type));
        // Messages are handled in order: once a later request is answered, any refusal of this one was sent.
        await local.request('session.list', {});
        const answer = local.received.find((e) => e.id === id);
        const reached = probe.count(type, t.hostUserId) > hitsBefore;
        const entries = fresh(audit, since).filter((e) => e.outcome === 'denied' && e.target === type);
        if (localChannelAllows(type)) {
          const refusedByList = answer?.type === 'error' && (answer.payload as { detail?: { reason?: string } }).detail?.reason === 'control-socket';
          if (refusedByList || entries.length > 0) problems.push(`local ${type}: on the list but refused`);
          if (type !== 'channel.ack' && !reached) problems.push(`local ${type}: on the list but no handler ran`);
          continue;
        }
        if (reached) problems.push(`local ${type}: a handler ran`);
        if (answer?.type !== 'error') problems.push(`local ${type}: not refused (${answer?.type ?? 'no answer'})`);
        if (entries.length !== 1 || entries[0]?.detail?.['via'] !== 'control-socket') problems.push(`local ${type}: audited ${JSON.stringify(entries.map((e) => e.detail))}`);
        if (MESSAGE_REGISTRY[type].channel === 'transfer') continue; // refused by the hub's decoder already (wrong socket)
        if ((answer?.payload as { code?: string } | undefined)?.code !== 'forbidden' || entries[0]?.detail?.['reason'] !== 'control-socket') {
          problems.push(`local ${type}: refused as ${JSON.stringify(answer?.payload)}`);
        }
      }

      // ---- the same types from the host's relay channels: never refused for the socket, no audit entry says via
      const relaySince = audit.length;
      for (const type of NOTIFIES) {
        const hitsBefore = probe.count(type, t.hostUserId);
        if (MESSAGE_REGISTRY[type].channel === 'transfer') hostTransfer.notify(type as never, NOTIFY_SAMPLES[type] as never);
        else host.conn.notify(type as never, NOTIFY_SAMPLES[type] as never);
        await waitFor(() => probe.count(type, t?.hostUserId) === hitsBefore + 1, { what: `relay ${type} to reach its handler` });
      }
      // channel.leave last (for the host it changes nothing, but it is the one that could end the channel).
      for (const type of [...REQUESTS.filter((r) => r !== 'channel.leave'), 'channel.leave' as const]) {
        const hitsBefore = probe.count(type, t.hostUserId);
        const sample = REQUEST_SAMPLES[type];
        const outcome: unknown = await (MESSAGE_REGISTRY[type].channel === 'transfer' ? hostTransfer.request(type as never, sample as never) : host.conn.request(type as never, sample as never)).then(
          () => 'ok',
          (err: unknown) => err,
        );
        if (isSmurgError(outcome) && (outcome.code === 'forbidden' || outcome.detail?.['reason'] === 'control-socket')) problems.push(`relay ${type}: refused (${outcome.code})`);
        if (isSmurgError(outcome) && outcome.detail?.['reason'] === 'probe-reached' && probe.count(type, t.hostUserId) === hitsBefore) problems.push(`relay ${type}: probe not reached`);
      }
      const viaRelay = fresh(audit, relaySince).filter((e) => e.detail?.['via'] === 'control-socket');
      if (viaRelay.length > 0) problems.push(`relay requests audited via control-socket: ${viaRelay.map((e) => e.action).join(',')}`);
    } finally {
      hostTransfer.close();
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('the host decisions a Agent access member could reach through the socket are refused there and change nothing; the audit says via control-socket', async () => {
    t = await createTestDaemon({ modules: [] });
    const carol = await t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    const invitesBefore = t.ctx.invites.list().length;
    const local = attachHost(t);
    local.attachment.open();
    const audit: AuditEntry[] = [];
    t.ctx.audit.subscribe((entry) => audit.push(entry));
    const attempts: readonly (readonly [string, unknown])[] = [
      ['admin.member.setRole', { userId: 'dev:carol', role: 'editor' }],
      ['admin.member.kick', { userId: 'dev:carol' }],
      ['admin.invite.create', { role: 'agent' }],
      ['admin.invite.list', {}],
      ['admin.member.list', {}],
      ['admin.settings.set', { humanLockIdleMs: 61_000 }],
      ['admin.audit.query', { limit: 10 }],
      ['admin.session.terminate', REQUEST_SAMPLES['admin.session.terminate']],
      ['worktree.merge.approve', REQUEST_SAMPLES['worktree.merge.approve']],
      ['worktree.merge.reject', REQUEST_SAMPLES['worktree.merge.reject']],
      ['lock.forceRelease', REQUEST_SAMPLES['lock.forceRelease']],
      ['suggest.accept', REQUEST_SAMPLES['suggest.accept']],
      ['session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 }],
      ['session.end', REQUEST_SAMPLES['session.end']],
      ['channel.leave', {}],
    ];
    for (const [type, payload] of attempts) {
      const answer = await local.request(type, payload);
      expect({ type, answer }).toMatchObject({ type, answer: { type: 'error', payload: { code: 'forbidden', detail: { reason: 'control-socket' } } } });
    }
    expect(t.ctx.members.get('dev:carol')).toMatchObject({ role: 'agent', status: 'active' });
    expect(t.ctx.hub.isOnline('dev:carol')).toBe(true);
    expect(carol.welcome?.member.role).toBe('agent');
    expect(t.ctx.invites.list()).toHaveLength(invitesBefore);
    expect(t.ctx.settings.public().humanLockIdleMs).not.toBe(61_000);
    // The local channel is still the host's and still works for the attach (no sessions module here: not-implemented).
    expect(await local.request('session.list', {})).toMatchObject({ type: 'error', payload: { detail: { reason: 'not-implemented' } } });
    // The log has the refusals, every one as the host via the control socket, and nothing else happened.
    expect(audit.map((e) => [e.action, e.outcome, e.target, e.detail?.['reason'], e.detail?.['via']])).toEqual(
      attempts.map(([type]) => ['authz.denied', 'denied', type, 'control-socket', 'control-socket']),
    );
    for (const entry of audit) expect(entry.actor).toMatchObject({ kind: 'user', userId: t.hostUserId });
  });
});

// Verification F-1 (2026-10-02): what a local channel RECEIVES unasked is limited as well, in the hub (one place, not
// per module): only what `smurg attach` consumes (src/local/local-channel.ts LOCAL_CHANNEL_RECEIVES). Before, the
// socket got every host fan-out, e.g. the live audit log (`admin.audit.entry`: every member's joins, refusals, role
// changes), which ARCHITECTURE §8 refuses there and the Agent access role never receives.
describe('what the local channel receives (verification F-1)', () => {
  const DAEMON_TYPES = MESSAGE_TYPES.filter((type) => MESSAGE_REGISTRY[type].dir !== 'c2d');
  const NOTICE = {
    notification: { id: 'ntf_f1', at: Date.now(), from: { kind: 'agent', sessionId: 'sess_f1', ownerUserId: 'dev:carol', displayName: 'Claude (Carol)' }, text: 'src/app.ts 我改好了' },
  } as const;
  const unasked = (client: LocalClient): string[] => client.received.filter((e) => e.type !== 'error' && !e.type.endsWith('.ok')).map((e) => e.type);

  it('the list is exactly what smurg attach consumes (plus the keep-alive), every entry a daemon message of the registry', () => {
    expect([...LOCAL_CHANNEL_RECEIVES].sort()).toEqual(['channel.ack', 'channel.closed', 'error', 'exec.output', 'exec.resize', 'presence.heartbeat', 'session.state']);
    for (const type of LOCAL_CHANNEL_RECEIVES) expect(DAEMON_TYPES).toContain(type);
  });

  it('every other daemon message is neither sent nor queued to a local channel (send, sendToUser, sendToChannels, broadcast), connected or waiting for a resume, although the host\'s role may receive it', async () => {
    const td = await createTestDaemon();
    t = td;
    const local = attachHost(td);
    local.attachment.open();
    await local.request('session.list', {});
    const channelId = local.attachment.welcome.channelId;
    const refused = DAEMON_TYPES.filter((type) => !localChannelReceives(type) && mayReceive('host', type));
    // The registry would let the host receive them all: what keeps them away is the local channel's list.
    expect(refused).toEqual(expect.arrayContaining(['admin.audit.entry', 'activity.notify', 'activity.event', 'presence.state', 'channel.memberUpdated', 'channel.settingsUpdated', 'suggest.updated', 'worktree.merge.updated']));
    // Protocol 4: conversations, cards, topics and the inbox are the web's; `smurg attach` is a terminal.
    expect(refused).toEqual(expect.arrayContaining(['session.events', 'session.delta', 'question.changed', 'question.updated', 'permission.updated', 'topic.updated', 'topic.removed', 'plan.updated', 'report.updated', 'inbox.changed']));
    const problems: string[] = [];
    const tryAll = (state: string): void => {
      for (const type of refused) {
        // A payload that would not even encode: the refusal must come before anything is encoded or queued.
        if (td.ctx.hub.send(channelId, type as never, {} as never)) problems.push(`${state} send ${type}`);
        if (td.ctx.hub.broadcast(type as never, {} as never, { filter: (r) => r.channelId === channelId })) problems.push(`${state} broadcast ${type}`);
        if (td.ctx.hub.sendToChannels([channelId], type as never, {} as never)) problems.push(`${state} sendToChannels ${type}`);
      }
      if (td.ctx.hub.sendToUser(td.hostUserId, 'activity.notify', NOTICE)) problems.push(`${state} sendToUser activity.notify`);
    };
    tryAll('connected');
    await local.request('session.list', {});
    expect(unasked(local)).toEqual([]);
    const lastSeq = local.received.filter((e) => e.seq > 0).at(-1)?.seq ?? 0;
    local.attachment.end();
    await waitFor(() => td.ctx.hub.connections().length === 0, { what: 'the local connection to end' });
    tryAll('disconnected');
    td.ctx.hub.broadcast('presence.heartbeat', { at: Date.now() }); // on the list: queued for the resume
    const again = attachHost(td, { channelId, lastSeq });
    expect(again.attachment.welcome.resumed).toBe(true);
    again.attachment.open();
    expect(problems).toEqual([]);
    expect(again.received.map((e) => e.type)).toEqual(['presence.heartbeat']);
  });

  it('gets none of the host-only fan-out the host\'s relay channel gets (the live audit log, the host\'s notices, settings), and nothing of it waits for its resume', async () => {
    const td = await createTestDaemon();
    t = td;
    const host = await td.connectHost();
    const relaySeen = new Set<string>();
    for (const type of ['admin.audit.entry', 'activity.notify', 'channel.settingsUpdated'] as const) host.conn.on(type, () => relaySeen.add(type));
    const local = attachHost(td);
    local.attachment.open();
    await local.request('session.list', {});
    await td.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'agent' });
    await host.conn.request('admin.settings.set', { humanLockIdleMs: 61_000 });
    td.ctx.hub.sendToUser(td.hostUserId, 'activity.notify', NOTICE);
    await host.conn.request('admin.member.setRole', { userId: 'dev:carol', role: 'editor' });
    await waitFor(() => relaySeen.size === 3, { what: 'the host\'s relay channel to get the fan-out' });
    await local.request('session.list', {});
    expect(unasked(local).filter((type) => !localChannelReceives(type))).toEqual([]);
    // Waiting for a resume: the audit entries of its own disconnect and of what happens meanwhile are not queued.
    const channelId = local.attachment.welcome.channelId;
    const lastSeq = local.received.filter((e) => e.seq > 0).at(-1)?.seq ?? 0;
    local.attachment.end();
    await waitFor(() => td.ctx.hub.connections({ userId: td.hostUserId }).length === 1, { what: 'only the host\'s relay channel left' });
    await td.connect({ userId: 'dev:dora', displayName: 'Dora', role: 'viewer' });
    await host.conn.request('admin.settings.set', { humanLockIdleMs: 62_000 });
    td.ctx.hub.sendToUser(td.hostUserId, 'activity.notify', NOTICE);
    const again = attachHost(td, { channelId, lastSeq });
    again.seq = local.seq; // the same logical channel: its c→d seq continues
    expect(again.attachment.welcome.resumed).toBe(true);
    again.attachment.open();
    await again.request('session.list', {});
    expect(unasked(again)).toEqual([]);
  });

  // Verification F-3: the refusal budget of the audit log (§11 D-10) is per actor AND origin, so a flood through the
  // socket (the host's actor, any session of a Agent access member) does not hide the host's own refusals on the web.
  it('a refusal flood through the socket leaves the host\'s own refusals on the web their audit budget; its summary says via control-socket (verification F-3)', async () => {
    const probe = createProbe();
    probe.overrides.set('session.end', () => {
      throw new SmurgError('forbidden', undefined, { reason: 'not-owner:session' });
    });
    const td = await createTestDaemon({ modules: [probe.module], limits: { auditDeniedPerActorPerMinute: 10 } });
    t = td;
    const host = await td.connectHost();
    const audit: AuditEntry[] = [];
    td.ctx.audit.subscribe((entry) => audit.push(entry));
    // A fresh socket every 30 refusals stays under the per-connection close (§11 D-10).
    for (let socket = 0; socket < 3; socket++) {
      const local = attachHost(td);
      local.attachment.open();
      for (let i = 0; i < 30; i++) await local.request('admin.member.list', {});
      local.attachment.end();
    }
    await expect(host.conn.request('session.end', { sessionId: 'ses_nope' })).rejects.toMatchObject({ code: 'forbidden' });
    const hostOwn = audit.filter((e) => e.target === 'session.end' && e.outcome === 'denied');
    expect(hostOwn.map((e) => [e.action, e.detail?.['reason'], e.detail?.['via']])).toEqual([['authz.denied', 'not-owner:session', undefined]]);
    // The next minute: the socket window's summary names its origin.
    td.advanceClock(61_000);
    const next = attachHost(td);
    next.attachment.open();
    await next.request('admin.member.list', {});
    const summaries = audit.filter((e) => e.target === 'audit-rate-limit');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ actor: { kind: 'user', userId: td.hostUserId }, outcome: 'denied', detail: { via: 'control-socket', reason: 'audit-rate-limit', notRecorded: 90 - 10 - 1 } });
  });

  it('a local admission never continues (nor replaces) a relay channel of the host', async () => {
    const td = await createTestDaemon();
    t = td;
    const host = await td.connectHost();
    const relayChannel = host.welcome?.channelId as string;
    const local = attachHost(td, { channelId: relayChannel, lastSeq: 0 });
    expect(local.attachment.welcome.resumed).toBe(false);
    expect(local.attachment.welcome.channelId).not.toBe(relayChannel);
    expect(td.ctx.hub.connections({ userId: td.hostUserId }).length).toBe(2); // the relay channel is not replaced
  });
});

describe('auth.disconnect (R11 logins and logouts)', () => {
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

  it('the status names what `smurg status` shows the host (fingerprint, relay, switch, git); a status without them (an older daemon) still parses', async () => {
    t = await createTestDaemon();
    const status = t.ctx.lifecycle.status();
    const { config } = t.daemon;
    expect(status).toMatchObject({
      fingerprint: t.daemon.fingerprint,
      relayUrl: config.relayUrl,
      switches: { attributeBashEdits: config.activity.attributeBashEdits },
      isGitRepo: t.ctx.workspace.info.isGitRepo,
    });
    // No guest sandbox any more (§11 D-15): nothing about it in the status.
    expect(Object.keys(status)).not.toContain('sandbox');
    expect(Object.keys(status.switches)).toEqual(['attributeBashEdits']);
    const { fingerprint: _f, relayUrl: _r, switches: _s, isGitRepo: _g, ...older } = status;
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
