// SPEC §8 / ARCHITECTURE §3 enforced end to end: for EVERY request type of the registry and EVERY role, a real client
// (real invite, real Noise channel) sends the request and the daemon allows or denies it exactly as the capability
// table says. Every denial is answered `forbidden`, never reaches a handler, and is audited as authz.denied.
// Includes SPEC R2's acceptance case: a viewer sending file.write is refused by the daemon and audited.
//
// Twice: (1) with a probe handler behind every type, which proves that a denial never reaches ANY handler; (2) with
// the release composition (DEFAULT_FEATURE_MODULES, the stand-in `claude`), which proves that every request type of
// protocol 4 has its real handler, that the table holds in front of the real handlers, and what each handler answers
// to a sample that points at nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MESSAGE_REGISTRY,
  MESSAGE_TYPES,
  isSmurgError,
  type AuditEntry,
  type Capability,
  type RequestType,
  type Role,
} from '@smurg/protocol';
import type { TransferConnection } from '@smurg/protocol/client';
import { FEATURE_SERVICE_NAMES } from '../src/core/interfaces.ts';
import { isStubService } from '../src/core/stubs.ts';
import { createTempDir, createTestDaemon, installFakeClaude, removeTempDir, waitFor, type FakeClaude, type TestClient, type TestDaemon } from '../src/testing/index.ts';
import type { InboundNotifyType } from '../src/core/interfaces.ts';
import { NOTIFY_SAMPLES, REQUEST_SAMPLES } from './fixtures/request-samples.ts';
import { createProbe, type Probe } from './fixtures/probe-module.ts';
import { CLI_MAIN } from './integration/support.ts';

// Transcribed from ARCHITECTURE §3 (independently of @smurg/protocol's roles.ts, which the daemon uses).
const ARCH3: Readonly<Record<Capability, readonly Role[]>> = {
  'file.read': ['host', 'agent', 'editor', 'viewer'],
  'file.download': ['host', 'agent', 'editor', 'viewer'],
  'session.view': ['host', 'agent', 'editor', 'viewer'],
  'file.write': ['host', 'agent', 'editor'],
  'suggest.create': ['host', 'agent', 'editor'],
  // Protocol 4: everyone but viewers votes, comments, may be responsible and reviews a result report.
  discuss: ['host', 'agent', 'editor'],
  // ARCHITECTURE §11 D-15: Agent access opens sessions (like the host's own) and types into any session.
  'session.create': ['host', 'agent'],
  'session.drive': ['host', 'agent'],
  'worktree.merge.request': ['host', 'agent'],
  'worktree.merge.decide': ['host'],
  'lock.force-release': ['host'],
  admin: ['host'],
};

function expectedAllowed(role: Role, type: RequestType | InboundNotifyType): boolean {
  const access = MESSAGE_REGISTRY[type].capability;
  if (access === 'none' || access === 'owner-checked-in-handler') return true;
  const caps: readonly Capability[] = typeof access === 'string' ? [access] : access;
  return caps.some((cap) => ARCH3[cap].includes(role));
}

const ROLES: readonly Role[] = ['host', 'agent', 'editor', 'viewer'];
const REQUEST_TYPES = MESSAGE_TYPES.filter((type): type is RequestType => MESSAGE_REGISTRY[type].result !== null);
const NOTIFY_TYPES = Object.keys(NOTIFY_SAMPLES) as InboundNotifyType[];

let t: TestDaemon;
let probe: Probe;
const clients = new Map<Role, TestClient>();
const transfers = new Map<Role, TransferConnection>();
const audit: AuditEntry[] = [];

function capabilityDenials(userId: string, type: string, entries: readonly AuditEntry[] = audit): number {
  return entries.filter(
    (e) => e.action === 'authz.denied' && e.actor.kind === 'user' && e.actor.userId === userId && e.target === type && e.detail?.['reason'] === 'capability',
  ).length;
}

