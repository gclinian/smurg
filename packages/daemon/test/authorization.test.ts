// SPEC §8 / ARCHITECTURE §3 enforced end to end: for EVERY request type of the registry and EVERY role, a real client
// (real invite, real Noise channel) sends the request and the daemon allows or denies it exactly as the capability
// table says. Every denial is answered `forbidden`, never reaches a handler, and is audited as authz.denied.
// Includes SPEC R2's acceptance case: a viewer sending file.write is refused by the daemon and audited.
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
import { createTestDaemon, waitFor, type TestClient, type TestDaemon } from '../src/testing/index.ts';
import type { InboundNotifyType } from '../src/core/interfaces.ts';
import { NOTIFY_SAMPLES, REQUEST_SAMPLES } from './fixtures/request-samples.ts';
import { createProbe, type Probe } from './fixtures/probe-module.ts';

// Transcribed from ARCHITECTURE §3 (independently of @smurg/protocol's roles.ts, which the daemon uses).
const ARCH3: Readonly<Record<Capability, readonly Role[]>> = {
  'file.read': ['host', 'agent', 'editor', 'viewer'],
  'file.download': ['host', 'agent', 'editor', 'viewer'],
  'session.view': ['host', 'agent', 'editor', 'viewer'],
  'file.write': ['host', 'agent', 'editor'],
  'suggest.create': ['host', 'agent', 'editor'],
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

function capabilityDenials(userId: string, type: string): number {
  return audit.filter(
    (e) => e.action === 'authz.denied' && e.actor.kind === 'user' && e.actor.userId === userId && e.target === type && e.detail?.['reason'] === 'capability',
  ).length;
}

describe('authorization table (every request type × every role)', () => {
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
