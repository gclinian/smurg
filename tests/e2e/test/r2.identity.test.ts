// SPEC R2 acceptance (identity, invites, roles), against the real relay, the real daemon and SDK clients. Every
// invite here is made by the host over the encrypted channel (admin.invite.create), every kick goes through
// admin.member.kick: the same path the host console uses.
//  - 「過期或用完次數的邀請連結無法使用」
//  - 「被踢的使用者 3 秒內失去所有存取權，他的 session 程序被終止」 (sessions: once the session module exists)
//  - 「偽造的客戶端請求（例如旁觀者送出 `file.write`）被 daemon 拒絕」
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isStubService } from '@smurg/daemon';
import { MAIN_ROOT, SmurgError, encodeEnvelope, type AuditEntry } from '@smurg/protocol';
import type { ConnectionState } from '@smurg/protocol/client';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, waitUntil, type Stack, type StackClient } from '../src/harness.ts';
import { connectRawClient } from '../src/raw-client.ts';

/** SPEC R2: a kicked user loses all access within 3 s. */
const KICK_DEADLINE_MS = 3_000;

const execFileAsync = promisify(execFile);

/** How many processes run with exactly this command line. Reads the process table; never signals anything. */
async function processesRunning(commandLine: string): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'args=']);
  return stdout.split('\n').filter((line) => line.trim() === commandLine).length;
}
const README = '# shared project\n';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: false });
});

afterAll(async () => {
  await relay?.stop();
});

async function terminal(client: StackClient, timeoutMs = 15_000): Promise<ConnectionState> {
  return client.waitFor((s) => s.kind === 'rejected' || s.kind === 'closed' || s.kind === 'key-mismatch', timeoutMs);
}

async function rejectionsFor(stack: Stack, userId: string): Promise<AuditEntry[]> {
  await stack.daemon.ctx.audit.flush();
  return (await stack.audit()).filter((e) => e.action === 'auth.rejected' && e.target === userId);
}

