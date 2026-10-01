// SPEC R2 「被踢的使用者 3 秒內失去所有存取權」, SPEC R3 「被撤銷的裝置金鑰無法再建立連線」, and role changes that apply
// immediately (ARCHITECTURE §3, §4 "Kick / role change").
import { chmod } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, isSmurgError, parseInviteUrl } from '@smurg/protocol';
import { Connection, waitForState, type ConnectionState } from '@smurg/protocol/client';
import type { DaemonEvents } from '../src/core/interfaces.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { MEMBER_COLORS } from '../src/admin/members.ts';
import { READABLE_MEMBER_COLORS, contrastRatio, isReadableOnBothThemes } from '../src/locks/colors.ts';
import {
  createTempDir,
  createTempProject,
  createTempRunDir,
  createTestDaemon,
  removeTempDir,
  removeTempRunDir,
  waitFor,
  type TestClient,
  type TestDaemon,
} from '../src/testing/index.ts';
import { createProbe } from './fixtures/probe-module.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

function terminal(client: TestClient): Promise<ConnectionState> {
  return waitForState(client.conn, (s) => s.kind === 'rejected' || s.kind === 'closed' || s.kind === 'online', { timeoutMs: 10_000 });
}

describe('kick (R2) and revoked device keys (R3)', () => {
  it('closes every channel within 3 s, revokes the device keys, audits and emits member.kicked', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'agent' });
    const transfer = await amy.transfer();
    const kicked: DaemonEvents['member.kicked'][] = [];
    t.ctx.bus.on('member.kicked', (event) => kicked.push(event));
    const reasons: string[] = [];
    amy.conn.on('channel.closed', (payload) => reasons.push(payload.reason));

    const started = Date.now();
    await host.conn.request('admin.member.kick', { userId: 'dev:amy' });
    const state = await waitForState(amy.conn, (s) => s.kind === 'closed', { timeoutMs: 3_000 });
    const transferState = await waitForState(transfer, (s) => s.kind === 'closed', { timeoutMs: 3_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(state).toMatchObject({ kind: 'closed', reason: 'kicked' });
    expect(transferState).toMatchObject({ kind: 'closed', reason: 'kicked' });
    expect(reasons).toEqual(['kicked']);
    expect(t.ctx.hub.connections({ userId: 'dev:amy' })).toEqual([]);
    expect(t.relay.clientsOf('dev:amy')).toEqual([]);

    expect(t.ctx.members.get('dev:amy')).toMatchObject({ status: 'kicked' });
    expect(t.ctx.members.roleOf('dev:amy')).toBeNull();
    expect(t.ctx.members.devicesOf('dev:amy').every((d) => d.revoked)).toBe(true);
    expect(kicked).toEqual([{ userId: 'dev:amy', by: { kind: 'user', userId: t.hostUserId, displayName: 'Host' }, revokedDevices: [t.ctx.members.devicesOf('dev:amy')[0]?.deviceId] }]);
    const actions = (await t.ctx.audit.query({ limit: 100 })).map((e) => e.action);
    expect(actions).toContain('member.kick');
    expect(actions).toContain('device.revoke');
    const { members } = await host.conn.request('admin.member.list', {});
    expect(members.map((m) => m.userId)).not.toContain('dev:amy');
  });

  it('the revoked device key cannot connect again, not even through a fresh invite', async () => {
    t = await createTestDaemon();
    const oldLink = t.createInvite('editor', { maxUses: 10 });
    const amy = await t.connect({ userId: 'dev:amy', inviteUrl: oldLink });
    t.ctx.members.kick('dev:amy', SYSTEM_PRINCIPAL);
    await waitForState(amy.conn, (s) => s.kind === 'closed');

    const deviceMode = await amy.reconnect({ waitOnline: false });
    expect(await terminal(deviceMode)).toMatchObject({ kind: 'rejected', reason: 'device-revoked' });
    const freshLink = t.createInvite('editor');
    const sameKeyNewInvite = await amy.reconnect({ inviteUrl: freshLink, waitOnline: false, connection: { preferInvite: true } });
    expect(await terminal(sameKeyNewInvite)).toMatchObject({ kind: 'rejected', reason: 'device-revoked' });
    expect((await t.ctx.audit.query({ limit: 100 })).filter((e) => e.action === 'auth.rejected').map((e) => e.detail?.['reason'])).toContain('device-revoked');
  });

  it('a device that joined as one account cannot connect as another: its own reason, nothing is created or consumed', async () => {
    // One browser profile is one person per workspace. What happened to the project owner: joined as one dev account,
    // later logged in as `host` in the same browser, and got "cannot verify your login" with no way to tell why.
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const bob = { userId: 'dev:bob', displayName: 'Bob' };
    const fresh = t.createInvite('agent', { maxUses: 1 });
    const asBob = (inviteUrl: string | null): Connection => {
      const invite = inviteUrl === null ? null : parseInviteUrl(inviteUrl);
      return new Connection({
        relay: (t as TestDaemon).relay.apiFor(bob, (t as TestDaemon).issuer),
        workspaceId: (t as TestDaemon).workspaceId,
        deviceKeys: amy.device.deviceKeys, // Amy's browser
        pins: amy.device.pins,
        invite: invite === null ? null : { fingerprint: invite.fingerprint, secret: invite.secret },
        clientKind: 'web',
        deviceName: 'Test client',
        random: () => 0.5,
        backoff: { baseMs: 20, maxMs: 200 },
      });
    };
    const settled = (conn: Connection): Promise<ConnectionState> =>
      waitForState(conn, (s) => s.kind === 'rejected' || s.kind === 'closed' || s.kind === 'online', { timeoutMs: 10_000 });

    for (const conn of [asBob(null), asBob(fresh)]) {
      conn.start();
      try {
        expect(await settled(conn)).toEqual({ kind: 'rejected', reason: 'device-other-account' });
      } finally {
        conn.close();
      }
    }
    // Bob did not become a member, the single-use link is still good, and Amy's device is still hers.
    expect(t.ctx.members.get('dev:bob')).toBeNull();
    expect(t.ctx.members.devicesOf('dev:amy').map((d) => d.revoked)).toEqual([false]);
    const bobOnHisOwnDevice = await t.connect({ userId: 'dev:bob', displayName: 'Bob', inviteUrl: fresh });
    expect(bobOnHisOwnDevice.welcome?.member).toMatchObject({ userId: 'dev:bob', role: 'agent' });
    expect((await amy.reconnect()).welcome?.member).toMatchObject({ userId: 'dev:amy' });
    const rejected = (await t.ctx.audit.query({ limit: 100 })).filter((e) => e.action === 'auth.rejected');
    expect(rejected.map((e) => [e.target, e.detail?.['reason'], e.detail?.['why']])).toEqual(
      expect.arrayContaining([['dev:bob', 'device-other-account', 'device-bound-to-other-user']]),
    );
    // The invite attempt is not retried through the link a second time: one refusal per connection.
    expect(rejected).toHaveLength(2);
  });

  it('an old multi-use link cannot undo a kick; a link created after the kick can (with a new device key)', async () => {
    t = await createTestDaemon();
    const oldLink = t.createInvite('editor', { maxUses: 10 });
    const amy = await t.connect({ userId: 'dev:amy', inviteUrl: oldLink });
    t.ctx.members.kick('dev:amy', SYSTEM_PRINCIPAL);
    await waitForState(amy.conn, (s) => s.kind === 'closed');

    const viaOldLink = await t.connect({ userId: 'dev:amy', inviteUrl: oldLink, waitOnline: false });
    expect(await terminal(viaOldLink)).toMatchObject({ kind: 'rejected', reason: 'kicked' });
    t.advanceClock(1_000);
    const reinvited = await t.connect({ userId: 'dev:amy', inviteUrl: t.createInvite('viewer') });
    expect(reinvited.welcome?.member).toMatchObject({ userId: 'dev:amy', role: 'viewer' });
  });

  it('a kick while the state cannot be written is in force, reported as not saved, written once the disk recovers and still in force after a restart (REL-14)', async () => {
    const stateDir = await createTempRunDir();
    const projectBase = await createTempDir('kick-restart');
    try {
      const root = await createTempProject(projectBase, 'project', { files: { 'a.md': 'a\n' } });
      const workspaceId = 'ws_test_kick_restart';
      t = await createTestDaemon({ stateDir, root, workspaceId });
      const host = await t.connectHost();
      const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
      const wsDir = t.daemon.config.workspaceStateDir;
      await chmod(wsDir, 0o500); // stands in for a full disk
      let kickError: unknown;
      try {
        kickError = await host.conn.request('admin.member.kick', { userId: 'dev:amy' }).then(
          () => null,
          (err: unknown) => err,
        );
        expect(kickError).toMatchObject({ code: 'internal', detail: { reason: 'state-not-saved', applied: true } });
        // In force now (fail closed while the daemon runs): channel closed, device revoked.
        await waitForState(amy.conn, (s) => s.kind === 'closed', { timeoutMs: 3_000 });
        expect(t.ctx.members.get('dev:amy')).toMatchObject({ status: 'kicked' });
        expect(t.daemon.internals.store.unsaved().map((u) => u.name)).toEqual(['state']);
      } finally {
        await chmod(wsDir, 0o700); // space freed
      }
      // Nothing else changes the state: the store's own retry writes it.
      await waitFor(() => t?.daemon.internals.store.unsaved().length === 0, { what: 'the retried state write', timeoutMs: 5_000 });
      await t.cleanup();
      t = await createTestDaemon({ stateDir, root, workspaceId });
      expect(t.ctx.members.get('dev:amy')).toMatchObject({ status: 'kicked' });
      expect(t.ctx.members.devicesOf('dev:amy').every((d) => d.revoked)).toBe(true);
      // Her old device key (device mode, no invite) against the restarted daemon.
      const back = new Connection({
        relay: t.relay.apiFor(amy.device.user, t.issuer),
        workspaceId,
        deviceKeys: amy.device.deviceKeys,
        pins: amy.device.pins,
        invite: null,
        clientKind: 'web',
        deviceName: 'Test client',
        random: () => 0.5,
        backoff: { baseMs: 20, maxMs: 200 },
      });
      back.start();
      try {
        expect(await waitForState(back, (s) => s.kind === 'rejected' || s.kind === 'closed' || s.kind === 'online', { timeoutMs: 10_000 })).toMatchObject({
          kind: 'rejected',
          reason: 'device-revoked',
        });
      } finally {
        back.close();
      }
    } finally {
      await t?.cleanup();
      t = null;
      await removeTempDir(projectBase);
      await removeTempRunDir(stateDir);
    }
  }, 30_000);

  it('the host cannot be kicked or demoted', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    await expect(host.conn.request('admin.member.kick', { userId: t.hostUserId })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(host.conn.request('admin.member.setRole', { userId: t.hostUserId, role: 'viewer' })).rejects.toMatchObject({ code: 'bad_request' });
    expect(t.ctx.members.roleOf(t.hostUserId)).toBe('host');
  });
});

