// SPEC R8 (D14) over the wire: a real daemon with the locks module, real clients through the in-memory relay, and
// the hooks / docs / watcher side played by agent-sim.ts exactly as core/interfaces.ts specifies it. The PreToolUse
// deny that the real `claude` receives is the hookOutput built here from the LockManager's decision
// (claude-hooks.md §3.4); running the real CLI against it is the hooks module's end-to-end test.
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type FileRef } from '@smurg/protocol';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { agentSession, humanTypes, permissionRequest, postToolUse, preToolUse, recorder, userPromptSubmit, watcherSaw } from './agent-sim.ts';

const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const APP = main('src/app.ts');

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function daemon(settings: { humanLockIdleMs?: number; agentLockTimeoutMs?: number } = {}): Promise<TestDaemon> {
  t = await createTestDaemon({
    modules: [locksModule],
    project: { files: { 'src/app.ts': 'export const a = 1;\n', 'README.md': '# hi\n', 'notes.txt': 'n\n' } },
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  });
  return t;
}

const AMY = { userId: 'dev:amy', displayName: 'Amy' } as const;
const BOB = { userId: 'dev:bob', displayName: 'Bob' } as const;
const IAN = agentSession('ses_ian', 'dev:ian', 'Ian');
const HOSTS_AGENT = agentSession('ses_host', 'dev:host', 'Host');

