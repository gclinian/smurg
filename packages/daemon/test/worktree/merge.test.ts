// R9 merge flow (ARCHITECTURE §5.7 "What a merge request contains", contract review C6): the owner's request commits
// the worktree as the owner and fetches exactly that commit; the host sees the complete diff; approve merges exactly
// that commit (clean → main workspace, conflict → nothing changes, conflicting files listed); reject leaves the
// worktree untouched (R9.3).
import { lstat, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, MERGE_DIFF_MAX_BYTES, type MergeRequest } from '@smurg/protocol';
import { locksModule } from '../../src/locks/module.ts';
import { waitFor, type TestClient } from '../../src/testing/index.ts';
import { settleError, startWorktreeStack, type WorktreeStack } from './support.ts';

let stack: WorktreeStack | null = null;

afterEach(async () => {
  await stack?.cleanup();
  stack = null;
}, 60_000);

async function amyWorktree(s: WorktreeStack): Promise<{ amy: TestClient; worktreeId: string; dir: string }> {
  const amy = await s.connect('dev:amy', 'agent');
  const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_amy' });
  return { amy, worktreeId: handle.worktree.id, dir: s.worktreeDir(handle.worktree.id) };
}

/** Everything that identifies a worktree's state: HEAD, branch, status (incl. untracked) and every file's bytes. */
async function snapshot(s: WorktreeStack, dir: string): Promise<Record<string, string>> {
  const files = (await s.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], dir)).split('\0').filter(Boolean).sort();
  const out: Record<string, string> = {
    head: (await s.git(['rev-parse', 'HEAD'], dir)).trim(),
    branch: (await s.git(['symbolic-ref', 'HEAD'], dir)).trim(),
    status: await s.git(['status', '--porcelain=v1', '--untracked-files=all'], dir),
    log: await s.git(['log', '--format=%H %an %s', '--all'], dir),
  };
  for (const file of files) out[`file:${file}`] = await readFile(join(dir, file), 'utf8').catch(() => '<unreadable>');
  return out;
}

describe('worktree.merge.request', { timeout: 60_000 }, () => {
  it('commits the working tree as the owner and fetches exactly that commit into refs/smurg/merge/<id>', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(dir, 'NEW.md'), 'new file\n');
    const updates: MergeRequest[] = [];
    s.host.conn.on('worktree.merge.updated', (payload) => updates.push(payload.request));

    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId, message: '把答案改成 43' });
    expect(request).toMatchObject({ worktreeId, status: 'pending', requestedBy: { userId: 'dev:amy', displayName: 'amy' }, message: '把答案改成 43' });
    expect(request.id).toMatch(/^mr_[0-9a-f]{24}$/);
    // The commit is on the worktree's branch, authored and committed by the owner.
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe(request.commit);
    expect((await s.git(['log', '-1', '--format=%an|%ae|%cn|%s'], dir)).trim()).toBe('amy|dev-amy@users.smurg.invalid|amy|把答案改成 43');
    // The main repository has exactly that commit under the request's ref; its working tree did not change.
    expect((await s.git(['rev-parse', `refs/smurg/merge/${request.id}`])).trim()).toBe(request.commit);
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');

    await waitFor(() => updates.some((update) => update.id === request.id), { what: 'worktree.merge.updated' });
    const list = await s.host.conn.request('worktree.merge.list', {});
    expect(list.requests.map((r) => r.id)).toEqual([request.id]);
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'worktree.merge.request')).toMatchObject({ outcome: 'ok', target: request.id, actor: { userId: 'dev:amy' } });

    // Nothing new to commit is fine: a second request reuses the branch head.
    const second = await amy.conn.request('worktree.merge.request', { worktreeId });
    expect(second.request.commit).toBe(request.commit);
  });

  it('anyone with worktree.merge.request (the host, Agent access) may request a merge of any worktree (§11 D-15); an editor may not (audited)', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { worktreeId, dir } = await amyWorktree(s);
    const bob = await s.connect('dev:bob', 'editor');
    const carl = await s.connect('dev:carl', 'agent');
    expect(await settleError(bob.conn.request('worktree.merge.request', { worktreeId }))).toMatchObject({ code: 'forbidden' });
    const denied = (await s.t.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'authz.denied' && entry.target === 'worktree.merge.request');
    expect(denied.map((entry) => (entry.actor.kind === 'user' ? entry.actor.userId : ''))).toEqual(['dev:bob']);
    // Carl did not open Amy's worktree, but he may type into her session anyway: he may ask the host to merge it.
    await writeFile(join(dir, 'from-carl.txt'), 'carl\n');
    const byCarl = (await carl.conn.request('worktree.merge.request', { worktreeId, message: 'Carl 的請求' })).request;
    expect(byCarl).toMatchObject({ worktreeId, requestedBy: { userId: 'dev:carl' }, status: 'pending' });
    expect((await s.git(['log', '-1', '--format=%an|%s'], dir)).trim()).toBe('carl|Carl 的請求');
    const byHost = (await s.host.conn.request('worktree.merge.request', { worktreeId })).request;
    expect(byHost).toMatchObject({ worktreeId, requestedBy: { userId: s.host.userId }, commit: byCarl.commit });
    const requests = (await s.t.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'worktree.merge.request' && entry.outcome === 'ok');
    expect(requests.map((entry) => (entry.actor.kind === 'user' ? entry.actor.userId : '')).sort()).toEqual(['dev:carl', s.host.userId].sort());
  });

  it('refuses a merge request of a member who is not the host that carries host-only paths or the daemon directory (no ref is left behind)', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'settings.json'), '{"hooks":{}}\n');
    const hostOnly = await settleError(amy.conn.request('worktree.merge.request', { worktreeId }));
    expect(hostOnly).toMatchObject({ code: 'host_only', reason: 'host-only-paths' });
    expect(hostOnly?.detail?.['paths']).toEqual(['.claude/settings.json']);
    await rm(join(dir, '.claude'), { recursive: true });

    await mkdir(join(dir, 'lib', '.vscode'), { recursive: true });
    await writeFile(join(dir, 'lib', '.vscode', 'tasks.json'), '{}\n');
    expect(await settleError(amy.conn.request('worktree.merge.request', { worktreeId }))).toMatchObject({ code: 'host_only', reason: 'host-only-paths' });
    await rm(join(dir, 'lib'), { recursive: true });

    await mkdir(join(dir, '.smurg', 'worktrees', 'wt_000000000000000000000000'), { recursive: true });
    await writeFile(join(dir, '.smurg', 'worktrees', 'wt_000000000000000000000000', 'x'), 'x\n');
    expect(await settleError(amy.conn.request('worktree.merge.request', { worktreeId }))).toMatchObject({ code: 'host_only', reason: 'daemon-dir' });

    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.filter((entry) => entry.action === 'worktree.merge.request' && entry.outcome === 'denied').length).toBe(3);
  });
});

