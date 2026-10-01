// SPEC R9 「開 agent session 時可以選擇「共享主工作區」或「我的 worktree」」, as narrowed on a Linux host by ARCHITECTURE §11
// D-14 (owner decision 2026-10-01): guests' sandboxed sessions in the MAIN workspace are off by default on Linux (the
// mount-based sandbox cannot deny new nested host-only names, §12), and the host opens them with `smurg host
// --allow-main-workspace-guests`. Through the real relay, the real daemon with every module (the real guest sandbox)
// and real SDK clients:
//  - switched off on a git share: every member's Welcome says so; a runner's terminal and agent in the main workspace
//    are refused (forbidden, main-workspace-off) and audited, nothing is started for them; the same runner's own
//    worktree terminal runs (sandboxed); the host's own main-workspace terminal runs (not sandboxed, not affected);
//  - when the host said nothing, the platform decides: refused on a Linux host, allowed on macOS.
import { isStubService } from '@smurg/daemon';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, waitUntil } from '../src/harness.ts';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: false });
});

afterAll(async () => {
  await relay?.stop();
});

const terminal = { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 } as const;
const agent = { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24 } as const;

describe('R9 / §11 D-14 guests in the main workspace', () => {
  it('switched off on a git share: a runner\'s main-workspace sessions are refused and audited, their worktree terminal runs, the host is not affected', async () => {
    const stack = await startStack({ relay, git: true, projectFiles: { 'README.md': '# d14\n' }, sessions: { guestMainWorkspace: false } });
    try {
      expect(isStubService(stack.daemon.ctx.services.sessions), 'the default composition provides SessionManager').toBe(false);
      const carol = await stack.join({ name: 'carol', role: 'runner' });
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      // The daemon tells every member, so a client offers only what it allows.
      for (const client of [stack.hostClient, carol, amy]) expect(client.welcome?.settings.guestMainWorkspace).toBe(false);

      for (const request of [terminal, agent]) {
        const refused = await carol.conn.request('session.create', request).then(() => null, (e: unknown) => e);
        expect(refused).toMatchObject({ code: 'forbidden', detail: { reason: 'main-workspace-off' } });
        expect((refused as { message: string }).message).toContain('worktree');
        expect((refused as { message: string }).message).toContain('--allow-main-workspace-guests');
      }
      expect((await stack.hostClient.conn.request('session.list', {})).sessions).toEqual([]);

      // The runner's own worktree: a sandboxed terminal in it.
      const { session: inWorktree } = await carol.conn.request('session.create', { ...terminal, workspace: { mode: 'worktree' } });
      expect(inWorktree).toMatchObject({ sandboxed: true, ownerUserId: carol.userId, status: 'running', root: { kind: 'worktree' } });
      // The host's own terminal in the main workspace.
      const { session: hostTerminal } = await stack.hostClient.conn.request('session.create', terminal);
      expect(hostTerminal).toMatchObject({ sandboxed: false, root: { kind: 'main' }, status: 'running' });

      // Audited (R11): the two refusals as denied session.create entries with the reason, the two starts as ok ones.
      await waitUntil(async () => (await stack.audit()).filter((e) => e.action === 'session.create').length === 4, 5_000, 'the session.create entries');
      const created = (await stack.audit()).filter((e) => e.action === 'session.create');
      const denied = created.filter((e) => e.outcome === 'denied');
      expect(denied).toHaveLength(2);
      for (const entry of denied) {
        expect(entry).toMatchObject({ actor: { kind: 'user', userId: carol.userId }, target: 'main', detail: { sandboxed: true, root: 'main', reason: 'main-workspace-off' } });
      }
      expect(denied.map((e) => e.detail?.['kind']).sort()).toEqual(['agent', 'terminal']);
      expect(created.filter((e) => e.outcome === 'ok').map((e) => e.detail?.['sandboxed']).sort()).toEqual([false, true]);

      for (const [client, id] of [[carol, inWorktree.id], [stack.hostClient, hostTerminal.id]] as const) await client.conn.request('session.end', { sessionId: id, keepWorktree: false });
    } finally {
      await stack.stop();
    }
  });

  it('the host said nothing: the platform\'s default decides (off on a Linux host, on on macOS), told in the Welcome and enforced', async () => {
    const stack = await startStack({ relay });
    try {
      const open = process.platform !== 'linux';
      expect(stack.daemon.config.sessions.guestMainWorkspace).toBe(open);
      const carol = await stack.join({ name: 'carol', role: 'runner' });
      expect(carol.welcome?.settings.guestMainWorkspace).toBe(open);
      expect(stack.hostClient.welcome?.settings.guestMainWorkspace).toBe(open);
      const result = await carol.conn.request('session.create', terminal).then(({ session }) => session, (e: unknown) => e);
      if (open) {
        expect(result).toMatchObject({ sandboxed: true, root: { kind: 'main' }, status: 'running' });
        await carol.conn.request('session.end', { sessionId: (result as { id: string }).id });
      } else {
        expect(result).toMatchObject({ code: 'forbidden', detail: { reason: 'main-workspace-off' } });
        // Not a git repository here: no worktree either, and the message says so.
        expect((result as { message: string }).message).toContain('不是 git 儲存庫');
      }
    } finally {
      await stack.stop();
    }
  });
});
