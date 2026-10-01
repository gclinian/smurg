// R9.4 with real PTY sessions (the sessions module, real /bin/sh): a session in "my worktree" runs inside the
// worktree; ending it with keepWorktree keeps the worktree, and a later session of its owner continues in it.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputCollector, testSessionsModule, typeInto, waitUntil, type TestSessions } from '../suggest/session-support.ts';
import { settleError, startWorktreeStack, type WorktreeStack } from './support.ts';

let stack: WorktreeStack | null = null;
let sessions: TestSessions | null = null;

afterEach(async () => {
  await stack?.cleanup();
  stack = null;
  await sessions?.cleanup();
  sessions = null;
}, 60_000);

describe('R9.4 keep a worktree and continue in it', { timeout: 60_000 }, () => {
  it('R9.4 session 結束時詢問是否保留 worktree；保留的 worktree 之後可以重新開 session 繼續', async () => {
    sessions = await testSessionsModule();
    stack = await startWorktreeStack({ laterModules: [sessions.module] });
    const s = stack;
    const host = s.host;

    const { session } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree' }, cols: 100, rows: 30 });
    expect(session.root.kind).toBe('worktree');
    const worktreeId = session.root.kind === 'worktree' ? session.root.worktreeId : '';
    const dir = s.worktreeDir(worktreeId);
    expect(s.manager.get(worktreeId)).toMatchObject({ sessionId: session.id, kept: false, ownerUserId: 'dev:host' });

    const first = new OutputCollector(host.conn, session.id);
    await first.attach(true);
    typeInto(host.conn, session.id, 'pwd; printf "half done\\n" > progress.md; echo MARK-""WRITTEN\r');
    // The quotes keep the echoed command line from matching: only the command's own output does.
    await waitUntil(() => first.output.includes('MARK-WRITTEN'), 'the first session to write');
    await waitUntil(async () => (await lstat(join(dir, 'progress.md')).catch(() => null)) !== null, 'progress.md in the worktree');
    expect(first.output).toContain(await realpath(dir));
    expect(await lstat(join(s.t.root, 'progress.md')).catch(() => null)).toBeNull();
    first.dispose();

    // 「保留」: the owner ends the session and keeps the worktree.
    await host.conn.request('session.end', { sessionId: session.id, keepWorktree: true });
    await waitUntil(() => s.manager.get(worktreeId)?.kept === true, 'the worktree to be kept');
    expect(s.manager.get(worktreeId)?.sessionId).toBeUndefined();

    // A later session continues in it.
    const { session: later } = await host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 100, rows: 30 });
    expect(later.root).toEqual({ kind: 'worktree', worktreeId });
    expect(s.manager.get(worktreeId)).toMatchObject({ sessionId: later.id, kept: false });
    const second = new OutputCollector(host.conn, later.id);
    await second.attach(true);
    typeInto(host.conn, later.id, 'cat progress.md; echo MARK-READ\r');
    await waitUntil(() => second.output.includes('half done'), 'the later session to see the earlier work');
    second.dispose();

    // The same worktree cannot be taken by a second session while this one runs.
    expect(await settleError(host.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 80, rows: 24 }))).toMatchObject({
      code: 'conflict',
      reason: 'worktree-in-use',
    });
    expect(await settleError(host.conn.request('worktree.remove', { worktreeId }))).toMatchObject({ code: 'conflict', reason: 'worktree-in-use' });

    // 「不保留」: ending with keepWorktree: false removes it.
    await host.conn.request('session.end', { sessionId: later.id, keepWorktree: false });
    await waitUntil(() => s.manager.get(worktreeId) === null, 'the worktree to be removed');
    expect(await lstat(dir).catch(() => null)).toBeNull();
    expect(await readFile(join(s.t.root, 'README.md'), 'utf8')).toBe('# demo\n');
  }, 60_000);

  it('a 可使用 agent member continues only in their own kept worktree (R9, unchanged by §11 D-15)', async () => {
    sessions = await testSessionsModule();
    stack = await startWorktreeStack({ laterModules: [sessions.module] });
    const s = stack;
    const amy = await s.connect('dev:amy', 'agent');
    const bob = await s.connect('dev:bob', 'agent');
    const { session } = await amy.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree' }, cols: 80, rows: 24 });
    const worktreeId = session.root.kind === 'worktree' ? session.root.worktreeId : '';
    expect(s.manager.get(worktreeId)).toMatchObject({ ownerUserId: 'dev:amy', sessionId: session.id });
    expect(s.t.ctx.roots.get(session.root)?.realPath).toBe(s.worktreeDir(worktreeId));
    await amy.conn.request('session.end', { sessionId: session.id, keepWorktree: true });
    await waitUntil(() => s.manager.get(worktreeId)?.kept === true, 'kept');

    expect(await settleError(bob.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 80, rows: 24 }))).toMatchObject({
      code: 'forbidden',
    });
    const { session: again } = await amy.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree', worktreeId }, cols: 80, rows: 24 });
    expect(again.root).toEqual({ kind: 'worktree', worktreeId });
    await amy.conn.request('session.end', { sessionId: again.id });
    await waitUntil(() => s.manager.get(worktreeId)?.kept === true, 'kept by default');
  }, 60_000);
});