describe('role changes', () => {
  it('apply to the very next message and hand the client a fresh Welcome with the new role', async () => {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [probe.module] });
    const host = await t.connectHost();
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const write = () => amy.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'a.txt' }, content: new Uint8Array([1]) }).catch((e: unknown) => e);
    expect(await write()).toMatchObject({ code: 'conflict', detail: { reason: 'probe-reached' } });

    const welcomes: string[] = [];
    amy.conn.onWelcome((welcome) => welcomes.push(welcome.member.role));
    const { member } = await host.conn.request('admin.member.setRole', { userId: 'dev:amy', role: 'viewer' });
    expect(member.role).toBe('viewer');
    // Router level: the role is read per message, so a message dispatched now is judged with the new role.
    expect(t.ctx.members.roleOf('dev:amy')).toBe('viewer');
    await waitFor(() => welcomes.length > 0 && amy.conn.getState().kind === 'online', { what: 'reconnect after role change' });
    expect(welcomes).toEqual(['viewer']);
    const denied = await write();
    expect(isSmurgError(denied) && denied.code).toBe('forbidden');
    expect(probe.count('file.write', 'dev:amy')).toBe(1);
    const audit = await t.ctx.audit.query({ limit: 100 });
    expect(audit.find((e) => e.action === 'member.role')).toMatchObject({ target: 'dev:amy', detail: { from: 'editor', to: 'viewer' } });
  });

  it('a promotion lets the member do more right away', async () => {
    const probe = createProbe();
    t = await createTestDaemon({ modules: [probe.module] });
    const vera = await t.connect({ userId: 'dev:vera', role: 'viewer' });
    const write = () => vera.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'a.txt' }, content: new Uint8Array([1]) }).catch((e: unknown) => e);
    expect(await write()).toMatchObject({ code: 'forbidden' });
    t.ctx.members.setRole('dev:vera', 'editor', SYSTEM_PRINCIPAL);
    await waitFor(() => vera.conn.getState().kind === 'online' && vera.conn.welcome?.member.role === 'editor', { what: 'role-changed reconnect' });
    expect(await write()).toMatchObject({ code: 'conflict', detail: { reason: 'probe-reached' } });
  });
});

describe('member colours', () => {
  it('every colour a member can get is readable on both editor themes and the 12 are distinct', () => {
    expect(new Set(MEMBER_COLORS).size).toBe(12);
    for (const color of MEMBER_COLORS) {
      expect(isReadableOnBothThemes(color), color).toBe(true);
      expect(contrastRatio(color, '#ffffff'), color).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(color, '#1e1e1e'), color).toBeGreaterThanOrEqual(3);
    }
    // One palette: presence (locks module) and the member directory agree.
    expect(MEMBER_COLORS).toEqual(READABLE_MEMBER_COLORS);
  });

  it('new members get colours from that palette', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy' });
    const bob = await t.connect({ userId: 'dev:bob' });
    for (const client of [amy, bob]) expect(MEMBER_COLORS).toContain(client.welcome?.member.color);
    expect(amy.welcome?.member.color).not.toBe(bob.welcome?.member.color);
  });
});