describe('authorization table (every request type × every role)', () => {
  beforeAll(async () => {
    probe = createProbe();
    t = await createTestDaemon({ modules: [probe.module] });
    t.ctx.audit.subscribe((entry) => audit.push(entry));
    clients.set('host', await t.connectHost());
    clients.set('agent', await t.connect({ userId: 'dev:rita', role: 'agent' }));
    clients.set('editor', await t.connect({ userId: 'dev:eddie', role: 'editor' }));
    clients.set('viewer', await t.connect({ userId: 'dev:vera', role: 'viewer' }));
    for (const role of ROLES) transfers.set(role, await (clients.get(role) as TestClient).transfer());
  }, 60_000);

  afterAll(async () => {
    for (const transfer of transfers.values()) transfer.close();
    await t?.cleanup();
  });

  it('covers the whole registry', () => {
    expect(REQUEST_TYPES.length).toBe(Object.keys(REQUEST_SAMPLES).length);
    expect(REQUEST_TYPES.length).toBeGreaterThan(50);
  });

  it('allows exactly what ARCHITECTURE §3 allows and denies (forbidden, audited, no handler) the rest', async () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const role of ROLES) {
      const client = clients.get(role) as TestClient;
      for (const type of REQUEST_TYPES) {
        // channel.leave ends the caller's presence on the host: run it last (below).
        if (type === 'channel.leave') continue;
        const before = { denials: capabilityDenials(client.userId, type), hits: probe.count(type, client.userId) };
        const sample = REQUEST_SAMPLES[type];
        const request =
          MESSAGE_REGISTRY[type].channel === 'transfer'
            ? (transfers.get(role) as TransferConnection).request(type as never, sample as never)
            : client.conn.request(type as never, sample as never);
        const outcome: unknown = await request.then(
          () => 'ok',
          (err: unknown) => err,
        );
        const forbidden = isSmurgError(outcome) && outcome.code === 'forbidden';
        const auditedDenial = capabilityDenials(client.userId, type) === before.denials + 1;
        const reachedProbe = probe.count(type, client.userId) > before.hits;
        const denied = forbidden && auditedDenial && !reachedProbe;
        const allowed = !forbidden && !auditedDenial;
        const expected = expectedAllowed(role, type);
        if (expected ? !allowed : !denied) mismatches.push(`${role} ${type}: expected ${expected ? 'allowed' : 'denied'}, got ${isSmurgError(outcome) ? outcome.code : String(outcome)}`);
        // Where the probe answers (every non-core type), an allowed request must actually have reached it.
        if (expected && isSmurgError(outcome) && outcome.detail?.['reason'] === 'probe-reached' && !reachedProbe) mismatches.push(`${role} ${type}: probe not reached`);
        checked++;
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(ROLES.length * (REQUEST_TYPES.length - 1));
  }, 60_000);

  it('lets every role send the one-way messages the registry allows it', async () => {
    for (const role of ROLES) {
      const client = clients.get(role) as TestClient;
      for (const type of NOTIFY_TYPES) {
        const before = probe.count(type, client.userId);
        if (MESSAGE_REGISTRY[type].channel === 'transfer') (transfers.get(role) as TransferConnection).notify(type as never, NOTIFY_SAMPLES[type] as never);
        else client.conn.notify(type as never, NOTIFY_SAMPLES[type] as never);
        if (expectedAllowed(role, type)) await waitFor(() => probe.count(type, client.userId) === before + 1, { what: `${role} ${type}` });
      }
    }
  }, 30_000);

  it('SPEC R2: a viewer forging file.write is refused by the daemon and audited', async () => {
    const viewer = clients.get('viewer') as TestClient;
    const before = { denials: capabilityDenials(viewer.userId, 'file.write'), hits: probe.count('file.write') };
    const error = await viewer.conn
      .request('file.write', { file: { root: { kind: 'main' }, path: 'README.md' }, content: new TextEncoder().encode('forged by a viewer') })
      .catch((e: unknown) => e);
    expect(isSmurgError(error) && error.code).toBe('forbidden');
    expect(probe.count('file.write')).toBe(before.hits);
    const entry = audit.filter((e) => e.action === 'authz.denied' && e.target === 'file.write').at(-1);
    expect(entry).toMatchObject({ outcome: 'denied', actor: { kind: 'user', userId: 'dev:vera' }, detail: { type: 'file.write', reason: 'capability', role: 'viewer' } });
    expect(capabilityDenials(viewer.userId, 'file.write')).toBe(before.denials + 1);
  });

  it('channel.leave is open to every member', async () => {
    for (const role of ROLES) {
      await expect((clients.get(role) as TestClient).conn.request('channel.leave', {})).resolves.toEqual({});
    }
    expect(audit.filter((e) => e.action === 'member.leave').map((e) => (e.actor.kind === 'user' ? e.actor.userId : ''))).toEqual(['dev:rita', 'dev:eddie', 'dev:vera']);
  });
});

// =====================================================================================================================
// The release composition: the real handlers behind the same table
// =====================================================================================================================

/** How a request ended: `ok`, or the error's code and catalog id. */
function answerOf(outcome: unknown): string {
  if (!isSmurgError(outcome)) return String(outcome);
  return outcome.text === undefined ? outcome.code : `${outcome.code} ${outcome.text.id}`;
}