describe('R9 merge review', { timeout: 60_000 }, () => {
  it('R9 merge: the host sees the complete diff (large diffs are cut at a file boundary; every file is readable one by one)', async () => {
    stack = await startWorktreeStack({ files: { 'README.md': '# demo\n', 'src/app.ts': 'export const answer = 42;\n', 'old-name.txt': 'rename me\n'.repeat(20) } });
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    const line = (i: number): string => `line ${i} ${'x'.repeat(60)}\n`;
    const block = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${line(i)}`).join('');
    await writeFile(join(dir, 'a-large.txt'), block(9_000, 'a')); // ~650 KB of diff
    await writeFile(join(dir, 'b-large.txt'), block(9_000, 'b')); // together with a-large: over 1 MiB
    await writeFile(join(dir, 'c-huge.txt'), block(20_000, 'c')); // alone over 1 MiB
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await unlink(join(dir, 'README.md'));
    await rename(join(dir, 'old-name.txt'), join(dir, 'new-name.txt'));
    await writeFile(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });

    const review = await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    const byPath = new Map(review.files.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual(['README.md', 'a-large.txt', 'b-large.txt', 'c-huge.txt', 'image.bin', 'new-name.txt', 'src/app.ts']);
    expect(byPath.get('README.md')).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(byPath.get('a-large.txt')).toMatchObject({ status: 'added', additions: 9_000 });
    expect(byPath.get('new-name.txt')).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt' });
    expect(byPath.get('image.bin')).toMatchObject({ status: 'added', binary: true });
    expect(byPath.get('src/app.ts')).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(review.truncated).toBe(true);
    expect(Buffer.byteLength(review.diff)).toBeLessThanOrEqual(MERGE_DIFF_MAX_BYTES);
    // Cut at a file boundary: every section present is whole.
    const sections = review.diff.split(/^(?=diff --git )/m).filter(Boolean);
    const shown = new Set<string>();
    for (const section of sections) {
      const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(section);
      expect(header).not.toBeNull();
      shown.add(header?.[2] as string);
    }
    expect(shown.has('a-large.txt')).toBe(true);
    expect(sections.find((section) => section.includes('b/a-large.txt'))?.split('\n').filter((l) => l.startsWith('+a')).length).toBe(9_000);

    // Every file the summary did not show whole can be reviewed on its own: together, the complete change.
    let hugeTruncated = false;
    for (const file of review.files) {
      if (shown.has(file.path)) continue;
      const one = await s.host.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: file.path });
      expect(one.path).toBe(file.path);
      if (file.path === 'c-huge.txt') {
        hugeTruncated = one.truncated;
        expect(Buffer.byteLength(one.diff)).toBeLessThanOrEqual(MERGE_DIFF_MAX_BYTES);
      } else {
        expect(one.truncated).toBe(false);
      }
      if (file.path === 'b-large.txt') expect(one.diff.split('\n').filter((l) => l.startsWith('+b')).length).toBe(9_000);
      if (file.path === 'src/app.ts') expect(one.diff).toContain('+export const answer = 43;');
      if (file.path === 'image.bin') expect(one.binary).toBe(true);
      if (file.path === 'new-name.txt') expect(one.diff).toContain('rename from old-name.txt');
    }
    expect(hugeTruncated).toBe(true);
    // Every member reads a request's changes (`file.read`: a result report shows them): the requester, an editor, a viewer.
    await amy.conn.request('worktree.merge.diff', { requestId: request.id });
    const bob = await s.connect('dev:bob', 'editor');
    await expect(bob.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'src/app.ts' })).resolves.toMatchObject({ path: 'src/app.ts', binary: false });
    const vera = await s.connect('dev:vera', 'viewer');
    const seenByViewer = await vera.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(seenByViewer.files).toEqual(review.files);
    expect(seenByViewer.diff).toBe(review.diff);
    // Only paths of the request's file list: anything else is refused, whatever it names.
    for (const path of ['package.json', 'src', '*', 'src/*.ts']) {
      expect(await settleError(s.host.conn.request('worktree.merge.fileDiff', { requestId: request.id, path }))).toMatchObject({ code: 'bad_request', reason: 'path-not-in-diff' });
    }
  });

  it('diff and approve work on exactly the requested commit, whatever happens in the worktree afterwards', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 44;\n');
    await writeFile(join(dir, 'later.txt'), 'not part of the request\n');
    const review = await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(review.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(review.diff).toContain('+export const answer = 43;');
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(await lstat(join(s.t.root, 'later.txt')).catch(() => null)).toBeNull();
  });
});

describe('R9 merge decisions', { timeout: 60_000 }, () => {
  it('R9 merge: a clean merge lands in the main workspace', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(dir, 'src', 'extra.ts'), 'export const extra = true;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId, message: 'feature' });
    // Meanwhile the main workspace moves on elsewhere.
    await writeFile(join(s.t.root, 'README.md'), '# demo (host edit)\n');
    await s.git(['commit', '-qam', 'host edit']);
    const before = (await s.git(['rev-parse', 'HEAD'])).trim();
    const updates: MergeRequest[] = [];
    amy.conn.on('worktree.merge.updated', (payload) => updates.push(payload.request));

    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged).toMatchObject({ id: request.id, status: 'merged', commit: request.commit });
    expect(merged.decidedAt).toBeGreaterThan(0);
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(await readFile(join(s.t.root, 'src', 'extra.ts'), 'utf8')).toBe('export const extra = true;\n');
    expect(await readFile(join(s.t.root, 'README.md'), 'utf8')).toBe('# demo (host edit)\n');
    const parents = (await s.git(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ');
    expect(parents.slice(1)).toEqual([before, request.commit]);
    expect((await s.git(['log', '-1', '--format=%an|%s'])).trim()).toBe(`Host|Merge ${s.manager.get(worktreeId)?.branch} (amy)`);
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    await waitFor(() => updates.some((update) => update.status === 'merged'), { what: 'merge.updated to the requester' });
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'worktree.merge.approve')).toMatchObject({ outcome: 'ok', target: request.id, actor: { userId: 'dev:host' } });
    // Decided once: a second approve or reject is refused.
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: request.id }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
    expect(await settleError(s.host.conn.request('worktree.merge.reject', { requestId: request.id }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
  });

  it('R9 merge: a conflicting merge lists the conflicting files and leaves the main workspace clean', async () => {
    stack = await startWorktreeStack({ files: { 'README.md': '# demo\n', 'src/app.ts': 'export const answer = 42;\n', 'notes.txt': 'one\ntwo\n' } });
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(dir, 'notes.txt'), 'one\ntwo (worktree)\n');
    await writeFile(join(dir, 'fresh.txt'), 'only in the worktree\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    await writeFile(join(s.t.root, 'src', 'app.ts'), 'export const answer = 41;\n');
    await writeFile(join(s.t.root, 'notes.txt'), 'one\ntwo (host)\n');
    await s.git(['commit', '-qam', 'host change']);
    const head = (await s.git(['rev-parse', 'HEAD'])).trim();

    const { request: result } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(result.status).toBe('conflict');
    expect([...(result.conflictFiles ?? [])].sort()).toEqual(['notes.txt', 'src/app.ts']);
    // The main workspace is exactly as it was: same HEAD, no merge in progress, no conflict markers, no new file.
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await s.git(['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('');
    expect(await lstat(join(s.t.root, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 41;\n');
    expect(await lstat(join(s.t.root, 'fresh.txt')).catch(() => null)).toBeNull();
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'worktree.merge.approve')).toMatchObject({ outcome: 'error', detail: { reason: 'conflict' } });

    // The host resolves it on their side (here: back to the base), then the same request merges.
    await writeFile(join(s.t.root, 'src', 'app.ts'), 'export const answer = 42;\n');
    await writeFile(join(s.t.root, 'notes.txt'), 'one\ntwo\n');
    await s.git(['commit', '-qam', 'host revert']);
    const { request: retried } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(retried.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'notes.txt'), 'utf8')).toBe('one\ntwo (worktree)\n');
  });

  it('R9.3 when the host rejects the merge the worktree stays as it was', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    // Work continues after the request (uncommitted), and must survive the rejection untouched too.
    await writeFile(join(dir, 'draft.md'), 'still working\n');
    await symlink('src/app.ts', join(dir, 'alias.ts'));
    const before = await snapshot(s, dir);
    const mainBefore = (await s.git(['rev-parse', 'HEAD'])).trim();

    const { request: rejected } = await s.host.conn.request('worktree.merge.reject', { requestId: request.id, reason: '請先補測試' });
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: '請先補測試' });
    expect(await snapshot(s, dir)).toEqual(before);
    expect(s.manager.get(worktreeId)).not.toBeNull();
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(mainBefore);
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'worktree.merge.reject')).toMatchObject({ outcome: 'ok', target: request.id, detail: { reason: '請先補測試' } });
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: request.id }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
  });

  it('only the host decides (worktree.merge.decide), and the decision is audited', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'x.txt'), 'x\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    const viewer = await s.connect('dev:vera', 'viewer');
    expect(await settleError(amy.conn.request('worktree.merge.approve', { requestId: request.id }))).toMatchObject({ code: 'forbidden' });
    expect(await settleError(amy.conn.request('worktree.merge.reject', { requestId: request.id }))).toMatchObject({ code: 'forbidden' });
    expect(await settleError(viewer.conn.request('worktree.merge.approve', { requestId: request.id }))).toMatchObject({ code: 'forbidden' });
    // Everyone sees that the request exists, and its changes; deciding stays the host's.
    expect((await viewer.conn.request('worktree.merge.list', {})).requests[0]?.status).toBe('pending');
    expect((await viewer.conn.request('worktree.merge.diff', { requestId: request.id })).files.map((file) => file.path)).toEqual(['x.txt']);
    const denied = (await s.t.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'authz.denied');
    expect(denied.map((entry) => entry.target).sort()).toEqual(['worktree.merge.approve', 'worktree.merge.approve', 'worktree.merge.reject']);
    expect(await lstat(join(s.t.root, 'x.txt')).catch(() => null)).toBeNull();
  });

  it('refuses the merge while a main-workspace file it would touch is locked, then merges once it is free', async () => {
    stack = await startWorktreeStack({ extraModules: [locksModule] });
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    const file = { root: MAIN_ROOT, path: 'src/app.ts' };
    const touch = s.t.ctx.services.locks.touchHuman(file, { userId: 'dev:host', displayName: 'Host' });
    expect(touch.ok).toBe(true);
    const refused = await settleError(s.host.conn.request('worktree.merge.approve', { requestId: request.id }));
    expect(refused).toMatchObject({ code: 'locked', reason: 'files-locked' });
    expect(refused?.detail?.['paths']).toEqual(['src/app.ts']);
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect(s.manager.listMerges(s.principal('dev:host'))[0]?.status).toBe('pending');
    // A lock on a file the merge does not touch does not matter.
    s.t.ctx.services.locks.leaveHuman(file, 'dev:host', 'closed');
    s.t.ctx.services.locks.touchHuman({ root: MAIN_ROOT, path: 'README.md' }, { userId: 'dev:host', displayName: 'Host' });
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
  });

  it('a merge request and the host\'s decision appear in everyone\'s activity feed', async () => {
    stack = await startWorktreeStack({ extraModules: [locksModule] });
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    const vera = await s.connect('dev:vera', 'viewer');
    const live: { kind: string; summary: string; text: unknown; actor: { kind: string; userId?: string } }[] = [];
    vera.conn.on('activity.event', ({ event }) => live.push(event));
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 44;\n');
    const { request: second } = await amy.conn.request('worktree.merge.request', { worktreeId });
    await s.host.conn.request('worktree.merge.reject', { requestId: second.id, reason: '先不要' });
    await waitFor(() => live.filter((e) => e.kind === 'merge').length === 4, { what: 'four merge entries at a viewer' });
    const merges = live.filter((e) => e.kind === 'merge');
    expect(merges.map((e) => [e.actor.kind === 'user' ? e.actor.userId : e.actor.kind, e.text, e.summary])).toEqual([
      ['dev:amy', { id: 'activity.mergeRequested' }, 'Asked to merge their worktree into the main workspace'],
      [s.principal('dev:host').userId, { id: 'activity.mergeMerged', params: { requester: 'amy' } }, "Merged amy's worktree into the main workspace"],
      ['dev:amy', { id: 'activity.mergeRequested' }, 'Asked to merge their worktree into the main workspace'],
      [s.principal('dev:host').userId, { id: 'activity.mergeRejected', params: { requester: 'amy' } }, "Rejected the merge of amy's worktree"],
    ]);
    const listed = (await vera.conn.request('activity.list', {})).events.filter((e) => e.kind === 'merge');
    expect(listed).toHaveLength(4);
  });

  it('uncommitted host changes to a file the merge would change are listed as conflicts; nothing is overwritten', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(dir, 'brand-new.txt'), 'from the worktree\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    await writeFile(join(s.t.root, 'src', 'app.ts'), 'export const answer = 42; // host typing\n');
    await writeFile(join(s.t.root, 'brand-new.txt'), 'host draft, untracked\n');
    const { request: result } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(result.status).toBe('conflict');
    expect([...(result.conflictFiles ?? [])].sort()).toEqual(['brand-new.txt', 'src/app.ts']);
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42; // host typing\n');
    expect(await readFile(join(s.t.root, 'brand-new.txt'), 'utf8')).toBe('host draft, untracked\n');
    expect(await lstat(join(s.t.root, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
  });

  it('an IGNORED host file where the merge adds one is not overwritten silently: listed as a conflict, kept byte for byte', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    // The host keeps a local, git-ignored file (only the host's own exclude list knows it) and a local link.
    await writeFile(join(s.t.root, '.git', 'info', 'exclude'), `${await readFile(join(s.t.root, '.git', 'info', 'exclude'), 'utf8')}/.env\n/cache\n`);
    await writeFile(join(s.t.root, '.env'), 'HOST_SECRET=keep-me\n');
    await symlink('src', join(s.t.root, 'cache'));
    expect((await s.git(['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('');
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, '.env'), 'GUEST=overwrites\n');
    await mkdir(join(dir, 'cache'));
    await writeFile(join(dir, 'cache', 'index.json'), '{}\n');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    const head = (await s.git(['rev-parse', 'HEAD'])).trim();

    const { request: result } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(result.status).toBe('conflict');
    expect([...(result.conflictFiles ?? [])].sort()).toEqual(['.env', 'cache']);
    expect(await readFile(join(s.t.root, '.env'), 'utf8')).toBe('HOST_SECRET=keep-me\n');
    expect((await lstat(join(s.t.root, 'cache'))).isSymbolicLink()).toBe(true);
    expect(await lstat(join(s.t.root, 'src', 'index.json')).catch(() => null)).toBeNull();
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((entry) => entry.action === 'worktree.merge.approve')).toMatchObject({ outcome: 'error', detail: { reason: 'local-changes' } });

    // Once the host moved them aside, the same request merges.
    await rm(join(s.t.root, '.env'));
    await unlink(join(s.t.root, 'cache'));
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: request.id })).request.status).toBe('merged');
    expect(await readFile(join(s.t.root, '.env'), 'utf8')).toBe('GUEST=overwrites\n');
    expect(await readFile(join(s.t.root, 'cache', 'index.json'), 'utf8')).toBe('{}\n');
  });

  it('a pending request stays decidable after its worktree was removed (the commit lives in the main repository)', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'kept.txt'), 'survives the worktree\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    await s.manager.releaseFromSession(worktreeId, 'ses_amy', { keep: false });
    expect(s.manager.get(worktreeId)).toBeNull();
    const review = await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(review.files.map((file) => file.path)).toEqual(['kept.txt']);
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'kept.txt'), 'utf8')).toBe('survives the worktree\n');
  });
});
