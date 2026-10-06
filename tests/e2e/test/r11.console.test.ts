// SPEC R11 acceptance (host console and audit log), prototype scope, through the same encrypted admin requests the
// web console sends. The console UI itself ("one click") is covered by the browser tests in apps/web/e2e.
//  - the host can terminate any session or remove any member from the console with one click
//  - every event R4–R9 define appears in the audit log: ONE scenario through the real relay produces every action of
//    the protocol's audit vocabulary (AUDIT_ACTIONS) but the identity and console ones, and the host reads them back
//    from the console. Since protocol 4 that scenario drives agent sessions, a topic, its plan and its reports: the
//    agents are the scripted stand-in for Claude Code (`startStack({ claude })`), never a `claude` of this computer.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isStubService } from '@smurg/daemon';
import type { FakeClaudeScenario, FakeClaudeStep } from '@smurg/daemon/testing';
import { AUDIT_ACTIONS, MAIN_ROOT, type AuditAction, type AuditEntry } from '@smurg/protocol';
import { uploadRootHash, type Connection } from '@smurg/protocol/client';
import { startLocalRelay, type LocalRelay } from '@smurg/relay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The daemon's test Yjs client (a provider over doc.* with per-docId buffering): test-only relative import.
import { DocClient } from '../../../packages/daemon/test/docs/helpers.ts';
import { itemOf, member, permissionAt, planIs, questionAt, sessionReady, statusIs, suggestionAt, topicIs, turnsFinished, type Member } from '../src/flow.ts';
import { CLI_MAIN, startStack, waitUntil, type Stack } from '../src/harness.ts';

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
      // No disk reserve: the upload must not depend on this machine's free space. As many agents at once as the story
      // has (the default follows the machine's memory).
      settings: { diskReserveBytes: 0, diskReservePercent: 0, maxLiveAgents: 8 },
      // Agent sessions run the stand-in for Claude Code with the real `smurg hook` / `smurg mcp`.
      claude: agentScenario(RECEIPT_GOES_ON),
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

      // Protocol 4: agent sessions, questions, permission requests, suggestions, a topic with its plan and reports,
      // a restart of the host's smurg and a crashed agent in between (first: the folder is still as git has it).
      const p4 = await agentSessionsAndATopic(stack, { host: member(stack.hostClient, 'Host', 'host'), carol: member(carol, 'Carol', 'agent'), amy: member(amy, 'Amy', 'editor'), dave: member(dave, 'Dave', 'agent') });

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
      const agent = stack.daemon.ctx.services.hooks.registerSession({ sessionId: 'ses_r11_agent', ownerUserId: carol.userId, agentName: 'Claude (Carol)', root: MAIN_ROOT, purpose: 'free', pathRights: 'member', tools: ['Read', 'Edit', 'Write', 'Bash'] });
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
      await waitUntil(async () => (await host.request('session.list', {})).sessions.every((s) => s.openedBy.userId !== carol.userId || s.status === 'exited'), 10_000, 'Carol\'s sessions to end');
      // R4 a member leaves ("Leave"): the session they opened ends with them (§11 D-15).
      const { session: davesTerminal } = await dave.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
      await dave.conn.leave();
      await waitUntil(async () => (await host.request('session.list', {})).sessions.some((s) => s.id === davesTerminal.id && s.status === 'exited'), 5_000, 'Dave\'s session to end');
      expect((await host.request('session.list', {})).sessions.find((s) => s.id === davesTerminal.id)).toMatchObject({ status: 'exited', endReason: 'left' });

      const { session: hostTerminal } = await host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
      // R6 suggestions: protocol 4 sends them to AGENT sessions only (a terminal takes none).
      await expect(amy.conn.request('suggest.create', { sessionId: hostTerminal.id, text: 'echo one' })).rejects.toMatchObject({ code: 'bad_request' });
      const suggested = p4.suggested;

      // Every R4–R9 action of ARCHITECTURE §5.8, read from the console like the host does. (R5's own action went with
      // the guest sandbox, §11 D-15: its sessions are R4's.)
      const SUGGEST_ACTIONS: readonly AuditAction[] = ['suggest.create', 'suggest.edit', 'suggest.accept', 'suggest.reject', 'suggest.withdraw']; // R6
      // What protocol 4 added for agent sessions, questions, permission requests, topics, plans and reports.
      const AGENT_ACTIONS: readonly AuditAction[] = [
        'session.message', 'smurg.message', 'session.interrupt', 'session.retry', 'session.restart', 'session.responsible', 'session.mode', 'session.rule.remove', 'session.handover', 'responsible.fallback',
        'question.submit', 'question.remind', 'permission.decide', 'permission.auto', 'permission.auto-deny', 'agent.command',
        'topic.create', 'topic.rename', 'topic.archive', 'topic.delete', 'topic.discussion.restart', 'topic.spec.request', 'topic.rule.add', 'topic.rule.remove',
        'plan.generate', 'plan.start', 'plan.resume', 'plan.assign', 'plan.mode', 'plan.item.retry', 'plan.item.continue', 'plan.item.resolve', 'scheduler.start', 'scheduler.disarm',
        'report.register', 'report.review', 'spec.commit',
      ];
      const expected: readonly AuditAction[] = [
        'session.create', 'session.end', 'session.terminate', 'member.leave', // R4
        ...SUGGEST_ACTIONS,
        'file.write', 'file.create', 'file.rename', 'file.delete', 'file.upload', 'file.download', 'doc.edit', // R7
        'agent.edit', 'external.change', 'doc.conflict', 'doc.conflict-resolve', 'lock.acquire', 'lock.release', 'lock.denied', 'lock.force-release', // R8
        'worktree.create', 'worktree.remove', 'worktree.merge.request', 'worktree.merge.approve', 'worktree.merge.reject', // R9
        ...AGENT_ACTIONS,
      ];
      // The list is exactly the protocol's vocabulary minus what R4–R9 do not define (identity, authorization, path
      // refusals: R2 / R3; the console's own actions: R11): a new or removed action cannot slip past this test.
      const notR4toR9 = new Set<AuditAction>([
        'auth.join', 'auth.connect', 'auth.disconnect', 'auth.rejected', 'authz.denied', 'path.denied',
        'member.role', 'member.kick', 'invite.create', 'invite.revoke', 'device.revoke', 'settings.change', 'claude-config.decide', 'transcript.redact',
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
      expect(one('session.terminate', toTerminate.id)).toMatchObject({ actor: hostUser, detail: { openedBy: carol.userId } });
      expect(one('session.terminate', davesTerminal.id)).toMatchObject({ actor: { kind: 'system' }, detail: { openedBy: dave.userId, kind: 'terminal', reason: 'left' } });
      // Who opened each session; every session runs as the host, so there is no sandbox flag any more (§11 D-15).
      const hostCreate = one('session.create', hostTerminal.id);
      expect(hostCreate).toMatchObject({ actor: hostUser, detail: { sessionId: hostTerminal.id, kind: 'terminal', root: 'main' } });
      expect(hostCreate.detail).not.toHaveProperty('sandboxed');
      expect(one('session.create', inWorktree.id)).toMatchObject({ actor: user(carol.userId), detail: { kind: 'terminal', root: `wt:${worktreeId}`, worktreeId } });
      expect(one('member.leave', dave.userId)).toMatchObject({ actor: user(dave.userId) });
      // R6.3: the suggestion entries carry the author, the text, the decision and the time.
      expect(one('suggest.create', suggested.s3)).toMatchObject({ actor: user(amy.userId), detail: { authorUserId: amy.userId, text: 'Please run the third check.' } });
      expect(one('suggest.edit', suggested.s1)).toMatchObject({ actor: user(amy.userId), detail: { text: 'Please run the first check, edited.' } });
      expect(one('suggest.withdraw', suggested.s1)).toMatchObject({ actor: user(amy.userId), detail: { outcome: 'withdrawn' } });
      expect(one('suggest.reject', suggested.s2)).toMatchObject({ actor: hostUser, detail: { authorUserId: amy.userId, outcome: 'rejected', text: 'Please run the second check.', rejectReason: '不需要' } });
      const accepted = one('suggest.accept', suggested.s3);
      expect(accepted).toMatchObject({ actor: hostUser, detail: { authorUserId: amy.userId, authorName: 'Amy', outcome: 'accepted', finalText: 'Please run the third check.' } });
      expect(typeof accepted.at).toBe('number');
      expect(one('worktree.create', worktreeId)).toMatchObject({ actor: user(carol.userId) });
      expect(one('worktree.merge.request', first.id)).toMatchObject({ actor: user(carol.userId) });
      expect(one('worktree.merge.approve', first.id)).toMatchObject({ actor: hostUser });
      expect(one('worktree.merge.reject', second.id)).toMatchObject({ actor: hostUser });
      expect(one('worktree.remove', worktreeId)).toMatchObject({ actor: user(carol.userId) });

      // Protocol 4's actions, each by who did it and on what: a member, the host, smurg itself, or the agent under its
      // session's name.
      const carolUser = user(carol.userId);
      const system = { kind: 'system' };
      const { topicId, free, discussion, cart, page, receipt } = p4;
      expect(one('session.create', free)).toMatchObject({ actor: hostUser, detail: { kind: 'agent' } });
      expect(one('session.message', free)).toMatchObject({ outcome: 'ok', detail: { sessionId: free } });
      expect(all.filter((e) => e.action === 'session.message' && e.target === free).map((e) => (e.actor.kind === 'user' ? e.actor.userId : e.actor.kind)).reverse()).toEqual([carol.userId, carol.userId, amy.userId]);
      expect(one('session.interrupt', free)).toMatchObject({ actor: carolUser });
      expect(one('session.restart', free)).toMatchObject({ actor: carolUser });
      expect(one('session.mode', free)).toMatchObject({ actor: carolUser, detail: { mode: 'ask-commands' } });
      expect(one('session.rule.remove', free)).toMatchObject({ actor: carolUser, detail: { rule: 'Bash(pnpm test *)' } });
      expect(one('session.responsible', free)).toMatchObject({ actor: hostUser, detail: { responsible: dave.userId } });
      // Dave left: who decides in the session he was responsible for falls back, and the log says what went with him.
      expect(one('responsible.fallback', free)).toMatchObject({ actor: system, detail: { from: dave.userId, reason: 'left' } });
      expect(one('session.handover', dave.userId)).toMatchObject({ actor: system, detail: { from: dave.userId, to: stack.host.userId, reason: 'left', cleared: [free] } });
      expect(one('permission.decide', p4.requests.session)).toMatchObject({ actor: carolUser, detail: { decision: 'allow-always', command: 'pnpm test', rule: 'Bash(pnpm test *)' } });
      expect(one('permission.decide', p4.requests.topic)).toMatchObject({ actor: carolUser, detail: { decision: 'allow-always', command: 'pnpm test' } });
      expect(one('permission.auto', receipt)).toMatchObject({ actor: system, detail: { sessionId: receipt, tool: 'Bash', answer: 'topic-rule', topicId, rule: 'Bash(pnpm test *)' } });
      expect(one('permission.auto-deny', discussion)).toMatchObject({ outcome: 'denied', detail: { sessionId: discussion, row: 'G2', tools: ['Bash'] } });
      expect(one('agent.command', cart)).toMatchObject({ actor: { kind: 'agent', sessionId: cart, ownerUserId: carol.userId, displayName: 'Claude (Cart API)' }, detail: { verb: 'run', command: 'pnpm test' } });
      expect(one('question.remind', p4.question)).toMatchObject({ actor: hostUser, detail: { sessionId: discussion } });
      expect(one('question.submit', p4.question)).toMatchObject({ actor: carolUser, detail: { questionId: p4.question, answers: ['0'] } });
      expect(all.filter((e) => e.action === 'smurg.message').map((e) => String(e.detail?.['purpose']))).toEqual(expect.arrayContaining(['write-spec', 'generate-plan', 'start-item', 'nudge-report', 'continue-item', 'resolve-conflict', 'restart-discussion']));
      for (const entry of all.filter((e) => e.action === 'smurg.message')) expect(entry.actor).toEqual(system);
      expect(one('topic.create', topicId)).toMatchObject({ actor: carolUser, detail: { slug: 'checkout', name: 'Checkout' } });
      expect(one('topic.spec.request', topicId)).toMatchObject({ actor: carolUser, detail: { sessionId: discussion } });
      expect(one('plan.generate', topicId)).toMatchObject({ actor: carolUser });
      expect(one('plan.mode', topicId)).toMatchObject({ actor: carolUser, detail: { mode: 'everyone' } });
      expect(one('plan.assign', topicId)).toMatchObject({ actor: carolUser });
      expect(all.filter((e) => e.action === 'plan.start').map((e) => `${e.actor.kind === 'user' ? e.actor.userId : e.actor.kind} ${JSON.stringify(e.detail?.['itemIds'])}`).reverse()).toEqual([`${carol.userId} ["cart-api","checkout-page","receipt-email"]`, `${carol.userId} ["checkout-page"]`]);
      expect(all.filter((e) => e.action === 'spec.commit').map((e) => `${e.outcome} ${e.actor.kind === 'user' ? e.actor.userId : e.actor.kind}`)).toEqual([`ok ${carol.userId}`, `ok ${carol.userId}`]);
      expect(all.filter((e) => e.action === 'scheduler.start').map((e) => `${String(e.detail?.['itemId'])} ${String(e.detail?.['sessionId'])} by ${String(e.detail?.['startedBy'])}`).reverse()).toEqual([`cart-api ${cart} by ${carol.userId}`, `receipt-email ${receipt} by ${carol.userId}`, `checkout-page ${page} by ${carol.userId}`]);
      expect(one('scheduler.disarm', topicId)).toMatchObject({ detail: { itemId: 'checkout-page', reason: 'plan-changed', startedBy: carol.userId } });
      expect(one('plan.item.continue', topicId)).toMatchObject({ actor: hostUser, detail: { itemId: 'receipt-email' } });
      expect(one('plan.resume', topicId)).toMatchObject({ actor: carolUser, detail: { itemIds: ['checkout-page'] } });
      expect(one('session.retry', page)).toMatchObject({ actor: carolUser });
      expect(one('plan.item.retry', topicId)).toMatchObject({ actor: carolUser, detail: { itemId: 'checkout-page', was: 'failed' } });
      expect(one('plan.item.resolve', topicId)).toMatchObject({ actor: carolUser, detail: { itemId: 'receipt-email', sessionId: receipt, conflicted: 1 } });
      expect(all.filter((e) => e.action === 'report.register').map((e) => `${String(e.detail?.['itemId'])} v${String(e.detail?.['version'])}`).reverse()).toEqual(['cart-api v1', 'receipt-email v1', 'checkout-page v1', 'receipt-email v2']);
      expect(all.filter((e) => e.action === 'report.review').map((e) => `${e.actor.kind === 'user' ? e.actor.userId : e.actor.kind} ${String(e.detail?.['itemId'])} v${String(e.detail?.['version'])}`).reverse()).toEqual([`${carol.userId} cart-api v1`, `${carol.userId} checkout-page v1`, `${stack.host.userId} receipt-email v1`, `${stack.host.userId} receipt-email v2`]);
      expect(all.filter((e) => e.action === 'topic.rule.add').map((e) => `${e.actor.kind === 'user' ? e.actor.userId : e.actor.kind} ${String(e.detail?.['rule'])}`).reverse()).toEqual([`${carol.userId} Bash(pnpm test *)`, `${carol.userId} Bash(pnpm lint *)`]);
      expect(one('topic.rule.remove', topicId)).toMatchObject({ actor: carolUser, detail: { rule: 'Bash(pnpm lint *)', addedBy: carol.userId } });
      expect(one('session.terminate', discussion)).toMatchObject({ actor: hostUser });
      expect(one('topic.discussion.restart', topicId)).toMatchObject({ actor: carolUser, detail: { sessionId: p4.secondDiscussion, replaced: discussion } });
      expect(one('topic.rename', topicId)).toMatchObject({ actor: carolUser, detail: { name: 'Checkout on one page' } });
      expect(one('topic.archive', topicId)).toMatchObject({ actor: carolUser });
      expect(one('topic.delete', topicId)).toMatchObject({ actor: hostUser, detail: { name: 'Checkout on one page', sessions: 5 } });
    } finally {
      for (const doc of docs) doc.destroy();
      await stack.stop();
      if (savedShell === undefined) delete process.env['SHELL'];
      else process.env['SHELL'] = savedShell;
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Protocol 4's part of the scenario: what the stand-in "model" does, and the story that drives it
// ---------------------------------------------------------------------------------------------------------------------

const SPEC_PATH = 'specs/checkout/SPEC.md';
const PLAN_PATH = 'specs/checkout/PLAN.md';
const TITLE_PATH = 'src/shared/title.ts';
const reportPath = (itemId: string): string => `specs/checkout/reports/${itemId}.md`;
const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Open questions', 'None.', ''].join('\n');
const PLAN = [
  '# Plan: Checkout',
  '',
  '<!-- smurg:plan v1 -->',
  '',
  '### 1. Cart API',
  '- id: cart-api',
  '',
  'Compute the total in one module.',
  '',
  '### 2. Checkout page',
  '- id: checkout-page',
  '- depends on: cart-api',
  '',
  'Put cart and payment on one page.',
  '',
  '### 3. Receipt email',
  '- id: receipt-email',
  '',
  'Send a receipt after the payment.',
  '',
  '<!-- smurg:plan end -->',
  '',
].join('\n');
function report(itemId: string, title: string, extra = ''): string {
  return [`# Result report: ${title}`, '', `<!-- smurg:report v1 item=${itemId} -->`, '- outcome: complete', '', '## What was done', `The work of ${title}.${extra}`, '', '## Why it was done this way', 'As the spec decided.', '', '## How it was verified', '- [x] `pnpm test`: 3 tests passed', '', '## What to watch out for', 'Nothing special.', ''].join('\n');
}
const reportSteps = (itemId: string, title: string, extra = ''): FakeClaudeStep[] => [{ tool: 'Write', input: { file_path: reportPath(itemId), content: report(itemId, title, extra) } }, { tool: 'mcp__smurg__check_report', input: {} }, { text: `${title} is done.` }];
const PAYMENT = { question: 'How do people pay?', header: 'Payment', multiSelect: false, options: [{ label: 'Cards only', description: 'One provider.' }, { label: 'Cards and invoices', description: 'More work.' }] };
const PNPM_TEST: FakeClaudeStep = { tool: 'Bash', input: { command: 'pnpm test' }, suggest: { toolName: 'Bash', ruleContent: 'pnpm test *' }, result: '3 tests passed' };
const PNPM_BUILD: FakeClaudeStep = { tool: 'Bash', input: { command: 'pnpm build' } };

/** `onContinue`: what a work item's session does when smurg tells it to go on (the story swaps it between its phases). */
function agentScenario(onContinue: FakeClaudeStep[]): FakeClaudeScenario {
  return {
    turns: [
      // ---- a session without a topic
      { match: 'run the tests', steps: [PNPM_TEST, { text: 'The tests pass.' }] },
      { match: 'clean up', steps: [{ tool: 'Bash', input: { command: 'rm -rf build' } }, { text: 'never said' }] },
      // ---- the discussion: a question, a command it may not run (refused by the tool gate), the spec; the plan
      { match: 'one page', once: true, steps: [{ tool: 'AskUserQuestion', input: { questions: [PAYMENT] } }, { tool: 'Bash', input: { command: 'ls' }, run: true }, { tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } }, { text: 'The first draft of the spec is ready.' }] },
      { match: 'Then call check_plan', steps: [{ tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'The plan has three work items.' }] },
      // ---- work item 1 asks before its command; work item 3 writes the same file otherwise and stops without a report
      { match: 'Start work item 1 ', steps: [{ tool: 'Write', input: { file_path: 'src/cart/total.ts', content: 'export const total = 1;\n' } }, { tool: 'Write', input: { file_path: TITLE_PATH, content: 'export const title = "cart";\n' } }, PNPM_TEST, ...reportSteps('cart-api', 'Cart API')] },
      { match: 'Start work item 3 ', steps: [{ tool: 'Write', input: { file_path: TITLE_PATH, content: 'export const title = "receipt";\n' } }, { text: 'I wrote the title.' }] },
      { match: 'You stopped without the result report', steps: [{ text: 'I am not sure what is missing.' }] },
      // ---- work item 2 (after 1 is merged) wants a command nobody always allowed, and waits for a person
      { match: 'Start work item 2 ', steps: [{ tool: 'Write', input: { file_path: 'src/checkout/page.ts', content: 'export const page = 1;\n' } }, PNPM_BUILD, { text: 'never said' }] },
      { match: 'Continue the work item', steps: onContinue },
      { match: 'conflict markers', steps: [{ tool: 'Write', input: { file_path: TITLE_PATH, content: 'export const title = "cart and receipt";\n' } }, ...reportSteps('receipt-email', 'Receipt email', ' The title names both now.')] },
      { steps: [{ text: 'ok' }] },
    ],
  };
}
const RECEIPT_GOES_ON: FakeClaudeStep[] = [PNPM_TEST, ...reportSteps('receipt-email', 'Receipt email')];
const PAGE_ASKS_AGAIN: FakeClaudeStep[] = [PNPM_BUILD, { text: 'never said' }];
const PAGE_GOES_ON: FakeClaudeStep[] = reportSteps('checkout-page', 'Checkout page');

interface AgentPart {
  readonly topicId: string;
  /** The host's session without a topic, and the sessions of the topic. */
  readonly free: string;
  readonly discussion: string;
  readonly secondDiscussion: string;
  readonly cart: string;
  readonly page: string;
  readonly receipt: string;
  readonly question: string;
  /** The permission requests Carol always allowed: for the session, for the topic. */
  readonly requests: { readonly session: string; readonly topic: string };
  readonly suggested: { readonly s1: string; readonly s2: string; readonly s3: string };
}

/**
 * Every audit action protocol 4 added, produced the way people produce it (requests of the client SDK through the
 * relay; the agents are the stand-in): a session without a topic (messages, a rule for the session, the mode, a
 * stopped turn, a restart of its agent, who is responsible, an Editor's three suggestions), then a topic from its
 * discussion to its deletion (a question with a reminder, the spec, the plan, Start, a rule for the topic, an item that
 * stops without a report, an item disarmed by an edit of the spec, reports and reviews, merges, a conflict), with a
 * restart of the host's smurg ("Continue all") and a crashed agent ("Try again") on the way.
 */
async function agentSessionsAndATopic(stack: Stack, people: { host: Member; carol: Member; amy: Member; dave: Member }): Promise<AgentPart> {
  const { host, carol, amy, dave } = people;
  const everyone = [host, carol, amy, dave];
  const claude = stack.claude;
  if (claude === undefined) throw new Error('this scenario needs the stand-in claude');
  const bytes = (text: string) => new TextEncoder().encode(text);

  // ==== a session without a topic, opened by the host =================================================================
  const { session: free } = await host.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'Tests' });
  await sessionReady(host, free.id);
  for (const one of everyone) await one.watch(free.id);
  // A message; its command asks; "always allow this kind in this session"; the rule is removed again.
  await carol.conn.request('session.message.send', { sessionId: free.id, text: 'Please run the tests.' });
  const forSession = await permissionAt(host, (request) => request.sessionId === free.id && request.status === 'open', 'the command of the free session');
  await carol.conn.request('permission.decide', { requestId: forSession.id, decision: 'allow-always', scope: 'session' });
  await turnsFinished(host, free.id, 1);
  await statusIs(host, free.id, 'idle');
  const [rule] = (await carol.conn.request('session.rules.get', { sessionId: free.id })).rules;
  await carol.conn.request('session.rule.remove', { sessionId: free.id, ruleId: rule?.id ?? '' });
  await carol.conn.request('session.mode.set', { sessionId: free.id, mode: 'ask-commands' });
  // A turn that waits for a person is stopped; the session's agent is started again; Dave is made responsible.
  await carol.conn.request('session.message.send', { sessionId: free.id, text: 'Please clean up.' });
  await permissionAt(host, (request) => request.sessionId === free.id && request.status === 'open', 'the request of the turn that is stopped');
  await carol.conn.request('session.interrupt', { sessionId: free.id });
  await turnsFinished(host, free.id, 2);
  await statusIs(host, free.id, 'idle');
  await carol.conn.request('session.restart', { sessionId: free.id });
  // R6: an Editor's message is a suggestion: edited and withdrawn by her, rejected, accepted (only then a message).
  const { suggestion: s1 } = await amy.conn.request('suggest.create', { sessionId: free.id, text: 'Please run the first check.' });
  await amy.conn.request('suggest.edit', { suggestionId: s1.id, text: 'Please run the first check, edited.' });
  await amy.conn.request('suggest.withdraw', { suggestionId: s1.id });
  const { suggestion: s2 } = await amy.conn.request('suggest.create', { sessionId: free.id, text: 'Please run the second check.' });
  await host.conn.request('suggest.reject', { suggestionId: s2.id, reason: '不需要' });
  const { suggestion: s3 } = await amy.conn.request('suggest.create', { sessionId: free.id, text: 'Please run the third check.' });
  await host.conn.request('suggest.accept', { suggestionId: s3.id });
  await suggestionAt(dave, (held) => held.id === s3.id && held.status === 'accepted', 'the accepted suggestion');
  await turnsFinished(host, free.id, 3);
  await statusIs(host, free.id, 'idle');
  await host.conn.request('session.responsible.set', { sessionId: free.id, userId: dave.userId });

  // ==== a topic: the discussion, a question with a reminder, the spec, the plan =======================================
  const created = await carol.conn.request('topic.create', { name: 'Checkout', firstMessage: 'We want the checkout on one page.' });
  const topicId = created.topic.id;
  const discussion = created.session.id;
  for (const one of everyone) await one.watch(discussion);
  const question = await questionAt(host, (held) => held.sessionId === discussion && held.status === 'open', 'the question of the discussion');
  await host.conn.request('question.remind', { questionId: question.id });
  await carol.conn.request('question.submit', { questionId: question.id, answers: [{ options: [0] }] });
  await turnsFinished(host, discussion, 1);
  await statusIs(host, discussion, 'idle');
  await topicIs(host, topicId, (topic) => topic.phase === 'spec', 'the first draft');
  await carol.conn.request('topic.spec.request', { topicId });
  await turnsFinished(host, discussion, 2);
  await statusIs(host, discussion, 'idle');
  await carol.conn.request('plan.generate', { topicId });
  await turnsFinished(host, discussion, 3);
  await statusIs(host, discussion, 'idle');
  await planIs(host, topicId, (plan) => plan.items.length === 3, 'the plan');
  await carol.conn.request('plan.mode.set', { topicId, mode: 'everyone' });
  await carol.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: carol.userId });
  await carol.conn.request('plan.assign', { topicId, itemId: 'checkout-page', userId: carol.userId });
  await carol.conn.request('plan.assign', { topicId, itemId: 'receipt-email', userId: host.userId });

  // ==== Start: two items run, one waits; a rule for the topic; an item that stops without a report ======================
  const first = (await carol.conn.request('plan.preflight', { topicId })).preflight;
  expect(first).toMatchObject({ startsNow: ['cart-api', 'receipt-email'], blockers: [] });
  const started = (await carol.conn.request('plan.start', { topicId, planRevision: first.planRevision, specHash: first.specHash, planHash: first.planHash })).plan;
  const cart = itemOf(started, 'cart-api')?.sessionId as string;
  const receipt = itemOf(started, 'receipt-email')?.sessionId as string;
  for (const one of everyone) for (const id of [cart, receipt]) await one.watch(id);
  const forTopic = await permissionAt(host, (request) => request.sessionId === cart && request.status === 'open', 'the command of work item 1');
  await carol.conn.request('permission.decide', { requestId: forTopic.id, decision: 'allow-always', scope: 'topic' });
  await topicIs(host, topicId, (topic) => topic.rules.length === 1, "the topic's rule");
  await planIs(host, topicId, (plan) => itemOf(plan, 'cart-api')?.report?.state === 'to-review', 'the report of work item 1');
  // Work item 3 was nudged once and needs its responsible person; told to go on, its command is the topic's kind:
  // smurg answers the request itself (the session ran before the rule existed).
  await planIs(host, topicId, (plan) => itemOf(plan, 'receipt-email')?.state === 'stalled', 'work item 3 stalled');
  await host.conn.request('plan.item.continue', { topicId, itemId: 'receipt-email' });
  await planIs(host, topicId, (plan) => itemOf(plan, 'receipt-email')?.report?.state === 'to-review', 'the report of work item 3');

  // ==== an Editor edits the spec: the item that waited is disarmed; Carol starts it again =============================
  await amy.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes(SPEC.replace('one page.', 'one page. Gift cards are out of scope.')) });
  await planIs(host, topicId, (plan) => itemOf(plan, 'checkout-page')?.disarmed === 'plan-changed', 'the disarmed item');
  const again = (await carol.conn.request('plan.preflight', { topicId, itemIds: ['checkout-page'] })).preflight;
  await carol.conn.request('plan.start', { topicId, itemIds: ['checkout-page'], planRevision: again.planRevision, specHash: again.specHash, planHash: again.planHash });

  // ==== review and merge of work item 1: work item 2 starts by itself and waits for a person ==========================
  await carol.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });
  const cartDraft = (await host.conn.request('report.get', { topicId, itemId: 'cart-api' })).report.changes?.requestId as string;
  await waitUntil(async () => (await host.inbox()).some((item) => item.key === `merge:${cartDraft}` && item.ready === true), 20_000, 'the reviewed change in the host\'s inbox');
  expect((await host.conn.request('worktree.merge.approve', { requestId: cartDraft })).request).toMatchObject({ status: 'merged' });
  const running = await planIs(host, topicId, (plan) => itemOf(plan, 'checkout-page')?.sessionId !== undefined, 'work item 2 started');
  const page = itemOf(running, 'checkout-page')?.sessionId as string;
  for (const one of everyone) await one.watch(page);
  await permissionAt(host, (request) => request.sessionId === page && request.status === 'open', 'the command of work item 2');

  // ==== the host's smurg stops and starts again: the plan is paused until "Continue all" ===============================
  await claude.setScenario(agentScenario(PAGE_ASKS_AGAIN));
  await stack.restartDaemon();
  for (const one of everyone) await one.client.waitFor((state) => state.kind === 'online', 30_000);
  for (const one of everyone) await one.sync();
  expect(host.topic(topicId)?.plan.paused).toBe(true);
  await carol.conn.request('plan.resume', { topicId });
  const askedAgain = await permissionAt(host, (request) => request.sessionId === page && request.status === 'open', 'the command of work item 2, asked again');

  // ==== its agent crashes while it waits: "Try again" in the session continues the item ================================
  await claude.setScenario(agentScenario(PAGE_GOES_ON));
  expect(await stack.killAgentOf(page)).toBe(1);
  await statusIs(host, page, 'failed');
  await permissionAt(host, (request) => request.id === askedAgain.id && request.status === 'withdrawn', 'the withdrawn request');
  await planIs(host, topicId, (plan) => itemOf(plan, 'checkout-page')?.state === 'failed', 'the failed item');
  await carol.conn.request('session.retry', { sessionId: page });
  await planIs(host, topicId, (plan) => itemOf(plan, 'checkout-page')?.report?.state === 'to-review', 'the report of work item 2');
  await carol.conn.request('report.review', { topicId, itemId: 'checkout-page', version: 1 });
  const pageDraft = (await host.conn.request('report.get', { topicId, itemId: 'checkout-page' })).report.changes?.requestId as string;
  await waitUntil(async () => (await host.inbox()).some((item) => item.key === `merge:${pageDraft}` && item.ready === true), 20_000, 'the change of work item 2 in the host\'s inbox');
  expect((await host.conn.request('worktree.merge.approve', { requestId: pageDraft })).request).toMatchObject({ status: 'merged' });

  // ==== work item 3 conflicts with what work item 1 merged: the agent resolves, a new report ==========================
  await host.conn.request('report.review', { topicId, itemId: 'receipt-email', version: 1 });
  const receiptDraft = (await host.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report.changes?.requestId as string;
  expect((await host.conn.request('worktree.merge.approve', { requestId: receiptDraft })).request).toMatchObject({ status: 'conflict', conflictFiles: [TITLE_PATH] });
  await carol.conn.request('plan.item.resolve', { topicId, itemId: 'receipt-email' });
  await planIs(host, topicId, (plan) => itemOf(plan, 'receipt-email')?.report?.version === 2, 'the report after the conflict was resolved');
  await host.conn.request('report.review', { topicId, itemId: 'receipt-email', version: 2 });
  const resolvedDraft = (await host.conn.request('report.get', { topicId, itemId: 'receipt-email' })).report.changes?.requestId as string;
  await waitUntil(async () => (await host.inbox()).some((item) => item.key === `merge:${resolvedDraft}` && item.ready === true), 20_000, 'the resolved change in the host\'s inbox');
  expect((await host.conn.request('worktree.merge.approve', { requestId: resolvedDraft })).request).toMatchObject({ status: 'merged' });
  await topicIs(host, topicId, (topic) => topic.phase === 'complete', 'the complete topic');
  expect(await readFile(join(stack.root, TITLE_PATH), 'utf8')).toBe('export const title = "cart and receipt";\n');

  // ==== the topic's rules by hand; a lost discussion restarted; rename, archive, delete ===============================
  const withLint = (await carol.conn.request('topic.rule.add', { topicId, tool: 'Bash', pattern: 'pnpm lint *' })).topic;
  await carol.conn.request('topic.rule.remove', { topicId, ruleId: withLint.rules.find((held) => held.pattern === 'pnpm lint *')?.id ?? '' });
  await host.conn.request('admin.session.terminate', { sessionId: discussion });
  await topicIs(host, topicId, (topic) => topic.discussion === 'lost', 'the lost discussion');
  const restarted = await carol.conn.request('topic.discussion.restart', { topicId });
  await host.watch(restarted.session.id);
  await turnsFinished(host, restarted.session.id, 1);
  await statusIs(host, restarted.session.id, 'idle');
  await carol.conn.request('topic.rename', { topicId, name: 'Checkout on one page' });
  await carol.conn.request('topic.archive', { topicId, archived: true });
  await topicIs(host, topicId, (topic) => topic.archived, 'the archived topic');
  await host.conn.request('topic.delete', { topicId });
  await waitUntil(() => host.topic(topicId) === undefined, 10_000, 'the deleted topic');
  // Nothing the story started is left running but the session without a topic.
  await waitUntil(async () => (await stack.agentProcesses()).length <= 1, 20_000, 'the agent processes of the deleted topic to be gone');

  return { topicId, free: free.id, discussion, secondDiscussion: restarted.session.id, cart, page, receipt, question: question.id, requests: { session: forSession.id, topic: forTopic.id }, suggested: { s1: s1.id, s2: s2.id, s3: s3.id } };
}

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