describe('R8 檔案鎖 (acceptance)', () => {
  it('R8.1 有人正在打字的檔案，agent 的 Edit 被擋下，並收到持有者的名字', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const states = recorder(host.conn, 'lock.state');
    const activity = recorder(amy.conn, 'activity.event');

    expect(humanTypes(d, AMY, APP)).toMatchObject({ ok: true, acquired: true }); // Amy types her first character
    const edit = preToolUse(d, IAN, APP, 'Edit');
    expect(edit.granted).toBe(false);
    expect(edit.hookOutput?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(edit.hookOutput?.hookSpecificOutput.permissionDecisionReason).toBe('此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試');

    await waitFor(() => states.length >= 1 && activity.some((a) => a.event.kind === 'lock.denied'), { what: 'lock.state and the lock.denied entry' });
    expect(states[0]).toMatchObject({ file: APP, lock: { kind: 'human', holders: [{ userId: 'dev:amy', displayName: 'Amy' }] } });
    const denied = activity.find((a) => a.event.kind === 'lock.denied')?.event;
    expect(denied).toMatchObject({ actor: { kind: 'agent', sessionId: 'ses_ian', ownerUserId: 'dev:ian', displayName: 'Claude（Ian）' }, file: APP });
    expect(denied?.summary).toContain('Amy');
    const audit = await host.conn.request('admin.audit.query', { limit: 50 });
    expect(audit.entries.find((e) => e.action === 'lock.denied')).toMatchObject({
      outcome: 'denied',
      actor: { kind: 'agent', ownerUserId: 'dev:ian' },
      target: 'main:src/app.ts',
      detail: { holderKind: 'human', holders: ['Amy'], tool: 'Edit' },
    });
    // Nothing was granted to the agent.
    expect(d.ctx.services.locks.get(APP)?.kind).toBe('human');
  });

  it('R8.2 agent 正在修改的檔案，所有人的編輯器暫時唯讀並顯示提示；完成後自動恢復可編輯', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    const vera = await d.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const seen = [host, amy, vera].map((client) => recorder(client.conn, 'lock.state'));

    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    await waitFor(() => seen.every((list) => list.length >= 1), { what: 'lock.state (agent) at every client' });
    for (const list of seen) {
      // The notice every editor shows: 「Claude（Ian）正在修改」, read-only until expiresAt at the latest.
      expect(list[0]).toMatchObject({ file: APP, lock: { kind: 'agent', agentName: 'Claude（Ian）', ownerUserId: 'dev:ian', sessionId: 'ses_ian' } });
    }
    // While it is held, a person's edit is refused (DocService reverts it and sends doc.rejected).
    expect(humanTypes(d, AMY, APP)).toMatchObject({ ok: false, lock: { kind: 'agent', agentName: 'Claude（Ian）' } });
    const listed = await amy.conn.request('lock.list', {});
    expect(listed.locks).toEqual([expect.objectContaining({ kind: 'agent', agentName: 'Claude（Ian）' })]);

    postToolUse(d, IAN, APP); // the agent finished
    await waitFor(() => seen.every((list) => list.length >= 2), { what: 'lock.state (free) at every client' });
    for (const list of seen) expect(list[1]).toEqual({ file: APP, lock: null });
    expect(humanTypes(d, AMY, APP)).toMatchObject({ ok: true, acquired: true }); // editable again
  });

  it('R8.2 … 完成後自動恢復可編輯 — also when the owner rejects the permission prompt (no Post event): the next UserPromptSubmit, the next PreToolUse, or the TTL', async () => {
    const d = await daemon({ agentLockTimeoutMs: 1_000 });
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    const seen = recorder(amy.conn, 'lock.state');

    // Rejected prompt, then the owner types a new prompt.
    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    permissionRequest(d, IAN, APP);
    userPromptSubmit(d, IAN);
    await waitFor(() => seen.length >= 2, { what: 'release by UserPromptSubmit' });
    expect(seen[1]).toEqual({ file: APP, lock: null });

    // Rejected prompt, then the agent tries another file.
    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    permissionRequest(d, IAN, APP);
    expect(preToolUse(d, IAN, main('notes.txt')).granted).toBe(true);
    await waitFor(() => seen.some((s, i) => i >= 2 && s.file.path === 'src/app.ts' && s.lock === null), { what: 'release by the next PreToolUse' });
    postToolUse(d, IAN, main('notes.txt'));

    // Rejected prompt and nothing else happens: the TTL (1 s here) ends it, with no call from anyone.
    const before = seen.length;
    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    permissionRequest(d, IAN, APP);
    const started = Date.now();
    await waitFor(() => seen.slice(before).some((s) => s.file.path === 'src/app.ts' && s.lock === null), { what: 'release by the TTL', timeoutMs: 10_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(humanTypes(d, AMY, APP)).toMatchObject({ ok: true });
  });

  it('R8.3 兩個 agent 同時修改同一個檔案時，後到者被擋下', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const activity = recorder(host.conn, 'activity.event');

    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    const later = preToolUse(d, HOSTS_AGENT, APP, 'Write');
    expect(later.granted).toBe(false);
    expect(later.hookOutput?.hookSpecificOutput.permissionDecisionReason).toContain('Claude（Ian）正在修改此檔案');
    await waitFor(() => activity.some((a) => a.event.kind === 'lock.denied'), { what: 'lock.denied' });
    expect(activity.find((a) => a.event.kind === 'lock.denied')?.event).toMatchObject({ actor: { kind: 'agent', sessionId: 'ses_host', displayName: 'Claude（Host）' } });
    expect(d.ctx.services.locks.get(APP)).toMatchObject({ kind: 'agent', sessionId: 'ses_ian' });
    // Once the first agent is done, the second one gets the file.
    postToolUse(d, IAN, APP);
    expect(preToolUse(d, HOSTS_AGENT, APP, 'Write').granted).toBe(true);
  });

  it('R8.5 每一次 agent 的修改都出現在活動動態中，標示是哪個 agent、屬於誰', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const live = recorder(amy.conn, 'activity.event');

    // (1) An Edit through the hook: PreToolUse, the tool writes, the watcher sees it, PostToolUse. One entry.
    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    await writeFile(join(d.root, 'src/app.ts'), 'export const a = 2;\n');
    watcherSaw(d, APP);
    postToolUse(d, IAN, APP);
    // (1b) A second Edit of the same file right after: a new tool call, so a new entry.
    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    postToolUse(d, IAN, APP);
    watcherSaw(d, APP);
    // (2) A Write whose watcher event arrives after the Post (the watcher lags): still one entry.
    expect(preToolUse(d, HOSTS_AGENT, main('README.md'), 'Write').granted).toBe(true);
    postToolUse(d, HOSTS_AGENT, main('README.md'), { tool: 'Write' });
    watcherSaw(d, main('README.md'));
    // (3) The agent's Bash (sed) changes a file it holds no lock for, right after its own edit of it: attributed.
    expect(preToolUse(d, IAN, main('notes.txt')).granted).toBe(true);
    postToolUse(d, IAN, main('notes.txt'), { ok: false }); // PostToolUseFailure: the Edit itself did nothing
    watcherSaw(d, main('notes.txt'));
    // (4) Somebody else's process: external.
    watcherSaw(d, main('build.log'), 'add');

    await waitFor(() => live.length >= 5, { what: 'five activity entries' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = live.map((l) => l.event);
    expect(events.map((e) => [e.kind, e.file?.path])).toEqual([
      ['agent.edit', 'src/app.ts'],
      ['agent.edit', 'src/app.ts'],
      ['agent.edit', 'README.md'],
      ['agent.edit', 'notes.txt'],
      ['external.change', 'build.log'],
    ]);
    expect(events[0]?.actor).toEqual({ kind: 'agent', sessionId: 'ses_ian', ownerUserId: 'dev:ian', displayName: 'Claude（Ian）' });
    expect(events[2]?.actor).toEqual({ kind: 'agent', sessionId: 'ses_host', ownerUserId: 'dev:host', displayName: 'Claude（Host）' });
    expect(events[3]?.actor).toMatchObject({ kind: 'agent', ownerUserId: 'dev:ian' });
    expect(events[4]?.actor).toEqual({ kind: 'system' });
    expect(events[0]?.summary).toContain('Claude（Ian）');

    // The same entries are in the persisted feed (newest first) and in the audit log.
    const listed = await amy.conn.request('activity.list', { limit: 10 });
    expect(listed.events.map((e) => e.id)).toEqual(events.map((e) => e.id).reverse());
    const audit = await host.conn.request('admin.audit.query', { limit: 100 });
    const edits = audit.entries.filter((e) => e.action === 'agent.edit');
    expect(edits).toHaveLength(4);
    expect(edits.map((e) => e.target).sort()).toEqual(['main:README.md', 'main:notes.txt', 'main:src/app.ts', 'main:src/app.ts']);
    expect(audit.entries.filter((e) => e.action === 'external.change')).toHaveLength(1);
    expect((d.ctx.services.activity as unknown as { lastModifiedBy(f: FileRef): unknown }).lastModifiedBy(APP)).toMatchObject({ kind: 'agent', ownerUserId: 'dev:ian' });
  });
});

describe('R8 human lock over the wire', () => {
  it('shared human lock with two humans: 「讓 agent 先改」 releases only the caller; a non-holder cannot', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    const bob = await d.connect({ userId: BOB.userId, displayName: BOB.displayName, role: 'editor' });
    const cleo = await d.connect({ userId: 'dev:cleo', displayName: 'Cleo', role: 'editor' });
    const vera = await d.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
    humanTypes(d, AMY, APP);
    humanTypes(d, BOB, APP);
    expect((await host.conn.request('lock.list', {})).locks).toEqual([
      expect.objectContaining({ kind: 'human', holders: [expect.objectContaining({ displayName: 'Amy' }), expect.objectContaining({ displayName: 'Bob' })] }),
    ]);

    await expect(cleo.conn.request('lock.release', { file: APP })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(vera.conn.request('lock.release', { file: APP })).rejects.toMatchObject({ code: 'forbidden' });
    await bob.conn.request('lock.release', { file: APP });
    expect(d.ctx.services.locks.get(APP)).toMatchObject({ holders: [expect.objectContaining({ userId: 'dev:amy' })] });
    await amy.conn.request('lock.release', { file: main('SRC/App.ts') }); // any spelling of the file
    expect(d.ctx.services.locks.get(APP)).toBeNull();
    await amy.conn.request('lock.release', { file: APP }); // nothing left to release: no error

    const audit = await host.conn.request('admin.audit.query', { limit: 100 });
    expect(audit.entries.filter((e) => e.action === 'authz.denied').map((e) => e.detail?.['reason'])).toEqual(expect.arrayContaining(['not-lock-holder', 'capability']));
    expect(audit.entries.filter((e) => e.action === 'lock.release').map((e) => e.actor)).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: 'dev:bob' }), expect.objectContaining({ userId: 'dev:amy' })]),
    );
  });

  it('idle timeout: the lock ends by itself humanLockIdleMs after the last edit, and every client hears it', async () => {
    const d = await daemon({ humanLockIdleMs: 1_000 });
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    const seen = recorder(amy.conn, 'lock.state');
    humanTypes(d, AMY, APP);
    const started = Date.now();
    await waitFor(() => seen.some((s) => s.lock === null), { what: 'idle release', timeoutMs: 10_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(preToolUse(d, IAN, APP).granted).toBe(true);
  });

  it('setting changed live: lowering humanLockIdleMs in the console releases a lock held under the old value', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const seen = recorder(host.conn, 'lock.state');
    humanTypes(d, AMY, APP);
    await waitFor(() => seen.length >= 1, { what: 'lock.state' });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(d.ctx.services.locks.get(APP)).not.toBeNull(); // 30 s default
    await host.conn.request('admin.settings.set', { humanLockIdleMs: 1_000 });
    await waitFor(() => seen.some((s) => s.lock === null), { what: 'release under the new setting', timeoutMs: 5_000 });
  });

  it('force release audited: the host frees any lock; nobody else may', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    const seen = recorder(amy.conn, 'lock.state');
    expect(preToolUse(d, IAN, APP).granted).toBe(true);
    await expect(amy.conn.request('lock.forceRelease', { file: APP })).rejects.toMatchObject({ code: 'forbidden' });
    expect(d.ctx.services.locks.get(APP)).not.toBeNull();
    await host.conn.request('lock.forceRelease', { file: APP });
    await waitFor(() => seen.some((s) => s.lock === null), { what: 'lock.state after the force release' });
    const audit = await host.conn.request('admin.audit.query', { limit: 50 });
    expect(audit.entries.find((e) => e.action === 'lock.force-release')).toMatchObject({
      outcome: 'ok',
      actor: { kind: 'user', userId: 'dev:host' },
      target: 'main:src/app.ts',
      detail: { kind: 'agent', holder: 'Claude（Ian）', sessionId: 'ses_ian' },
    });
    expect(audit.entries.find((e) => e.action === 'authz.denied' && e.detail?.['type'] === 'lock.forceRelease')).toMatchObject({ actor: { userId: 'dev:amy' } });
  });

  it('two spellings of one file share a lock: case on the shared folder, and a symlink inside it', async () => {
    const d = await daemon();
    await symlink('README.md', join(d.root, 'link.md'));
    // The hook passes the canonical spelling it gets from PathGuard.toFileRef(realpath(file_path)).
    const canonical = await d.ctx.paths.toFileRef(join(d.root, 'link.md'));
    expect(canonical).toEqual(main('README.md'));

    humanTypes(d, AMY, main('readme.md'));
    expect(preToolUse(d, IAN, canonical as FileRef).hookOutput?.hookSpecificOutput.permissionDecisionReason).toContain('Amy');
    d.ctx.services.locks.leaveHuman(main('README.MD'), AMY.userId, 'closed');
    expect(d.ctx.services.locks.get(main('README.md'))).toBeNull();

    humanTypes(d, BOB, main('link.md')); // someone opened the file through the link
    await waitFor(() => d.ctx.services.locks.get(main('README.md')) !== null, { what: 'the link to be resolved to its target' });
    expect(preToolUse(d, IAN, canonical as FileRef).hookOutput?.hookSpecificOutput.permissionDecisionReason).toContain('Bob');
  });

  it('a kicked or demoted member, or one who leaves, holds no lock any more (human holds and their agents’ locks)', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: AMY.userId, displayName: AMY.displayName, role: 'editor' });
    await d.connect({ userId: BOB.userId, displayName: BOB.displayName, role: 'editor' });
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const seen = recorder(host.conn, 'lock.state');
    humanTypes(d, AMY, main('README.md'));
    humanTypes(d, BOB, main('notes.txt'));
    expect(preToolUse(d, IAN, APP).granted).toBe(true);

    await host.conn.request('admin.member.kick', { userId: 'dev:ian' });
    expect(d.ctx.services.locks.get(APP)).toBeNull();
    await host.conn.request('admin.member.setRole', { userId: BOB.userId, role: 'viewer' });
    expect(d.ctx.services.locks.get(main('notes.txt'))).toBeNull();
    await amy.conn.leave();
    expect(d.ctx.services.locks.get(main('README.md'))).toBeNull();
    await waitFor(() => seen.filter((s) => s.lock === null).length === 3, { what: 'three releases announced' });
    expect(d.ctx.services.locks.list()).toEqual([]);
  });

  it('lock outside the session root refused: a worktree session cannot lock the main workspace', async () => {
    const d = await daemon();
    const worktreeSession = agentSession('ses_wt', 'dev:ian', 'Ian', { kind: 'worktree', worktreeId: 'wt_ian' });
    const refused = preToolUse(d, worktreeSession, APP);
    expect(refused.granted).toBe(false);
    expect(refused.hookOutput?.hookSpecificOutput.permissionDecisionReason).toContain('不在這個 session 的工作區內');
    expect(d.ctx.services.locks.list()).toEqual([]);
  });
});
