// SPEC R1 acceptance (daemon and workspace), against the real relay, the real daemon and SDK clients.
//  - 「主人斷線後 10 秒內，所有客人的介面顯示離線」: measured for a sleeping laptop (socket open, silent) and a clean stop.
//  - 「對分享資料夾以外路徑的請求（包括 symlink、`..`）一律被拒絕並記錄」: at the PathGuard every file handler must use,
//    over the wire with a forged client, and (once the file module exists) through file.read.
// The install-time criterion (「在全新的 macOS 和 Ubuntu 24.04 上…不超過 3 分鐘」) is manual: see docs/ACCEPTANCE.md.
import { MAIN_ROOT, type AnyEnvelope, type AuditEntry } from '@smurg/protocol';
import { isPathDeniedError, userPrincipal, type Principal } from '@smurg/daemon';
import type { ConnectionState } from '@smurg/protocol/client';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, waitUntil, type Stack, type StackClient } from '../src/harness.ts';
import { connectRawClient, forgeEnvelope } from '../src/raw-client.ts';

/** SPEC R1: every guest shows the host offline within 10 s. */
const OFFLINE_DEADLINE_MS = 10_000;
const SECRET = 'SMURG-R1-OUTSIDE-SECRET-5f0c2a91d7';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: false });
});

afterAll(async () => {
  await relay?.stop();
});

/** Milliseconds from `since` to the first recorded state of `client` that matches. */
function firstStateAfter(client: StackClient, since: number, predicate: (state: ConnectionState) => boolean): { ms: number; reason: string } | null {
  const hit = client.states.find((r) => r.at >= since && predicate(r.state));
  if (!hit) return null;
  return { ms: hit.at - since, reason: 'reason' in hit.state ? String(hit.state.reason) : hit.state.kind };
}

async function joinGuests(stack: Stack): Promise<StackClient[]> {
  return Promise.all([
    stack.join({ name: 'amy', role: 'editor' }),
    stack.join({ name: 'bob', role: 'viewer' }),
    stack.join({ name: 'carol', role: 'runner' }),
  ]);
}

describe('R1 主人離線', () => {
  it('主人斷線後 10 秒內，所有客人的介面顯示離線 — the host laptop sleeps (socket stays open, silent)', async () => {
    const stack = await startStack({ relay });
    try {
      const guests = await joinGuests(stack);
      // Steady state first: a few pings and presence heartbeats have gone by.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      for (const guest of guests) expect(guest.conn.getState().kind).toBe('online');

      const t0 = Date.now();
      stack.pauseHost();
      // The last thing the host put on the wire before it fell silent (its pings go out every ~2 s).
      const hostSent = stack.wire.frames({ side: 'host', direction: 'sent' }).filter((f) => f.at <= t0);
      const lastHeard = Math.max(...hostSent.map((f) => f.at));
      const lastPing = Math.max(...hostSent.filter((f) => f.label === 'ws' && f.kind === 'text' && f.data.toString() === 'ping').map((f) => f.at));
      // Two independent signals must each reach every guest in time: the client's own silence detector (no encrypted
      // presence.heartbeat for 8 s) and the relay's host.offline (no "ping" for 6 s). The UI shows the first.
      await Promise.all(guests.map((g) => g.waitFor((s) => s.kind === 'host-offline' && s.reason === 'relay', OFFLINE_DEADLINE_MS + 2_000)));
      const seen = guests.map((g) => ({
        name: g.name,
        first: firstStateAfter(g, t0, (s) => s.kind === 'host-offline'),
        relay: firstStateAfter(g, t0, (s) => s.kind === 'host-offline' && s.reason === 'relay'),
      }));
      const sinceHeard = (ms: number | undefined) => (ms === undefined ? Infinity : ms + (t0 - lastHeard));
      const report = seen.map((s) => `${s.name} ${s.first?.ms} ms (${s.first?.reason}; relay's host.offline ${s.relay?.ms} ms)`).join(', ');
      console.info(`[R1] host paused → guests show 「主人已離線」 after: ${report}; the host was last heard ${t0 - lastHeard} ms before the pause`);

      for (const s of seen) {
        expect(s.first, `${s.name} never showed the host offline`).not.toBeNull();
        expect(s.relay, `${s.name} never got the relay's host.offline`).not.toBeNull();
        // Measured from the pause and, stricter, from the host's last transmission.
        expect(s.first?.ms ?? Infinity, `${s.name} saw the host offline too late`).toBeLessThan(OFFLINE_DEADLINE_MS);
        expect(sinceHeard(s.first?.ms), `${s.name}: too late after the host's last transmission`).toBeLessThan(OFFLINE_DEADLINE_MS);
        expect(sinceHeard(s.relay?.ms), `${s.name} got the relay's verdict too late`).toBeLessThan(OFFLINE_DEADLINE_MS);
        // Not an artefact of a closed socket: the relay's verdict is its heartbeat timeout, 6 s after the last ping.
        const relayAfterPing = (s.relay?.ms ?? 0) + (t0 - lastPing);
        expect(relayAfterPing, `${s.name}: relay verdict ${relayAfterPing} ms after the last ping`).toBeGreaterThanOrEqual(5_700);
      }
      // The relay decided "timeout", i.e. the socket was still open: the sleeping laptop, not a disconnect.
      const room = await relay.inspect('ws', stack.workspaceId);
      expect(room.hostStatus).toBe('offline');
      expect(room.hostOfflineReason).toBe('timeout');

      // The laptop wakes up: the daemon reconnects and every guest is back without doing anything.
      const t1 = Date.now();
      stack.resumeHost();
      await Promise.all(guests.map((g) => g.waitFor((s) => s.kind === 'online', 20_000)));
      console.info(`[R1] host resumed → all guests online again after ${Date.now() - t1} ms`);
    } finally {
      await stack.stop();
    }
  });

  it('主人斷線後 10 秒內，所有客人的介面顯示離線 — the host stops sharing (clean disconnect)', async () => {
    const stack = await startStack({ relay });
    try {
      const guests = await joinGuests(stack);
      const t0 = Date.now();
      await stack.daemon.stop('smurg stop');
      await Promise.all(guests.map((g) => g.waitFor((s) => s.kind === 'host-offline', OFFLINE_DEADLINE_MS + 2_000)));
      const seen = guests.map((g) => ({ name: g.name, ...firstStateAfter(g, t0, (s) => s.kind === 'host-offline') }));
      console.info(`[R1] daemon stopped → guests show 「主人已離線」: ${seen.map((s) => `${s.name} ${s.ms} ms (${s.reason})`).join(', ')}`);
      for (const s of seen) expect(s.ms ?? Infinity).toBeLessThan(OFFLINE_DEADLINE_MS);
      await waitUntil(async () => (await relay.inspect('ws', stack.workspaceId)).hostStatus === 'offline', 5_000, 'the relay to mark the host offline');
    } finally {
      await stack.stop();
    }
  });
});