describe('R2 邀請連結', () => {
  it('過期或用完次數的邀請連結無法使用 — an expired invite', async () => {
    const stack = await startStack({ relay });
    try {
      const expiring = await stack.createInvite('editor', { maxUses: 5, expiresInSec: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const amy = await stack.join({ name: 'amy', invite: expiring, waitOnline: false });
      expect(await terminal(amy)).toEqual({ kind: 'rejected', reason: 'invite-invalid' });
      expect(amy.states.some((r) => r.state.kind === 'online')).toBe(false);
      const why = (await rejectionsFor(stack, amy.userId)).map((e) => e.detail?.['why']);
      expect(why).toContain('invite-expired');
      expect(stack.daemon.ctx.members.get(amy.userId)).toBeNull();
      // Positive control: the same person, same device, with a link that has not expired, gets in.
      const again = await stack.join({ name: 'amy', device: amy.device, invite: await stack.createInvite('editor') });
      expect(again.welcome?.member.userId).toBe(amy.userId);
    } finally {
      await stack.stop();
    }
  });

  it('過期或用完次數的邀請連結無法使用 — a used-up invite, also under concurrent joins', async () => {
    const stack = await startStack({ relay });
    try {
      const single = await stack.createInvite('editor', { maxUses: 1 });
      const amy = await stack.join({ name: 'amy', invite: single });
      expect(amy.welcome?.member.role).toBe('editor');
      const bob = await stack.join({ name: 'bob', invite: single, waitOnline: false });
      expect(await terminal(bob)).toEqual({ kind: 'rejected', reason: 'invite-invalid' });
      expect((await rejectionsFor(stack, bob.userId)).map((e) => e.detail?.['why'])).toContain('invite-used-up');
      expect(stack.daemon.ctx.members.get(bob.userId)).toBeNull();

      // Three people race for a two-use link through the real relay: exactly two get in.
      const double = await stack.createInvite('viewer', { maxUses: 2 });
      const racers = await Promise.all(['carol', 'dave', 'erin'].map((name) => stack.join({ name, invite: double, waitOnline: false })));
      const outcomes = await Promise.all(racers.map((c) => c.waitFor((s) => s.kind === 'online' || s.kind === 'rejected' || s.kind === 'closed')));
      expect(outcomes.filter((s) => s.kind === 'online')).toHaveLength(2);
      expect(outcomes.filter((s) => s.kind === 'rejected')).toEqual([{ kind: 'rejected', reason: 'invite-invalid' }]);
      const { invites } = await stack.hostClient.conn.request('admin.invite.list', {});
      expect(invites.find((i) => i.role === 'viewer' && i.maxUses === 2)?.uses).toBe(2);
    } finally {
      await stack.stop();
    }
  });
});

describe('R2 踢人', () => {
  it('被踢的使用者 3 秒內失去所有存取權 — measured on both sockets, at the relay and in the daemon', async () => {
    const stack = await startStack({ relay });
    try {
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      const transfer = await amy.transfer();
      const amyDevices = () => stack.daemon.ctx.members.devicesOf(amy.userId);
      expect(amyDevices().every((d) => !d.revoked)).toBe(true);

      let interactiveLost = 0;
      let transferLost = 0;
      amy.conn.subscribe((s) => {
        if (s.kind === 'closed' && interactiveLost === 0) interactiveLost = Date.now();
      });
      transfer.subscribe((s) => {
        if ((s.kind === 'closed' || s.kind === 'rejected') && transferLost === 0) transferLost = Date.now();
      });

      const t0 = Date.now();
      await stack.hostClient.conn.request('admin.member.kick', { userId: amy.userId });
      const replied = Date.now() - t0;
      await waitUntil(() => interactiveLost > 0 && transferLost > 0, KICK_DEADLINE_MS + 2_000, 'both of amy\'s sockets to end');
      await waitUntil(
        async () => {
          const [ws, xfer] = await Promise.all([relay.inspect('ws', stack.workspaceId), relay.inspect('xfer', stack.workspaceId)]);
          return ![...ws.clients, ...xfer.clients].some((c) => c.userId === amy.userId);
        },
        KICK_DEADLINE_MS + 2_000,
        'the relay to drop amy\'s sockets',
      );
      const relayGone = Date.now() - t0;
      const daemonConns = stack.daemon.internals.hub.connections({ userId: amy.userId }).length;
      console.info(
        `[R2] kick: daemon replied ${replied} ms, interactive closed ${interactiveLost - t0} ms, transfer closed ${transferLost - t0} ms, relay dropped both sockets ≤ ${relayGone} ms`,
      );

      expect(amy.conn.getState()).toMatchObject({ kind: 'closed', reason: 'kicked' });
      expect(interactiveLost - t0).toBeLessThan(KICK_DEADLINE_MS);
      expect(transferLost - t0).toBeLessThan(KICK_DEADLINE_MS);
      expect(relayGone).toBeLessThan(KICK_DEADLINE_MS);
      expect(daemonConns).toBe(0);
      expect(stack.daemon.ctx.members.get(amy.userId)?.status).toBe('kicked');
      expect(amyDevices().length).toBeGreaterThan(0);
      expect(amyDevices().every((d) => d.revoked)).toBe(true);
      // No request of hers is answered any more.
      await expect(amy.conn.request('admin.member.list', {})).rejects.toMatchObject({ failure: 'closed' });

      await stack.daemon.ctx.audit.flush();
      const entries = await stack.audit();
      expect(entries.some((e) => e.action === 'member.kick' && e.target === amy.userId)).toBe(true);
      expect(entries.filter((e) => e.action === 'device.revoke').length).toBe(amyDevices().length);
    } finally {
      await stack.stop();
    }
  });

  it('被踢的使用者 3 秒內失去所有存取權 — and cannot come back with the old device or an old link', async () => {
    const stack = await startStack({ relay });
    try {
      // A multi-use link that existed before the kick (e.g. still in the class chat).
      const oldLink = await stack.createInvite('editor', { maxUses: 10 });
      const amy = await stack.join({ name: 'amy', invite: oldLink });
      await stack.hostClient.conn.request('admin.member.kick', { userId: amy.userId });
      await amy.waitFor((s) => s.kind === 'closed');

      // 1. The same device reconnects with its pinned key (device mode).
      const sameDevice = await amy.reconnect({ waitOnline: false });
      expect(await terminal(sameDevice)).toEqual({ kind: 'rejected', reason: 'device-revoked' });
      // 2. The same device key through the old link.
      const sameDeviceOldLink = await amy.reconnect({ invite: oldLink, waitOnline: false, connection: { preferInvite: true } });
      expect(await terminal(sameDeviceOldLink)).toEqual({ kind: 'rejected', reason: 'device-revoked' });
      // 3. A brand-new device key through the old link: the link predates the kick.
      const newDeviceOldLink = await stack.join({ name: 'amy', invite: oldLink, waitOnline: false });
      expect(await terminal(newDeviceOldLink)).toEqual({ kind: 'rejected', reason: 'kicked' });
      for (const client of [sameDevice, sameDeviceOldLink, newDeviceOldLink]) {
        expect(client.states.some((r) => r.state.kind === 'online')).toBe(false);
      }
      expect(stack.daemon.internals.hub.connections({ userId: amy.userId })).toHaveLength(0);
      expect((await rejectionsFor(stack, amy.userId)).map((e) => e.detail?.['reason'])).toEqual(expect.arrayContaining(['device-revoked', 'kicked']));

      // Positive control: only the host can let her back in, with a link made after the kick and a new device key.
      const back = await stack.join({ name: 'amy', role: 'viewer' });
      expect(back.welcome?.member).toMatchObject({ userId: amy.userId, role: 'viewer' });
    } finally {
      await stack.stop();
    }
  });

  it('被踢的使用者…他的 session 程序被終止', async () => {
    // The guest's session runs in the main workspace: open it to guests explicitly, so the test is the same on a Linux
    // host, where it is off by default (ARCHITECTURE §11 D-14).
    const stack = await startStack({ relay, sessions: { guestMainWorkspace: true } });
    try {
      // A runner starts a terminal session with a background process, the host kicks them, and within 3 s both the
      // session and the PROCESS are gone (not only the daemon's belief in session.list: ARCHITECTURE §11 D-3).
      // A composition without the real sessions module fails here instead of skipping (review SPEC-11).
      expect(isStubService(stack.daemon.ctx.services.sessions), 'the default composition provides SessionManager').toBe(false);
      const carol = await stack.join({ name: 'carol', role: 'runner' });
      const { session } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
      await waitUntil(async () => (await carol.conn.request('session.list', {})).sessions.some((s) => s.id === session.id && s.status === 'running'), 10_000, 'the session to run');
      // A unique argument identifies the child without a pid (a sandbox's PID namespace would print another pid).
      const marker = `sleep ${600_000 + Math.floor(Math.random() * 99_999)}`;
      expect(carol.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode(`${marker} &\r`) })).toBe(true);
      await waitUntil(async () => (await processesRunning(marker)) > 0, 10_000, 'the background process to start');
      const t0 = Date.now();
      await stack.hostClient.conn.request('admin.member.kick', { userId: carol.userId });
      await waitUntil(
        async () => (await stack.hostClient.conn.request('session.list', {})).sessions.every((s) => s.id !== session.id || s.status === 'exited'),
        KICK_DEADLINE_MS,
        'the kicked runner\'s session to exit',
      );
      await waitUntil(async () => (await processesRunning(marker)) === 0, Math.max(0, KICK_DEADLINE_MS - (Date.now() - t0)), 'the session\'s process to be gone');
      console.info(`[R2] kick: runner's session and its process gone after ${Date.now() - t0} ms`);
    } finally {
      await stack.stop();
    }
  });
});