const NOT_FOUND = 'not_found error.default.notFound';
const NO_SESSION = 'not_found session.notFound';
const NO_QUESTION = 'not_found question.notFound';
const NO_SUGGESTION = 'not_found suggest.notFound';
const NO_TOPIC = 'not_found topic.notFound';
const NO_UPLOAD = 'not_found upload.notFound';
const NO_WORKTREE = 'not_found worktree.notFound';
const NO_MERGE = 'not_found merge.notFound';
const NO_PARENT = 'not_found file.parentMissing';

/**
 * What the REAL handler of each request type answers to its sample (fixtures/request-samples.ts: every sample points
 * at something that does not exist) for a role that holds the capability. One answer for every such role, except
 * where the roles are named: the requests run host first, so a later role can meet what an earlier one made. A mapped
 * type over the registry: a new request type without a row is a compile error.
 */
const REAL_ANSWERS: { readonly [T in Exclude<RequestType, 'channel.leave'>]: string | Readonly<Partial<Record<Role, string>>> } = {
  'file.tree': 'ok',
  'file.stat': NOT_FOUND,
  'file.create': NO_PARENT,
  'file.rename': NOT_FOUND,
  'file.delete': NOT_FOUND,
  'file.read': NOT_FOUND,
  'file.write': NO_PARENT,
  'file.upload.plan': 'ok',
  'file.upload.begin': 'ok',
  'file.upload.hashes': NO_UPLOAD,
  'file.upload.chunk': NO_UPLOAD,
  'file.upload.commit': NO_UPLOAD,
  'file.upload.abort': 'ok',
  'file.download.begin': NOT_FOUND,
  'doc.open': NOT_FOUND,
  'doc.conflict.list': 'ok',
  'doc.conflict.resolve': NOT_FOUND,
  'doc.conflict.get': NOT_FOUND,
  'lock.list': 'ok',
  'lock.release': 'ok',
  'lock.forceRelease': 'ok',
  'activity.list': 'ok',
  // A free agent session really starts (the stand-in `claude`), for the host and for a member with agent access.
  'session.create': 'ok',
  'session.list': 'ok',
  'session.host.get': 'ok',
  'session.loginStatus': NO_SESSION,
  'session.attach': NO_SESSION,
  'session.end': NO_SESSION,
  'session.rename': NO_SESSION,
  'session.watch': NO_SESSION,
  'session.history': NO_SESSION,
  'session.cards.get': NO_SESSION,
  'session.message.send': NO_SESSION,
  'session.interrupt': NO_SESSION,
  'session.retry': NO_SESSION,
  'session.restart': NO_SESSION,
  'session.responsible.set': NO_SESSION,
  'session.mode.set': NO_SESSION,
  'session.rules.get': NO_SESSION,
  'session.rule.remove': NO_SESSION,
  'question.vote': NO_QUESTION,
  'question.comment': NO_QUESTION,
  'question.submit': NO_QUESTION,
  'question.remind': NO_QUESTION,
  'permission.decide': 'not_found permission.notFound',
  'suggest.create': NO_SESSION,
  'suggest.edit': NO_SUGGESTION,
  'suggest.withdraw': NO_SUGGESTION,
  'suggest.accept': NO_SUGGESTION,
  'suggest.reject': NO_SUGGESTION,
  'suggest.list': 'ok',
  // The host's topic is made (its folder, its discussion session); the same name a second time is taken.
  'topic.create': { host: 'ok', agent: 'conflict topic.slugTaken' },
  'topic.list': 'ok',
  'topic.rename': NO_TOPIC,
  'topic.archive': NO_TOPIC,
  'topic.delete': NO_TOPIC,
  'topic.discussion.restart': NO_TOPIC,
  'topic.revise': NO_TOPIC,
  'topic.spec.request': NO_TOPIC,
  'topic.rule.add': NO_TOPIC,
  'topic.rule.remove': NO_TOPIC,
  'plan.generate': NO_TOPIC,
  'plan.get': NO_TOPIC,
  'plan.mode.set': NO_TOPIC,
  'plan.assign': NO_TOPIC,
  'plan.suggest': NO_TOPIC,
  'plan.preflight': NO_TOPIC,
  'plan.start': NO_TOPIC,
  'plan.changes': NO_TOPIC,
  'plan.resume': NO_TOPIC,
  'plan.item.retry': NO_TOPIC,
  'plan.item.continue': NO_TOPIC,
  'plan.item.resolve': NO_TOPIC,
  'report.get': 'not_found report.none',
  'report.followUp': NO_TOPIC,
  'report.review': NO_TOPIC,
  'inbox.list': 'ok',
  'inbox.dismiss': 'not_found inbox.itemGone',
  'worktree.list': 'ok',
  'worktree.remove': NO_WORKTREE,
  'worktree.merge.request': NO_WORKTREE,
  'worktree.merge.list': 'ok',
  'worktree.merge.diff': NO_MERGE,
  'worktree.merge.fileDiff': NO_MERGE,
  'worktree.merge.approve': NO_MERGE,
  'worktree.merge.reject': NO_MERGE,
  'admin.invite.create': 'ok',
  'admin.invite.list': 'ok',
  'admin.invite.revoke': NOT_FOUND,
  'admin.member.list': 'ok',
  'admin.member.setRole': 'not_found member.notFound',
  'admin.member.kick': 'not_found member.notFound',
  'admin.session.terminate': NO_SESSION,
  'admin.audit.query': 'ok',
  'admin.settings.get': 'ok',
  'admin.settings.set': 'ok',
  'admin.claudeConfig.get': 'ok',
  // The sample names a file the folder does not have: what the host looked at is not what is there.
  'admin.claudeConfig.decide': 'conflict claudeConfig.changed',
  'admin.hostRules.get': 'ok',
  'admin.hostRules.seen': 'ok',
  'admin.transcript.redact': NO_SESSION,
};