describe('R1 分享資料夾以外的路徑', () => {
  const projectFiles = {
    'README.md': '# project\n',
    'src/app.ts': 'export const app = 1;\n',
    // Escape attempts through links inside the share, and one harmless in-share link.
    'link-out': { symlink: '../outside' },
    'link-secret': { symlink: '../outside/secret.txt' },
    'src/deep/up': { symlink: '../../../outside' },
    'inner-link': { symlink: 'src' },
  } as const;
  const outsideFiles = { 'secret.txt': `${SECRET}\n` };

  /** Every attack path and the PathGuard reason it must be refused with. */
  const ATTACKS: readonly { path: string; forWrite?: boolean; reason: string }[] = [
    { path: '../outside/secret.txt', reason: 'lexical' },
    { path: 'src/../../outside/secret.txt', reason: 'lexical' },
    { path: '/etc/passwd', reason: 'lexical' },
    { path: '..', reason: 'lexical' },
    { path: 'src\\..\\..\\outside', reason: 'lexical' },
    { path: 'link-out/secret.txt', reason: 'outside-root' },
    { path: 'link-secret', reason: 'outside-root' },
    { path: 'src/deep/up/secret.txt', reason: 'outside-root' },
    { path: 'link-out/planted.txt', forWrite: true, reason: 'outside-root' },
  ];

  function pathDenials(entries: readonly AuditEntry[], userId: string): AuditEntry[] {
    return entries.filter((e) => e.action === 'path.denied' && e.outcome === 'denied' && e.actor.kind === 'user' && e.actor.userId === userId);
  }

  it('對分享資料夾以外路徑的請求（包括 symlink、`..`）一律被拒絕並記錄 — PathGuard, for a guest and for the host', async () => {
    const stack = await startStack({ relay, projectFiles, outsideFiles });
    try {
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      const principals: [string, Principal][] = [];
      for (const userId of [amy.userId, stack.host.userId]) {
        const member = stack.daemon.ctx.members.get(userId);
        const principal = member ? userPrincipal(member) : null;
        if (!principal) throw new Error(`no principal for ${userId}`);
        principals.push([userId, principal]);
      }
      for (const [userId, principal] of principals) {
        for (const attack of ATTACKS) {
          const outcome = await stack.daemon.ctx.paths
            .resolve({ root: MAIN_ROOT, path: attack.path }, { principal, ...(attack.forWrite ? { forWrite: true } : {}) })
            .then(
              (resolved) => ({ ok: true as const, abs: resolved.realPath }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          expect(outcome.ok, `${userId} resolved ${attack.path}`).toBe(false);
          if (!outcome.ok) {
            expect(isPathDeniedError(outcome.error), `${attack.path}: ${String(outcome.error)}`).toBe(true);
            if (isPathDeniedError(outcome.error)) expect(outcome.error.reason, attack.path).toBe(attack.reason);
          }
        }
        // Positive controls: ordinary paths and a link that stays inside the share resolve.
        await expect(stack.daemon.ctx.paths.resolve({ root: MAIN_ROOT, path: 'src/app.ts' }, { principal, mustExist: true })).resolves.toBeTruthy();
        await expect(stack.daemon.ctx.paths.resolve({ root: MAIN_ROOT, path: 'inner-link/app.ts' }, { principal, mustExist: true })).resolves.toBeTruthy();
      }
      // Every refusal is in the audit log, attributed to whoever asked, with the path as they sent it.
      await stack.daemon.ctx.audit.flush();
      const entries = await stack.audit();
      for (const [userId] of principals) {
        const denied = pathDenials(entries, userId);
        expect(denied.length, `path.denied entries for ${userId}`).toBe(ATTACKS.length);
        // The target is the path exactly as sent (JSON-escaped), qualified by its root.
        expect(new Set(denied.map((e) => e.target))).toEqual(new Set(ATTACKS.map((a) => `main:${JSON.stringify(a.path).slice(1, -1)}`)));
      }
      // Nothing leaked, nothing was planted outside.
      expect(JSON.stringify(entries)).not.toContain(SECRET);
    } finally {
      await stack.stop();
    }
  });

  it('對分享資料夾以外路徑的請求（包括 symlink、`..`）一律被拒絕 — a forged `..` file.read over the encrypted channel', async () => {
    const stack = await startStack({ relay, projectFiles, outsideFiles });
    try {
      const mallory = await stack.newDevice('mallory');
      const raw = await connectRawClient(stack, mallory, { invite: await stack.createInvite('editor') });
      try {
        // The SDK refuses to encode `..`; a hostile client does not use the SDK.
        const id = 'forged-dotdot-1';
        const bytes = forgeEnvelope(
          { type: 'file.read', id, seq: raw.nextSeq(), payload: { file: { root: MAIN_ROOT, path: 'xx/outside/secret.txt' } } },
          'xx/outside/secret.txt',
          '../outside/secret.txt',
        );
        raw.sendBytes(bytes);
        const reply: AnyEnvelope = await raw.next((e) => e.id === id);
        expect(reply.type).toBe('error');
        expect((reply.payload as { code: string }).code).toBe('bad_request');
        expect(JSON.stringify(raw.received.map((e) => e.payload))).not.toContain(SECRET);
        // The connection survives a single bad request (the daemon counts protocol errors, it does not crash).
        expect(raw.channel.isClosed).toBe(false);
      } finally {
        raw.close();
      }
    } finally {
      await stack.stop();
    }
  });

  // An envelope whose path fails the lexical rules is refused by decodeEnvelope before any handler runs; the hub audits
  // that refusal as path.denied (SPEC R1 「拒絕並記錄」, ARCHITECTURE §2 rule 4 / §7.4).
  it('對分享資料夾以外路徑的請求（包括 symlink、`..`）一律被拒絕並記錄 — the forged `..` request is audited', async () => {
    const stack = await startStack({ relay, projectFiles, outsideFiles });
    try {
      const mallory = await stack.newDevice('mallory');
      const raw = await connectRawClient(stack, mallory, { invite: await stack.createInvite('editor') });
      try {
        const id = 'forged-dotdot-2';
        raw.sendBytes(
          forgeEnvelope(
            { type: 'file.read', id, seq: raw.nextSeq(), payload: { file: { root: MAIN_ROOT, path: 'xx/outside/secret.txt' } } },
            'xx/outside/secret.txt',
            '../outside/secret.txt',
          ),
        );
        await raw.next((e) => e.id === id);
      } finally {
        raw.close();
      }
      await stack.daemon.ctx.audit.flush();
      const entries = await stack.audit();
      const audited = entries.filter((e) => e.outcome === 'denied' && e.actor.kind === 'user' && e.actor.userId === mallory.session.userId);
      expect(audited.map((e) => [e.action, e.target, e.detail?.['reason'], e.detail?.['problem']])).toEqual([['path.denied', 'file.read', 'lexical', 'dot-segment']]);
    } finally {
      await stack.stop();
    }
  });

  it('對分享資料夾以外路徑的請求（包括 symlink、`..`）一律被拒絕並記錄 — file.read through a symlink out of the share', async () => {
    const stack = await startStack({ relay, projectFiles, outsideFiles });
    try {
      // A composition without the files module fails here instead of skipping (review SPEC-11).
      expect(stack.daemon.ctx.router.has('file.read'), 'the default composition registers file.read').toBe(true);
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      for (const path of ['link-out/secret.txt', 'link-secret', 'src/deep/up/secret.txt']) {
        const outcome = await amy.conn.request('file.read', { file: { root: MAIN_ROOT, path } }).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        expect(outcome.ok, `file.read ${path} was answered`).toBe(false);
        if (!outcome.ok) expect((outcome.error as { code?: string }).code, path).toBe('path_denied');
      }
      await stack.daemon.ctx.audit.flush();
      expect(pathDenials(await stack.audit(), amy.userId).length).toBeGreaterThanOrEqual(3);
    } finally {
      await stack.stop();
    }
  });
});
