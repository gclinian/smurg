// SPEC R2 (an expired or used-up invite link does not work) and the invite rules of ARCHITECTURE §4 / noise.md V1, V8: expired, used-up
// and revoked links are refused with an authenticated `invite-invalid`; concurrent joins cannot overrun maxUses
// (check-and-consume is one synchronous step after msg3); the host's own link works only for the host.
import { afterEach, describe, expect, it } from 'vitest';
import { buildInviteUrl, deriveInviteKeys, generateInviteSecret, parseInviteUrl, toBase64Url, toHex } from '@smurg/protocol';
import { waitForState, type ConnectionState } from '@smurg/protocol/client';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { createTestDaemon, type TestClient, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function finalState(client: TestClient): Promise<ConnectionState> {
  return waitForState(client.conn, (s) => s.kind === 'online' || s.kind === 'rejected' || s.kind === 'closed' || s.kind === 'key-mismatch', { timeoutMs: 10_000 }).catch(
    () => client.conn.getState(),
  );
}

function usesOf(t: TestDaemon, inviteId: string): number | undefined {
  return t.ctx.invites.list().find((invite) => invite.id === inviteId)?.uses;
}

describe('invites', () => {
  it('admits a guest through an invite with the invite role and consumes one use', async () => {
    t = await createTestDaemon();
    const { invite, url } = t.ctx.invites.create({ role: 'agent', maxUses: 3 }, SYSTEM_PRINCIPAL);
    const rita = await t.connect({ userId: 'dev:rita', inviteUrl: url });
    expect(rita.welcome?.member.role).toBe('agent');
    expect(usesOf(t, invite.id)).toBe(1);
    const entry = (await t.ctx.audit.query({ limit: 50 })).find((e) => e.action === 'auth.join');
    expect(entry).toMatchObject({ outcome: 'ok', actor: { kind: 'user', userId: 'dev:rita' }, detail: { role: 'agent', newMember: true } });
    // The link (it contains the secret) never reaches the audit log, and nothing the host or the log sees reveals
    // the Noise invite id (knowing it would let anyone forge a msg1 that passes the daemon's pre-DH filter).
    const auditText = JSON.stringify(await t.ctx.audit.query({ limit: 500 }));
    expect(auditText).not.toContain(url.split('#')[1] as string);
    const noiseInviteId = deriveInviteKeys(parseInviteUrl(url).secret).inviteId;
    for (const encoding of [toBase64Url(noiseInviteId), toHex(noiseInviteId)]) {
      expect(invite.id).not.toContain(encoding);
      expect(auditText).not.toContain(encoding);
    }
  });

  it('refuses an expired link, and re-checks expiry at admission', async () => {
    t = await createTestDaemon();
    const url = t.createInvite('editor', { expiresInSec: 60 });
    t.advanceClock(61_000);
    const late = await t.connect({ userId: 'dev:late', inviteUrl: url, waitOnline: false });
    expect(await finalState(late)).toMatchObject({ kind: 'rejected', reason: 'invite-invalid' });
    expect(t.ctx.members.get('dev:late')).toBeNull();
    const rejected = (await t.ctx.audit.query({ limit: 50 })).find((e) => e.action === 'auth.rejected');
    expect(rejected?.detail).toMatchObject({ reason: 'invite-invalid', why: 'invite-expired' });
  });

  it('refuses a used-up link', async () => {
    t = await createTestDaemon();
    const url = t.createInvite('editor', { maxUses: 1 });
    await t.connect({ userId: 'dev:first', inviteUrl: url });
    const second = await t.connect({ userId: 'dev:second', inviteUrl: url, waitOnline: false });
    expect(await finalState(second)).toMatchObject({ kind: 'rejected', reason: 'invite-invalid' });
    expect(t.ctx.members.get('dev:second')).toBeNull();
  });

  it('refuses a revoked link (admin.invite.revoke)', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const { invite, url } = await host.conn.request('admin.invite.create', { role: 'viewer', maxUses: 5 });
    await host.conn.request('admin.invite.revoke', { inviteId: invite.id });
    expect((await host.conn.request('admin.invite.list', {})).invites.find((i) => i.id === invite.id)?.revoked).toBe(true);
    const guest = await t.connect({ userId: 'dev:guest', inviteUrl: url, waitOnline: false });
    expect(await finalState(guest)).toMatchObject({ kind: 'rejected', reason: 'invite-invalid' });
  });

  it.each([
    { maxUses: 1, joiners: 2 },
    { maxUses: 1, joiners: 8 },
    { maxUses: 2, joiners: 6 },
  ])('never admits more than maxUses=$maxUses of $joiners concurrent joiners', async ({ maxUses, joiners }) => {
    t = await createTestDaemon();
    const { invite, url } = t.ctx.invites.create({ role: 'editor', maxUses }, SYSTEM_PRINCIPAL);
    const clients = await Promise.all(Array.from({ length: joiners }, (_, i) => (t as TestDaemon).connect({ userId: `dev:joiner${i}`, inviteUrl: url, waitOnline: false })));
    const states = await Promise.all(clients.map(finalState));
    expect(states.filter((s) => s.kind === 'online')).toHaveLength(maxUses);
    expect(states.filter((s) => s.kind === 'rejected' && s.reason === 'invite-invalid')).toHaveLength(joiners - maxUses);
    expect(usesOf(t, invite.id)).toBe(maxUses);
    expect(t.ctx.members.list().filter((m) => m.userId.startsWith('dev:joiner'))).toHaveLength(maxUses);
  });

  it("the host's own link is bound to the host: another user is refused and does not consume it", async () => {
    t = await createTestDaemon();
    const hostUrl = t.daemon.hostInviteUrl as string;
    expect(hostUrl).toContain(`/join/${t.workspaceId}#k=`);
    const mallory = await t.connect({ userId: 'dev:mallory', inviteUrl: hostUrl, waitOnline: false });
    expect(await finalState(mallory)).toMatchObject({ kind: 'rejected', reason: 'identity-invalid' });
    expect(t.ctx.members.get('dev:mallory')).toBeNull();
    const host = await t.connect({ userId: t.hostUserId, inviteUrl: hostUrl });
    expect(host.welcome?.member.role).toBe('host');
    // Single use: a second device of the host needs a new link.
    const again = await t.connect({ userId: t.hostUserId, inviteUrl: hostUrl, waitOnline: false });
    expect(await finalState(again)).toMatchObject({ kind: 'rejected', reason: 'invite-invalid' });
  });

  // Security review F2: whoever can make the relay assert the host's identity (a compromised relay or host OAuth
  // account) must not gain a host device through a GUEST link: host power needs the host-bound host invite.
  it('a guest link redeemed under the host user id is refused and adds no host device', async () => {
    t = await createTestDaemon();
    const viewerLink = t.createInvite('viewer', { maxUses: 5 });
    const attacker = await t.connect({ userId: t.hostUserId, inviteUrl: viewerLink, waitOnline: false });
    expect(await finalState(attacker)).toMatchObject({ kind: 'rejected', reason: 'invite-invalid' });
    expect(t.ctx.members.devicesOf(t.hostUserId)).toHaveLength(0);
    const rejected = (await t.ctx.audit.query({ limit: 50 })).find((e) => e.action === 'auth.rejected');
    expect(rejected?.detail).toMatchObject({ reason: 'invite-invalid', why: 'host-needs-host-invite' });
    const info = t.ctx.invites.list().find((invite) => invite.role === 'viewer');
    expect(info?.uses).toBe(0);
  });

  it('an existing member cannot add a device through a link of another role (no role change by invite)', async () => {
    t = await createTestDaemon();
    await t.connect({ userId: 'dev:vera', role: 'viewer' });
    const agentLink = t.createInvite('agent');
    const again = await t.connect({ userId: 'dev:vera', inviteUrl: agentLink, waitOnline: false });
    expect(await finalState(again)).toMatchObject({ kind: 'rejected', reason: 'invite-invalid' });
    expect(t.ctx.members.devicesOf('dev:vera')).toHaveLength(1);
    expect(t.ctx.members.roleOf('dev:vera')).toBe('viewer');
    // The same role is fine: a second device of the same member.
    const sameRole = await t.connect({ userId: 'dev:vera', inviteUrl: t.createInvite('viewer') });
    expect(sameRole.welcome?.member.role).toBe('viewer');
    expect(t.ctx.members.devicesOf('dev:vera')).toHaveLength(2);
  });

  it('a new host link revokes the previous unused one', async () => {
    t = await createTestDaemon();
    const first = t.daemon.hostInviteUrl as string;
    t.daemon.internals.invites.createHostInvite();
    const host = await t.connect({ userId: t.hostUserId, inviteUrl: first, waitOnline: false });
    expect(await finalState(host)).toMatchObject({ kind: 'rejected', reason: 'invite-invalid' });
  });

  it('a link with a secret the daemon never issued gets only the generic ABORT (no verdict)', async () => {
    t = await createTestDaemon();
    const forged = buildInviteUrl('https://relay.smurg.test', t.workspaceId, t.daemon.daemonPublicKey, generateInviteSecret());
    const client = await t.connect({ userId: 'dev:forger', inviteUrl: forged, waitOnline: false, connection: { maxAbortedHandshakes: 2 } });
    expect(await finalState(client)).toMatchObject({ kind: 'rejected', reason: 'aborted' });
    expect(t.ctx.members.get('dev:forger')).toBeNull();
  });

  it('only the host can create invites, and never with the host role', async () => {
    t = await createTestDaemon();
    expect(() => t?.ctx.invites.create({ role: 'host' as never }, SYSTEM_PRINCIPAL)).toThrow();
    const editor = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    await expect(editor.conn.request('admin.invite.create', { role: 'editor' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