describe('R2 偽造的客戶端請求', () => {
  it('偽造的客戶端請求（例如旁觀者送出 `file.write`）被 daemon 拒絕', async () => {
    const stack = await startStack({ relay, projectFiles: { 'README.md': README } });
    try {
      const bob = await stack.join({ name: 'bob', role: 'viewer' });
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      // The SDK does not stop a viewer from sending file.write (hiding it is the UI's job): the daemon must.
      const write = bob.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'README.md' }, content: new TextEncoder().encode('defaced by a viewer\n') });
      await expect(write).rejects.toBeInstanceOf(SmurgError);
      await expect(write).rejects.toMatchObject({ code: 'forbidden' });
      // Other forged requests: escalating one's own role, admin actions from a non-host.
      await expect(bob.conn.request('admin.member.setRole', { userId: bob.userId, role: 'editor' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(amy.conn.request('admin.member.kick', { userId: stack.host.userId })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(amy.conn.request('admin.invite.create', { role: 'runner' })).rejects.toMatchObject({ code: 'forbidden' });

      // A client that does not use the SDK at all: a viewer's device speaking the raw protocol.
      const eve = await stack.newDevice('eve');
      const raw = await connectRawClient(stack, eve, { invite: await stack.createInvite('viewer') });
      try {
        const id = 'raw-viewer-write';
        raw.sendBytes(
          encodeEnvelope(
            { type: 'file.write', id, seq: raw.nextSeq(), payload: { file: { root: MAIN_ROOT, path: 'README.md' }, content: new TextEncoder().encode('defaced raw\n') } },
            { from: 'client', channel: 'interactive' },
          ),
        );
        const reply = await raw.next((e) => e.id === id);
        expect(reply).toMatchObject({ type: 'error', payload: { code: 'forbidden' } });
      } finally {
        raw.close();
      }

      expect(await readFile(join(stack.root, 'README.md'), 'utf8')).toBe(README);
      expect(stack.daemon.ctx.members.get(bob.userId)?.role).toBe('viewer');
      expect(stack.daemon.ctx.members.get(stack.host.userId)?.status).toBe('active');
      await stack.daemon.ctx.audit.flush();
      const denied = (await stack.audit()).filter((e) => e.action === 'authz.denied' && e.outcome === 'denied');
      const by = (userId: string, target: string) => denied.some((e) => e.actor.kind === 'user' && e.actor.userId === userId && e.target === target);
      expect(by(bob.userId, 'file.write')).toBe(true);
      expect(by(bob.userId, 'admin.member.setRole')).toBe(true);
      expect(by(amy.userId, 'admin.member.kick')).toBe(true);
      expect(by(amy.userId, 'admin.invite.create')).toBe(true);
      expect(by(eve.session.userId, 'file.write')).toBe(true);
    } finally {
      await stack.stop();
    }
  });
});
