// SPEC R11 acceptance (host console and audit log), prototype scope, through the same encrypted admin requests the
// web console sends. The console UI itself ("one click") is covered by the browser tests in apps/web/e2e (planned).
//  - the host can terminate any session or remove any member from the console with one click
//  - every event R4–R9 define appears in the audit log: one scenario through the real relay touches every R4–R9 action of the
//    protocol's audit vocabulary (AUDIT_ACTIONS)
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStubService } from '@smurg/daemon';
import { AUDIT_ACTIONS, MAIN_ROOT, type AuditAction, type AuditEntry } from '@smurg/protocol';
import { uploadRootHash, type Connection } from '@smurg/protocol/client';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The daemon's test Yjs client (a provider over doc.* with per-docId buffering): test-only relative import.
import { DocClient } from '../../../packages/daemon/test/docs/helpers.ts';
import { startStack, waitUntil } from '../src/harness.ts';

/** The `smurg` command as sessions run it in development (node + the CLI's source entry). */
const CLI_MAIN = fileURLToPath(new URL('../../../packages/cli/src/main.ts', import.meta.url));

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay({ tap: false });
});

afterAll(async () => {
  await relay?.stop();
});

describe('R11 host console', () => {
  it('the host can terminate any session or remove any member from the console with one click — any member, one request each, visible in the audit log', async () => {
    const stack = await startStack({ relay });
    try {
      const guests = await Promise.all([
        stack.join({ name: 'amy', role: 'editor' }),
        stack.join({ name: 'bob', role: 'viewer' }),
        stack.join({ name: 'carol', role: 'agent' }),
      ]);
      const hostConsole = stack.hostClient.conn;
      const online = await hostConsole.request('admin.member.list', {});
      expect(online.members.filter((m) => m.online).map((m) => m.userId).sort()).toEqual(['dev:amy', 'dev:bob', 'dev:carol', 'dev:host']);
      for (const guest of guests) {
        await hostConsole.request('admin.member.kick', { userId: guest.userId });
        await guest.waitFor((s) => s.kind === 'closed', 3_000);
        expect(guest.conn.getState()).toMatchObject({ kind: 'closed', reason: 'kicked' });
      }
      const after = await hostConsole.request('admin.member.list', {});
      expect(after.members.map((m) => m.userId)).toEqual(['dev:host']);
      // The host reads the log from the console (admin.audit.query over the encrypted channel).
      await waitUntil(
        async () => (await hostConsole.request('admin.audit.query', { limit: 200 })).entries.filter((e) => e.action === 'member.kick').length === 3,
        5_000,
        'the kicks in the audit log',
      );
      const { entries } = await hostConsole.request('admin.audit.query', { limit: 200 });
      for (const guest of guests) {
        expect(entries.some((e) => e.action === 'member.kick' && e.target === guest.userId && e.actor.kind === 'user' && e.actor.userId === stack.host.userId)).toBe(true);
        expect(entries.some((e) => e.action === 'auth.join' && e.actor.kind === 'user' && e.actor.userId === guest.userId)).toBe(true);
      }
    } finally {
      await stack.stop();
    }
  });

  it('the host can terminate any session from the console with one click', async () => {
    const stack = await startStack({ relay });
    try {
      // A composition without the real sessions module fails here instead of skipping.
      expect(isStubService(stack.daemon.ctx.services.sessions), 'the default composition provides SessionManager').toBe(false);
      // An agent-access member's terminal (it runs as the host, §11 D-15): one request from the console ends it.
      const carol = await stack.join({ name: 'carol', role: 'agent' });
      const { session } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
      await stack.hostClient.conn.request('admin.session.terminate', { sessionId: session.id });
      await waitUntil(
        async () => (await stack.hostClient.conn.request('session.list', {})).sessions.every((s) => s.id !== session.id || s.status === 'exited'),
        5_000,
        'the session to exit',
      );
      const ended = (await stack.hostClient.conn.request('session.list', {})).sessions.find((s) => s.id === session.id);
      expect(ended).toMatchObject({ status: 'exited', endReason: 'terminated', endedBy: { userId: stack.host.userId } });
    } finally {
      await stack.stop();
    }
  });

  // R11 (the audit log covers logins and logouts): every connection has an auth.connect and, when it ends, an auth.disconnect.
  it('the audit log covers logins and logouts — auth.connect and auth.disconnect of a guest, readable from the console', async () => {
    const stack = await startStack({ relay });
    try {
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      amy.close();
      const hostConsole = stack.hostClient.conn;
      const mine = async () =>
        (await hostConsole.request('admin.audit.query', { limit: 200 })).entries.filter((e) => e.actor.kind === 'user' && e.actor.userId === amy.userId);
      await waitUntil(async () => (await mine()).some((e) => e.action === 'auth.disconnect'), 10_000, 'auth.disconnect of amy');
      const entries = await mine();
      const connect = entries.find((e) => e.action === 'auth.connect');
      const disconnect = entries.find((e) => e.action === 'auth.disconnect');
      expect(connect?.detail).toMatchObject({ purpose: 'interactive' });
      expect(disconnect?.target).toBe(connect?.target); // the same device
      expect(disconnect?.detail).toMatchObject({ purpose: 'interactive' });
      expect((disconnect?.at ?? 0) > (connect?.at ?? 0)).toBe(true);
    } finally {
      await stack.stop();
    }
  });

  it('every event R4–R9 define appears in the audit log', async () => {
    const savedShell = process.env['SHELL'];
    // Every session starts the host's $SHELL (§11 D-15): a plain POSIX shell whatever the developer uses.
    process.env['SHELL'] = '/bin/sh';
    const stack = await startStack({
      relay,
      git: true,
      projectFiles: { 'README.md': '# e2e\n', 'src/app.ts': 'export const a = 1;\n', 'conflict.txt': 'line one\nline two\n', 'notes/keep.md': 'keep\n' },
      // No disk reserve: the upload must not depend on this machine's free space.
      settings: { diskReserveBytes: 0, diskReservePercent: 0 },
    });
    const docs: DocClient[] = [];
    try {
      const host = stack.hostClient.conn;
      const amy = await stack.join({ name: 'amy', role: 'editor' });
      // Agent-access members (§11 D-15): they open sessions; Dave later leaves.
      const carol = await stack.join({ name: 'carol', role: 'agent' });
      const dave = await stack.join({ name: 'dave', role: 'agent' });
      const main = (path: string) => ({ root: MAIN_ROOT, path });
      const bytes = (text: string) => new TextEncoder().encode(text);

      // R7 files: create, write, rename, delete (interactive socket), upload and download (transfer socket).
      await amy.conn.request('file.create', { file: main('draft.txt'), kind: 'file' });
      await amy.conn.request('file.write', { file: main('draft.txt'), content: bytes('draft\n') });
      await amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'draft.txt', to: 'final.txt' });
      await amy.conn.request('file.delete', { file: main('final.txt') });
      const xfer = await amy.transfer();
      const payload = bytes('uploaded through the transfer socket\n');
      const CHUNK = 1024 * 1024;
      const begin = await xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'upload.txt', size: payload.byteLength, chunkSize: CHUNK, lastModified: Date.now() });
      const hash = new Uint8Array(createHash('sha256').update(payload).digest());
      await xfer.request('file.upload.chunk', { uploadId: begin.uploadId, index: 0, hash, data: payload });
      await xfer.request('file.upload.commit', { uploadId: begin.uploadId, rootHash: uploadRootHash(payload.byteLength, CHUNK, [hash]) });
      const download = await xfer.download({ file: main('README.md') }, { onChunk: () => {} });
      await download.done;

      // R7 / R8 the editor: Amy types (her lock, autosave), an agent is refused, she lets it go first, the agent edits.
      const appDoc = await DocClient.open(amy.conn, main('src/app.ts'));
      docs.push(appDoc);
      await waitUntil(() => appDoc.synced, 15_000, 'the editor');
      appDoc.text.insert(0, '// amy\n');
      await waitUntil(() => stack.daemon.ctx.services.locks.get(main('src/app.ts'))?.kind === 'human', 15_000, 'Amy\'s lock');
      await waitUntil(async () => (await readFile(join(stack.root, 'src', 'app.ts'), 'utf8')).startsWith('// amy'), 15_000, 'the autosave');
      const agent = stack.daemon.ctx.services.hooks.registerSession({ sessionId: 'ses_r11_agent', ownerUserId: carol.userId, agentName: 'Claude (Carol)', root: MAIN_ROOT });
      const appPath = join(stack.root, 'src', 'app.ts');
      expect((await runHook(agent.env, 'PreToolUse', appPath, stack.root)).stdout).toContain('Amy');
      await amy.conn.request('lock.release', { file: main('src/app.ts') });
      expect((await runHook(agent.env, 'PreToolUse', appPath, stack.root)).stdout.trim()).toBe('');
      await writeFile(appPath, '// amy\nexport const a = 2;\n');
      await runHook(agent.env, 'PostToolUse', appPath, stack.root);
      // R8 a write nobody announced (another program): external.change.
      await writeFile(join(stack.root, 'notes', 'keep.md'), 'changed by another program\n');
      // R8 conflict: Amy types in line one while another program rewrites that line.
      const conflictDoc = await DocClient.open(amy.conn, main('conflict.txt'));
      docs.push(conflictDoc);
      await waitUntil(() => conflictDoc.synced, 15_000, 'the second editor');
      conflictDoc.text.insert(4, ' (Amy)');
      await waitUntil(() => stack.daemon.ctx.services.locks.get(main('conflict.txt'))?.kind === 'human', 15_000, 'Amy\'s lock on conflict.txt');
      const conflicts = recorder(amy.conn, 'doc.conflict');
      await writeFile(join(stack.root, 'conflict.txt'), 'line ONE by a formatter\nline two\n');
      await waitUntil(() => conflicts.length > 0, 20_000, 'the conflict');
      await amy.conn.request('doc.conflict.resolve', { conflictId: (conflicts[0] as { conflict: { id: string } }).conflict.id, action: 'apply-agent-version' });
      // R8 the host frees a lock by force.
      conflictDoc.text.insert(0, '>');
      await waitUntil(() => stack.daemon.ctx.services.locks.get(main('conflict.txt'))?.kind === 'human', 15_000, 'Amy\'s lock again');
      await host.request('lock.forceRelease', { file: main('conflict.txt') });

      // R4 / R9 sessions and worktrees of an agent-access member.
      const { session: inWorktree } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree' }, cols: 80, rows: 24 });
      const worktreeId = (inWorktree.root as { worktreeId: string }).worktreeId;
      const wt = { kind: 'worktree' as const, worktreeId };
      await carol.conn.request('file.write', { file: { root: wt, path: 'feature.txt' }, content: bytes('feature\n') });
      const { request: first } = await carol.conn.request('worktree.merge.request', { worktreeId, message: 'feature' });
      await host.request('worktree.merge.approve', { requestId: first.id });
      await carol.conn.request('file.write', { file: { root: wt, path: 'second.txt' }, content: bytes('second\n') });
      const { request: second } = await carol.conn.request('worktree.merge.request', { worktreeId, message: 'second' });
      await host.request('worktree.merge.reject', { requestId: second.id, reason: '還不需要' });
      await carol.conn.request('session.end', { sessionId: inWorktree.id, keepWorktree: true });
      await carol.conn.request('worktree.remove', { worktreeId });
      const { session: toTerminate } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
      await host.request('admin.session.terminate', { sessionId: toTerminate.id });
      await waitUntil(async () => (await host.request('session.list', {})).sessions.every((s) => s.ownerUserId !== carol.userId || s.status === 'exited'), 10_000, 'Carol\'s sessions to end');
      // R4 a member leaves ("Leave"): the session they opened ends with them (§11 D-15).
      const { session: davesTerminal } = await dave.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
      await dave.conn.leave();
      await waitUntil(async () => (await host.request('session.list', {})).sessions.some((s) => s.id === davesTerminal.id && s.status === 'exited'), 5_000, 'Dave\'s session to end');
      expect((await host.request('session.list', {})).sessions.find((s) => s.id === davesTerminal.id)).toMatchObject({ status: 'exited', endReason: 'left' });

      // R6 suggestions for the host's own terminal.
      const { session: hostTerminal } = await host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
      const { suggestion: s1 } = await amy.conn.request('suggest.create', { sessionId: hostTerminal.id, text: 'echo one' });
      await amy.conn.request('suggest.edit', { suggestionId: s1.id, text: 'echo one, edited' });
      await amy.conn.request('suggest.withdraw', { suggestionId: s1.id });
      const { suggestion: s2 } = await amy.conn.request('suggest.create', { sessionId: hostTerminal.id, text: 'echo two' });
      await host.request('suggest.reject', { suggestionId: s2.id, reason: '不需要' });
      const { suggestion: s3 } = await amy.conn.request('suggest.create', { sessionId: hostTerminal.id, text: 'echo three' });
      await host.request('suggest.accept', { suggestionId: s3.id });

      // Every R4–R9 action of ARCHITECTURE §5.8, read from the console like the host does. (R5's own action went with
      // the guest sandbox, §11 D-15: its sessions are R4's.)
      const expected: readonly AuditAction[] = [
        'session.create', 'session.end', 'session.terminate', 'member.leave', // R4
        'suggest.create', 'suggest.edit', 'suggest.accept', 'suggest.reject', 'suggest.withdraw', // R6
        'file.write', 'file.create', 'file.rename', 'file.delete', 'file.upload', 'file.download', 'doc.edit', // R7
        'agent.edit', 'external.change', 'doc.conflict', 'doc.conflict-resolve', 'lock.acquire', 'lock.release', 'lock.denied', 'lock.force-release', // R8
        'worktree.create', 'worktree.remove', 'worktree.merge.request', 'worktree.merge.approve', 'worktree.merge.reject', // R9
      ];
      // The list is exactly the protocol's vocabulary minus what R4–R9 do not define (identity, authorization, path
      // refusals: R2 / R3; the console's own actions: R11): a new or removed action cannot slip past this test.
      const notR4toR9 = new Set<AuditAction>([
        'auth.join', 'auth.connect', 'auth.disconnect', 'auth.rejected', 'authz.denied', 'path.denied',
        'member.role', 'member.kick', 'invite.create', 'invite.revoke', 'device.revoke', 'settings.change',
      ]);
      expect([...expected].sort()).toEqual(AUDIT_ACTIONS.filter((action) => !notR4toR9.has(action)).sort());
      const logged = async (): Promise<Set<string>> => {
        const actions = new Set<string>();
        let before: number | undefined;
        for (let page = 0; page < 20; page++) {
          const { entries } = await host.request('admin.audit.query', { limit: 500, ...(before === undefined ? {} : { before }) });
          for (const entry of entries) actions.add(entry.action);
          if (entries.length < 500) break;
          before = entries[entries.length - 1]?.at;
        }
        return actions;
      };
      // doc.edit is written when the autosave is recorded (debounced), external.change when the watcher reports.
      await waitUntil(async () => {
        const actions = await logged();
        return expected.every((action) => actions.has(action));
      }, 20_000, 'every R4–R9 action in the audit log').catch(async (error: unknown) => {
        const actions = await logged();
        throw new Error(`${(error as Error).message}; missing: ${expected.filter((action) => !actions.has(action)).join(', ')}`);
      });

      // …each with the right actor and target, and R6.3's author, content, decision and time (action
      // names alone would pass a mis-attributed agent.edit or a suggestion without its text).
      const all: AuditEntry[] = [];
      let cursor: number | undefined;
      for (let page = 0; page < 20; page++) {
        const { entries } = await host.request('admin.audit.query', { limit: 500, ...(cursor === undefined ? {} : { before: cursor }) });
        all.push(...entries);
        if (entries.length < 500) break;
        cursor = entries[entries.length - 1]?.at;
      }
      const one = (action: string, target?: string, by?: 'user' | 'agent'): AuditEntry => {
        const found = all.find((e) => e.action === action && (target === undefined || e.target === target) && (by === undefined || e.actor.kind === by));
        expect(found, `${action} ${target ?? ''}`).toBeDefined();
        return found as AuditEntry;
      };
      const user = (userId: string) => ({ kind: 'user', userId });
      const hostUser = user(stack.host.userId);
      // The agent's Edit is recorded ONCE, by whichever report reaches the daemon first: its PostToolUse hook (a process
      // of its own: `via: 'hook'`, the tool) or the file watcher while the agent still holds the lock (`via: 'watcher'`,
      // the change); the later report is the same edit and is not recorded again (locks/activity.ts agentEditSeen).
      // Which one is first is timing: the hook on the development Mac and in the Linux VM, the watcher on the slower CI
      // runners (both OSes seen). The watcher names the change as the file system reported it: FSEvents may coalesce the
      // daemon's atomic autosave just before (a rename onto src/app.ts: a create) with the agent's in-place write into one
      // event flagged as a create ('add', macOS-15 runner, CI run 36831446139); inotify reports the write as a change.
      const [agentEdit, ...moreAgentEdits] = all.filter((e) => e.action === 'agent.edit' && e.target === 'main:src/app.ts');
      expect(moreAgentEdits).toEqual([]);
      expect(agentEdit).toMatchObject({ actor: { kind: 'agent', sessionId: 'ses_r11_agent', ownerUserId: carol.userId, displayName: 'Claude (Carol)' }, detail: { sessionId: 'ses_r11_agent', ownerUserId: carol.userId } });
      expect(agentEdit?.detail).toMatchObject(agentEdit?.detail?.['via'] === 'hook' ? { via: 'hook', tool: 'Edit' } : { via: 'watcher', change: expect.stringMatching(/^(change|add)$/) });
      expect(one('lock.denied', 'main:src/app.ts')).toMatchObject({ outcome: 'denied', actor: { kind: 'agent', sessionId: 'ses_r11_agent' }, detail: { holders: ['Amy'] } });
      expect(one('lock.acquire', 'main:src/app.ts', 'user')).toMatchObject({ actor: user(amy.userId), detail: { kind: 'human' } });
      expect(one('lock.acquire', 'main:src/app.ts', 'agent')).toMatchObject({ actor: { kind: 'agent', sessionId: 'ses_r11_agent' }, detail: { kind: 'agent' } });
      expect(one('lock.release', 'main:src/app.ts', 'user')).toMatchObject({ actor: user(amy.userId), detail: { reason: 'yield' } });
      expect(one('lock.release', 'main:src/app.ts', 'agent')).toMatchObject({ actor: { kind: 'agent', sessionId: 'ses_r11_agent' }, detail: { reason: 'released' } });
      expect(one('lock.force-release', 'main:conflict.txt')).toMatchObject({ actor: hostUser, detail: { holders: ['Amy'] } });
      expect(one('doc.edit', 'main:src/app.ts')).toMatchObject({ actor: user(amy.userId) });
      expect(one('external.change', 'main:notes/keep.md')).toMatchObject({ actor: { kind: 'system' } });
      expect(one('doc.conflict', 'main:conflict.txt')).toMatchObject({ detail: { hunks: 1 } });
      expect(one('doc.conflict-resolve', 'main:conflict.txt')).toMatchObject({ actor: user(amy.userId), detail: { action: 'apply-agent-version' } });
      expect(one('file.create', 'main:draft.txt')).toMatchObject({ actor: user(amy.userId) });
      expect(one('file.write', 'main:draft.txt')).toMatchObject({ actor: user(amy.userId) });
      expect(one('file.rename', 'main:final.txt')).toMatchObject({ actor: user(amy.userId), detail: { from: 'draft.txt', to: 'final.txt' } });
      expect(one('file.delete', 'main:final.txt')).toMatchObject({ actor: user(amy.userId) });
      expect(one('file.upload', 'main:upload.txt')).toMatchObject({ actor: user(amy.userId) });
      expect(one('file.download', 'main:README.md')).toMatchObject({ actor: user(amy.userId) });
      expect(one('session.end', inWorktree.id)).toMatchObject({ actor: user(carol.userId), detail: { keepWorktree: true } });
      expect(one('session.terminate', toTerminate.id)).toMatchObject({ actor: hostUser, detail: { ownerUserId: carol.userId } });
      expect(one('session.terminate', davesTerminal.id)).toMatchObject({ actor: { kind: 'system' }, detail: { ownerUserId: dave.userId, kind: 'terminal', reason: 'left' } });
      // Who opened each session; every session runs as the host, so there is no sandbox flag any more (§11 D-15).
      const hostCreate = one('session.create', hostTerminal.id);
      expect(hostCreate).toMatchObject({ actor: hostUser, detail: { sessionId: hostTerminal.id, kind: 'terminal', root: 'main' } });
      expect(hostCreate.detail).not.toHaveProperty('sandboxed');
      expect(one('session.create', inWorktree.id)).toMatchObject({ actor: user(carol.userId), detail: { kind: 'terminal', root: `wt:${worktreeId}`, worktreeId } });
      expect(one('member.leave', dave.userId)).toMatchObject({ actor: user(dave.userId) });
      expect(one('suggest.create', s3.id)).toMatchObject({ actor: user(amy.userId), detail: { authorUserId: amy.userId, text: 'echo three' } });
      expect(one('suggest.edit', s1.id)).toMatchObject({ actor: user(amy.userId), detail: { text: 'echo one, edited' } });
      expect(one('suggest.withdraw', s1.id)).toMatchObject({ actor: user(amy.userId), detail: { outcome: 'withdrawn' } });
      expect(one('suggest.reject', s2.id)).toMatchObject({ actor: hostUser, detail: { authorUserId: amy.userId, outcome: 'rejected', text: 'echo two', rejectReason: '不需要' } });
      const accepted = one('suggest.accept', s3.id);
      expect(accepted).toMatchObject({ actor: hostUser, detail: { authorUserId: amy.userId, authorName: 'Amy', outcome: 'accepted', finalText: 'echo three' } });
      expect(typeof accepted.at).toBe('number');
      expect(one('worktree.create', worktreeId)).toMatchObject({ actor: user(carol.userId) });
      expect(one('worktree.merge.request', first.id)).toMatchObject({ actor: user(carol.userId) });
      expect(one('worktree.merge.approve', first.id)).toMatchObject({ actor: hostUser });
      expect(one('worktree.merge.reject', second.id)).toMatchObject({ actor: hostUser });
      expect(one('worktree.remove', worktreeId)).toMatchObject({ actor: user(carol.userId) });
    } finally {
      for (const doc of docs) doc.destroy();
      await stack.stop();
      if (savedShell === undefined) delete process.env['SHELL'];
      else process.env['SHELL'] = savedShell;
    }
  }, 180_000);
});

/** `smurg hook` (the real CLI entry Claude Code runs) for one hook event of an agent session. */
function runHook(env: Readonly<Record<string, string>>, event: 'PreToolUse' | 'PostToolUse', filePath: string, cwd: string): Promise<{ stdout: string }> {
  const input = JSON.stringify({ session_id: 'r11', cwd, hook_event_name: event, tool_name: 'Edit', tool_input: { file_path: filePath }, tool_use_id: 'toolu_r11' });
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI_MAIN, 'hook'], { env: { PATH: '/usr/bin:/bin', SMURG_NO_BROWSER: '1', SMURG_LANG: 'en', ...env }, cwd, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve({ stdout })));
    child.stdin?.end(input);
  });
}

function recorder<T extends 'doc.conflict'>(conn: Connection, type: T): unknown[] {
  const seen: unknown[] = [];
  conn.on(type, (payload) => seen.push(payload));
  return seen;
}