describe('the release composition: every request type × every role in front of the real handlers', () => {
  let d: TestDaemon;
  let scratch: string;
  let claude: FakeClaude;
  const members = new Map<Role, TestClient>();
  const sockets = new Map<Role, TransferConnection>();
  const entries: AuditEntry[] = [];

  beforeAll(async () => {
    scratch = await createTempDir('authorization');
    // The stand-in answers every message with "ok": the sessions that the allowed `session.create` and
    // `topic.create` really open never touch a model, an account or the network.
    claude = await installFakeClaude(scratch);
    // No `modules`: DEFAULT_FEATURE_MODULES, with the real `smurg hook` / `smurg mcp` as the sessions' commands.
    d = await createTestDaemon({ project: { git: true, files: { 'README.md': '# Shop\n' } }, sessions: { claudePath: claude.path, selfCommand: { file: process.execPath, args: [CLI_MAIN] } } });
    d.ctx.audit.subscribe((entry) => entries.push(entry));
    members.set('host', await d.connectHost());
    members.set('agent', await d.connect({ userId: 'dev:rita', displayName: 'Rita', role: 'agent' }));
    members.set('editor', await d.connect({ userId: 'dev:eddie', displayName: 'Eddie', role: 'editor' }));
    members.set('viewer', await d.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' }));
    for (const role of ROLES) sockets.set(role, await (members.get(role) as TestClient).transfer());
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets.values()) socket.close();
    await d?.cleanup();
    if (scratch) await removeTempDir(scratch);
  }, 60_000);

  it('every service is its module\'s (no stub answers below)', () => {
    expect(FEATURE_SERVICE_NAMES.filter((name) => isStubService(d.ctx.services[name]))).toEqual([]);
    expect(Object.keys(REAL_ANSWERS).sort()).toEqual(REQUEST_TYPES.filter((type) => type !== 'channel.leave').sort());
  });

  it('allowed: the real handler answers (never "not implemented"); denied: forbidden and audited, exactly as ARCHITECTURE §3 says', async () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const role of ROLES) {
      const client = members.get(role) as TestClient;
      for (const type of REQUEST_TYPES) {
        if (type === 'channel.leave') continue;
        const denialsBefore = capabilityDenials(client.userId, type, entries);
        const sample = REQUEST_SAMPLES[type];
        const request =
          MESSAGE_REGISTRY[type].channel === 'transfer'
            ? (sockets.get(role) as TransferConnection).request(type as never, sample as never)
            : client.conn.request(type as never, sample as never);
        const outcome: unknown = await request.then(
          () => 'ok',
          (err: unknown) => err,
        );
        const answer = answerOf(outcome);
        const audited = capabilityDenials(client.userId, type, entries) - denialsBefore;
        if (expectedAllowed(role, type)) {
          const row = REAL_ANSWERS[type];
          const expected = typeof row === 'string' ? row : row[role];
          if (answer !== expected || audited !== 0) mismatches.push(`${role} ${type}: expected ${expected ?? '(no row for this role)'}, got ${answer}${audited === 0 ? '' : ' and a capability denial'}`);
          // Whatever a handler answers, it is its own answer: no stub, no missing handler, no crash.
          if (isSmurgError(outcome) && (outcome.code === 'internal' || outcome.detail?.['reason'] === 'not-implemented')) mismatches.push(`${role} ${type}: ${outcome.code} (${String(outcome.detail?.['reason'])})`);
        } else if (answer !== 'forbidden error.default.forbidden' || audited !== 1) {
          mismatches.push(`${role} ${type}: expected a capability refusal, got ${answer} (${audited} audited)`);
        }
        checked++;
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(ROLES.length * (REQUEST_TYPES.length - 1));
  }, 120_000);

  it('what the allowed requests really did, and nothing the refused ones asked for', async () => {
    const host = members.get('host') as TestClient;
    // Two free sessions (the host's, Rita's) and the discussion of the host's topic: three starts of the stand-in.
    const { sessions } = await host.conn.request('session.list', {});
    expect(sessions.map((session) => (session.kind === 'agent' ? `${session.purpose} by ${session.openedBy.userId}` : session.kind)).sort()).toEqual(['discussion by dev:host', 'free by dev:host', 'free by dev:rita']);
    const { topics } = await host.conn.request('topic.list', {});
    expect(topics).toMatchObject([{ name: 'Checkout', slug: 'checkout', createdBy: { userId: 'dev:host' } }]);
    await waitFor(async () => (await claude.echoed()).filter((entry) => entry.kind === 'argv').length === 3, { timeoutMs: 20_000, what: 'the three agent sessions to have started' });
    // An Editor and a Viewer opened nothing, and the one invite a person made is the host's.
    expect(sessions.some((session) => ['dev:eddie', 'dev:vera'].includes(session.openedBy.userId))).toBe(false);
    expect(entries.filter((e) => e.action === 'invite.create' && e.actor.kind === 'user').map((e) => (e.actor.kind === 'user' ? e.actor.userId : ''))).toEqual(['dev:host']);
  }, 60_000);

  it('the one-way messages: sent by a role that may not, they are refused and audited; by one that may, they reach the real handler', async () => {
    const problems: string[] = [];
    for (const role of ROLES) {
      const client = members.get(role) as TestClient;
      const before = new Map(NOTIFY_TYPES.map((type) => [type, capabilityDenials(client.userId, type, entries)]));
      for (const type of NOTIFY_TYPES) {
        if (MESSAGE_REGISTRY[type].channel === 'transfer') (sockets.get(role) as TransferConnection).notify(type as never, NOTIFY_SAMPLES[type] as never);
        else client.conn.notify(type as never, NOTIFY_SAMPLES[type] as never);
      }
      // Messages of a channel are handled in order: once a later request is answered, each of these was decided.
      await client.conn.request('session.list', {});
      await (sockets.get(role) as TransferConnection).request('file.download.begin', REQUEST_SAMPLES['file.download.begin']).catch(() => undefined);
      for (const type of NOTIFY_TYPES) {
        const denied = capabilityDenials(client.userId, type, entries) - (before.get(type) ?? 0);
        if (denied !== (expectedAllowed(role, type) ? 0 : 1)) problems.push(`${role} ${type}: ${denied} capability denial(s)`);
      }
    }
    expect(problems).toEqual([]);
    // Nothing a sample pointed at existed, so nothing was done: the connections are all still there.
    for (const role of ROLES) expect((members.get(role) as TestClient).conn.getState().kind, role).toBe('online');
  }, 60_000);

  it('channel.leave is open to every member, with the real modules behind the teardown', async () => {
    for (const role of ROLES) await expect((members.get(role) as TestClient).conn.request('channel.leave', {})).resolves.toEqual({});
    expect(entries.filter((e) => e.action === 'member.leave').map((e) => (e.actor.kind === 'user' ? e.actor.userId : ''))).toEqual(['dev:rita', 'dev:eddie', 'dev:vera']);
    // Rita left: her free session ended with her (ARCHITECTURE §3 "When a member goes"); the host's are still there.
    const host = members.get('host') as TestClient;
    await waitFor(async () => !(await host.conn.request('session.list', {})).sessions.some((session) => session.openedBy.userId === 'dev:rita' && session.status !== 'ended'), { timeoutMs: 15_000, what: 'the session of the member who left to end' });
    expect((await host.conn.request('session.list', {})).sessions.filter((session) => session.openedBy.userId === 'dev:host' && session.status !== 'ended')).toHaveLength(2);
  }, 60_000);
});
