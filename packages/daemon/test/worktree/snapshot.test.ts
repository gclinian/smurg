// A work item's changes as a merge request (ARCHITECTURE §5.7 "Protocol 4"; DESIGN §3.11, §4.5, §4.7, AD-11): the
// daemon snapshots the worktree into a request in the state `draft`, a new snapshot replaces it, a reviewed draft is
// what the host merges ("reviewed, ready to merge"), `worktree.merge.request` turns the draft into a pending request,
// and the two diff requests are every member's, with host-private files withheld and the text through mask().
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MASKED, mergeRequestSchema, worktreeRoot, type MergeRequest } from '@smurg/protocol';
import { recordActivity } from '../../src/core/fakes/index.ts';
import type { SnapshotResult } from '../../src/core/interfaces.ts';
import { locksModule } from '../../src/locks/module.ts';
import { waitFor } from '../../src/testing/index.ts';
import { settleError, startWorktreeStack, type WorktreeStack } from './support.ts';

let stack: WorktreeStack | null = null;

afterEach(async () => {
  await stack?.cleanup();
  stack = null;
}, 60_000);

const TOPIC = { id: 'tp_checkout', slug: 'checkout' };
const FILES = {
  'README.md': '# demo\n',
  'src/app.ts': 'export const answer = 42;\n',
  'src/other.ts': 'export const other = 1;\n',
  'specs/checkout/SPEC.md': '# Checkout\n',
  'specs/checkout/PLAN.md': '# Plan\n',
};
const MESSAGE = 'smurg: work item 1 (cart-api)';

type Draft = Extract<SnapshotResult, { ok: true }>;

/** `treeCheckDelayMs`: by default far away, so that what a test sees of "holds unmerged work" is what the events said. */
async function itemStack(options: Parameters<typeof startWorktreeStack>[0] = {}): Promise<{ s: WorktreeStack; id: string; dir: string }> {
  stack = await startWorktreeStack({ files: FILES, module: { limits: { treeCheckDelayMs: 600_000 } }, ...options });
  const s = stack;
  await s.connect('dev:mei', 'agent');
  const handle = await s.manager.acquireForItem({ topic: TOPIC, itemId: 'cart-api', owner: s.principal('dev:mei') });
  return { s, id: handle.worktree.id, dir: s.worktreeDir(handle.worktree.id) };
}

async function draftOf(s: WorktreeStack, worktreeId: string, message = MESSAGE): Promise<Draft> {
  const result = await s.manager.snapshot({ worktreeId, message, topicSlug: 'checkout' });
  if (!result.ok) throw new Error(`snapshot refused: ${result.reason} ${result.files.join(', ')}`);
  return result;
}

describe('snapshot: a work item\'s changes as a draft merge request', { timeout: 60_000 }, () => {
  it('commits the working tree as the worktree\'s owner, fetches exactly that commit, and makes a draft nobody asked for', async () => {
    const { s, id, dir } = await itemStack();
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\nexport const more = true;\n');
    await mkdir(join(dir, 'specs', 'checkout', 'reports'), { recursive: true });
    await writeFile(join(dir, 'specs', 'checkout', 'reports', 'cart-api.md'), '# Result\n');
    const wire: MergeRequest[] = [];
    const bus: MergeRequest[] = [];
    s.host.conn.on('worktree.merge.updated', (payload) => wire.push(payload.request));
    s.t.ctx.bus.on('merge.changed', (event) => bus.push(event.request));

    const snapshot = await draftOf(s, id);
    const request = snapshot.request;
    expect(mergeRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ worktreeId: id, status: 'draft', reviewed: false, topicId: 'tp_checkout', itemId: 'cart-api', message: MESSAGE });
    expect(request.requestedBy).toBeUndefined();
    expect(request.id).toMatch(/^mr_[0-9a-f]{24}$/);
    expect(snapshot).toMatchObject({ files: 2, additions: 3, deletions: 1, byHand: [] });
    // The agent does not commit: smurg does, as the member who started the item, with the message it was given.
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe(request.commit);
    expect((await s.git(['log', '-1', '--format=%an|%ae|%s'], dir)).trim()).toBe(`mei|dev-mei@users.smurg.invalid|${MESSAGE}`);
    expect((await s.git(['rev-parse', `refs/smurg/merge/${request.id}`])).trim()).toBe(request.commit);
    // The main workspace did not change.
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');

    expect(bus).toEqual([request]);
    await waitFor(() => wire.some((update) => update.id === request.id), { what: 'worktree.merge.updated' });
    expect((await s.host.conn.request('worktree.merge.list', {})).requests).toEqual([request]);
    // No entry in the activity feed asks anyone for anything: the report is what people see. The audit log has it.
    const audit = (await s.t.ctx.audit.query({ limit: 20 })).find((entry) => entry.action === 'worktree.merge.request');
    expect(audit).toMatchObject({ outcome: 'ok', target: request.id, actor: { kind: 'system' }, detail: { draft: true, commit: request.commit, files: 2, topicId: 'tp_checkout', itemId: 'cart-api' } });
  });

  it('a new snapshot replaces the draft under a new id (the old one is gone, with its ref); an unchanged tree keeps it', async () => {
    const { s, id, dir } = await itemStack();
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const first = await draftOf(s, id);
    // Nothing changed: the snapshot stands, same request.
    const same = await draftOf(s, id);
    expect(same.request).toEqual(first.request);
    expect(s.manager.listMerges(s.principal(s.host.userId))).toHaveLength(1);

    s.manager.setReviewed(first.request.id, true);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 44;\n');
    const second = await draftOf(s, id);
    expect(second.request.id).not.toBe(first.request.id);
    expect(second.request.commit).not.toBe(first.request.commit);
    // A new version was not reviewed, whatever the one before was.
    expect(second.request).toMatchObject({ status: 'draft', reviewed: false });
    expect(s.manager.listMerges(s.principal(s.host.userId)).map((request) => request.id)).toEqual([second.request.id]);
    expect((await s.git(['for-each-ref', '--format=%(refname)', 'refs/smurg/'])).trim()).toBe(`refs/smurg/merge/${second.request.id}`);
    // The host merges exactly the commit they reviewed: a request that was replaced cannot be approved for another one.
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: first.request.id }))).toMatchObject({ code: 'not_found', reason: 'unknown-merge-request' });
    expect(await settleError(s.host.conn.request('worktree.merge.diff', { requestId: first.request.id }))).toMatchObject({ code: 'not_found' });
    expect((await s.host.conn.request('worktree.merge.diff', { requestId: second.request.id })).diff).toContain('+export const answer = 44;');
  });

  it('refuses a change that contains host-only paths or touches the topic\'s SPEC.md / PLAN.md: no request, no ref, the draft before stays', async () => {
    const { s, id, dir } = await itemStack();
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const before = await draftOf(s, id);

    await writeFile(join(dir, 'CLAUDE.md'), 'instructions for agents that run as the host\n');
    await mkdir(join(dir, 'lib', '.claude'), { recursive: true });
    await writeFile(join(dir, 'lib', '.claude', 'settings.json'), '{}\n');
    const hostOnly = await s.manager.snapshot({ worktreeId: id, message: MESSAGE, topicSlug: 'checkout' });
    expect(hostOnly).toEqual({ ok: false, reason: 'host-only-paths', files: ['CLAUDE.md', 'lib/.claude/settings.json'] });
    await rename(join(dir, 'CLAUDE.md'), join(dir, 'notes.md'));
    await writeFile(join(dir, 'lib', '.claude', 'settings.json'), '{}\n');
    await rename(join(dir, 'lib'), join(dir, 'lib-moved'));
    await rename(join(dir, 'lib-moved', '.claude'), join(dir, 'lib-moved', 'claude'));

    // The spec copy is what the agent was started from; an item never carries a change of it into the main workspace.
    await writeFile(join(dir, 'specs', 'checkout', 'SPEC.md'), '# Checkout, rewritten by the item\n');
    const spec = await s.manager.snapshot({ worktreeId: id, message: MESSAGE });
    expect(spec).toEqual({ ok: false, reason: 'spec-files', files: ['specs/checkout/SPEC.md'] });
    await writeFile(join(dir, 'specs', 'checkout', 'SPEC.md'), '# Checkout\n');
    await writeFile(join(dir, 'specs', 'checkout', 'PLAN.md'), '# Plan, rewritten\n');
    expect(await s.manager.snapshot({ worktreeId: id, message: MESSAGE, topicSlug: 'checkout' })).toMatchObject({ ok: false, reason: 'spec-files', files: ['specs/checkout/PLAN.md'] });
    // The daemon's own directory, like a host-only path, is not a member's to merge.
    await writeFile(join(dir, 'specs', 'checkout', 'PLAN.md'), '# Plan\n');
    await mkdir(join(dir, '.smurg'), { recursive: true });
    await writeFile(join(dir, '.smurg', 'x'), 'x\n');
    expect(await s.manager.snapshot({ worktreeId: id, message: MESSAGE, topicSlug: 'checkout' })).toMatchObject({ ok: false, reason: 'host-only-paths', files: ['.smurg/x'] });

    // Nothing of the refused ones is in the main repository; the earlier draft is still what the report shows.
    expect((await s.git(['for-each-ref', '--format=%(refname)', 'refs/smurg/'])).trim()).toBe(`refs/smurg/merge/${before.request.id}`);
    expect(s.manager.listMerges(s.principal(s.host.userId))).toEqual([before.request]);
    const denied = (await s.t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'worktree.merge.request' && entry.outcome === 'denied');
    expect(denied.map((entry) => entry.detail?.['reason']).sort()).toEqual(['daemon-dir', 'host-only-paths', 'spec-files', 'spec-files']);
    expect(denied.every((entry) => entry.actor.kind === 'system' && entry.detail?.['draft'] === true)).toBe(true);

    // Once the offending files are gone, the whole change (net of them) is a draft again.
    await writeFile(join(dir, '.smurg', 'x'), '');
    await rename(join(dir, '.smurg'), join(dir, 'smurg-notes'));
    const after = await draftOf(s, id);
    expect((await s.host.conn.request('worktree.merge.diff', { requestId: after.request.id })).files.map((file) => file.path).sort()).toEqual(['lib-moved/claude/settings.json', 'notes.md', 'smurg-notes/x', 'src/app.ts']);
  });

  it('refuses a worktree it does not know, and says so before git is asked', async () => {
    const { s } = await itemStack();
    expect(await settleError(s.manager.snapshot({ worktreeId: 'wt_000000000000000000000000', message: MESSAGE }))).toMatchObject({ code: 'not_found', reason: 'unknown-worktree' });
    expect(() => s.manager.setReviewed('mr_000000000000000000000000', true)).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('reviewed, ready to merge', { timeout: 60_000 }, () => {
  it('setReviewed marks the draft and announces it; the host approves the draft directly, which implies the request', async () => {
    const { s, id, dir } = await itemStack({ extraModules: [locksModule] });
    const vera = await s.connect('dev:vera', 'viewer');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await draftOf(s, id);
    const wire: MergeRequest[] = [];
    const bus: MergeRequest[] = [];
    vera.conn.on('worktree.merge.updated', (payload) => wire.push(payload.request));
    s.t.ctx.bus.on('merge.changed', (event) => bus.push(event.request));
    const feed: { kind: string; text: unknown; actor: { kind: string; userId?: string } }[] = [];
    vera.conn.on('activity.event', ({ event }) => feed.push(event));

    // What the report's review does: the inbox derives "ready to merge" for the host from exactly this.
    const reviewed = s.manager.setReviewed(request.id, true);
    expect(reviewed).toEqual({ ...request, reviewed: true });
    expect(bus).toEqual([reviewed]);
    await waitFor(() => wire.some((update) => update.id === request.id && update.reviewed), { what: 'the reviewed draft at a viewer' });
    expect(s.manager.listMerges(s.principal(s.host.userId))).toEqual([reviewed]);
    // Saying it again changes and announces nothing; taking it back does.
    s.manager.setReviewed(request.id, true);
    expect(bus).toHaveLength(1);
    expect(s.manager.setReviewed(request.id, false)).toEqual(request);
    s.manager.setReviewed(request.id, true);
    expect(bus).toHaveLength(3);

    // Only the host decides, a draft like any request.
    const mei = await s.connect('dev:mei', 'agent');
    expect(await settleError(mei.conn.request('worktree.merge.approve', { requestId: request.id }))).toMatchObject({ code: 'forbidden' });
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged).toMatchObject({ id: request.id, status: 'merged', reviewed: true, itemId: 'cart-api', requestedBy: { userId: s.host.userId, displayName: 'Host' } });
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    // The merge commit is the host's and names the item's branch and whose work it is.
    expect((await s.git(['log', '-1', '--format=%an|%s|%b'])).trim()).toBe(`Host|Merge smurg/checkout/cart-api (mei)|${MESSAGE}`);
    expect((await s.git(['log', '-1', '--format=%an', `${merged.commit}`])).trim()).toBe('mei');
    await waitFor(() => feed.some((entry) => entry.kind === 'merge'), { what: 'the merge in the activity feed' });
    expect(feed.filter((entry) => entry.kind === 'merge').map((entry) => [entry.actor.userId, entry.text])).toEqual([[s.host.userId, { id: 'activity.mergeMerged', params: { requester: 'mei' } }]]);
    expect((await s.t.ctx.audit.query({ limit: 20 })).find((entry) => entry.action === 'worktree.merge.approve')).toMatchObject({ outcome: 'ok', target: request.id, detail: { topicId: 'tp_checkout', itemId: 'cart-api', status: 'merged' } });
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: request.id }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
  });

  it('a draft the host approved may conflict (nobody asked for it, still), and the host may reject one', async () => {
    const { s, id, dir } = await itemStack();
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await draftOf(s, id);
    await writeFile(join(s.t.root, 'src', 'app.ts'), 'export const answer = 7;\n');
    await s.git(['commit', '-q', '-am', 'the host changed it too']);
    const { request: conflict } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(conflict).toMatchObject({ id: request.id, status: 'conflict', conflictFiles: ['src/app.ts'], itemId: 'cart-api' });
    expect(conflict.requestedBy).toBeUndefined();
    // The main workspace is exactly as the host left it; approving again says the same.
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 7;\n');
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: request.id })).request.status).toBe('conflict');
    const { request: rejected } = await s.host.conn.request('worktree.merge.reject', { requestId: request.id, reason: 'not this way' });
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'not this way' });

    await writeFile(join(dir, 'src', 'other.ts'), 'export const other = 2;\n');
    const next = await draftOf(s, id);
    const { request: gone } = await s.host.conn.request('worktree.merge.reject', { requestId: next.request.id });
    expect(gone.status).toBe('rejected');
    expect(gone.requestedBy).toBeUndefined();
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    // The worktree is not touched by any of it.
    expect(await readFile(join(dir, 'src', 'other.ts'), 'utf8')).toBe('export const other = 2;\n');
  });

  it('`worktree.merge.request` turns the draft with the working tree\'s commit into a pending request (same id); with newer work it makes a new one', async () => {
    const { s, id, dir } = await itemStack();
    const mei = await s.connect('dev:mei', 'agent');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request: draft } = await draftOf(s, id);

    const { request: asked } = await mei.conn.request('worktree.merge.request', { worktreeId: id, message: 'nobody reviewed this yet, please merge' });
    expect(asked).toEqual({ ...draft, status: 'pending', requestedBy: { userId: 'dev:mei', displayName: 'mei' }, message: 'nobody reviewed this yet, please merge' });
    expect(s.manager.listMerges(s.principal(s.host.userId))).toEqual([asked]);
    expect((await s.git(['rev-parse', `refs/smurg/merge/${draft.id}`])).trim()).toBe(draft.commit);
    const audit = (await s.t.ctx.audit.query({ limit: 20 })).find((entry) => entry.action === 'worktree.merge.request' && entry.actor.kind === 'user');
    expect(audit).toMatchObject({ outcome: 'ok', target: draft.id, detail: { fromDraft: true } });

    // Newer work than the newest draft: an ordinary request of its own; the draft (what the report shows) stays.
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 44;\n');
    const second = await draftOf(s, id);
    await writeFile(join(dir, 'src', 'other.ts'), 'export const other = 2;\n');
    const { request: fresh } = await mei.conn.request('worktree.merge.request', { worktreeId: id });
    expect(fresh.id).not.toBe(second.request.id);
    expect(fresh).toMatchObject({ status: 'pending', requestedBy: { userId: 'dev:mei' }, topicId: 'tp_checkout', itemId: 'cart-api' });
    expect(s.manager.listMerges(s.principal(s.host.userId)).map((request) => request.status).sort()).toEqual(['draft', 'pending', 'pending']);
    // A member's own request for an item is held to the item's rule too: not the topic's two files.
    await writeFile(join(dir, 'specs', 'checkout', 'PLAN.md'), '# Plan, rewritten\n');
    expect(await settleError(mei.conn.request('worktree.merge.request', { worktreeId: id }))).toMatchObject({ code: 'host_only', reason: 'spec-files', text: { id: 'report.changes.specFiles' } });
    // The host's own request is the host's to review and merge.
    expect((await s.host.conn.request('worktree.merge.request', { worktreeId: id })).request.status).toBe('pending');
  });
});

describe('changes.byHand: the files people edited in an item\'s worktree', { timeout: 60_000 }, () => {
  it('names the files of the change that a person edited through smurg, and who; not the agent\'s, not files outside the change', async () => {
    const { s, id, dir } = await itemStack();
    const root = worktreeRoot(id);
    const amy = { kind: 'user', userId: 'dev:amy', displayName: 'Amy' } as const;
    const mei = { kind: 'user', userId: 'dev:mei', displayName: 'mei' } as const;
    const agent = { kind: 'agent', sessionId: 'ses_item', ownerUserId: 'dev:mei', displayName: 'Claude (Cart API)' } as const;
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(dir, 'src', 'renamed.ts'), 'export const other = 1;\n');
    await writeFile(join(dir, 'src', 'agent.ts'), 'export const byAgent = true;\n');
    await writeFile(join(dir, 'src', 'uploaded.bin'), 'data\n');

    recordActivity(s.t.ctx, { actor: amy, kind: 'human.edit', file: { root, path: 'src/app.ts' } });
    recordActivity(s.t.ctx, { actor: mei, kind: 'human.edit', file: { root, path: 'src/app.ts' } });
    recordActivity(s.t.ctx, { actor: amy, kind: 'human.edit', file: { root, path: 'src/app.ts' } });
    recordActivity(s.t.ctx, { actor: amy, kind: 'file.rename', file: { root, path: 'src/renamed.ts' }, renamedFrom: 'src/gone.ts' });
    recordActivity(s.t.ctx, { actor: mei, kind: 'file.upload', file: { root, path: 'src/uploaded.bin' } });
    // Not a person's own edit: the agent's tool, a program in the worktree (named after its owner), a lock refusal.
    recordActivity(s.t.ctx, { actor: agent, kind: 'agent.edit', file: { root, path: 'src/agent.ts' } });
    recordActivity(s.t.ctx, { actor: mei, kind: 'external.change', file: { root, path: 'src/agent.ts' } });
    recordActivity(s.t.ctx, { actor: amy, kind: 'lock.denied', file: { root, path: 'src/agent.ts' } });
    // Edited by hand, but not part of the change in the end; and an edit in the main workspace.
    recordActivity(s.t.ctx, { actor: amy, kind: 'human.edit', file: { root, path: 'README.md' } });
    recordActivity(s.t.ctx, { actor: amy, kind: 'human.edit', file: { root: { kind: 'main' }, path: 'src/agent.ts' } });

    const snapshot = await draftOf(s, id);
    expect(snapshot.files).toBe(4);
    expect(snapshot.byHand).toEqual([
      { path: 'src/app.ts', by: [{ userId: 'dev:amy', displayName: 'Amy' }, { userId: 'dev:mei', displayName: 'mei' }] },
      { path: 'src/renamed.ts', by: [{ userId: 'dev:amy', displayName: 'Amy' }] },
      { path: 'src/uploaded.bin', by: [{ userId: 'dev:mei', displayName: 'mei' }] },
    ]);
    // It is the worktree's whole history of hand edits, at every version of the report.
    await writeFile(join(dir, 'README.md'), '# demo, edited\n');
    expect((await draftOf(s, id)).byHand.map((entry) => entry.path)).toEqual(['src/app.ts', 'src/renamed.ts', 'src/uploaded.bin', 'README.md']);
    // A session's worktree keeps no such list (it has no report).
    const plain = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_plain' });
    await writeFile(join(s.worktreeDir(plain.worktree.id), 'src', 'app.ts'), 'export const answer = 1;\n');
    recordActivity(s.t.ctx, { actor: amy, kind: 'human.edit', file: { root: worktreeRoot(plain.worktree.id), path: 'src/app.ts' } });
    const other = await s.manager.snapshot({ worktreeId: plain.worktree.id, message: 'a free worktree' });
    expect(other).toMatchObject({ ok: true, files: 1, byHand: [] });
  });
});

describe('unmerged: item worktrees that hold work the main workspace does not have', { timeout: 60_000 }, () => {
  it('lists a worktree with edits no snapshot has, with a snapshot that is not merged, or with commits no request carried', async () => {
    const { s, id, dir } = await itemStack();
    const other = await s.manager.acquireForItem({ topic: TOPIC, itemId: 'untouched', owner: s.principal('dev:mei') });
    const elsewhere = await s.manager.acquireForItem({ topic: { id: 'tp_login', slug: 'login' }, itemId: 'cart-api', owner: s.principal('dev:mei') });
    const listed = (): (string | undefined)[] => s.manager.unmerged('tp_checkout').map((worktree) => worktree.itemId);
    // Fresh worktrees hold nothing.
    expect(listed()).toEqual([]);
    expect(s.manager.unmerged('tp_login')).toEqual([]);
    expect(s.manager.unmerged('tp_unknown')).toEqual([]);

    // Something wrote in it (the watcher says so; an agent's tool; the activity feed): edits no snapshot has.
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    s.t.ctx.bus.emit('file.changed', { root: worktreeRoot(id), changes: [{ path: 'src/app.ts', change: 'change' }] });
    expect(listed()).toEqual(['cart-api']);
    s.t.ctx.bus.emit('agent.tool.post', { sessionId: 'ses_x', ownerUserId: 'dev:mei', tool: 'Edit', file: { root: worktreeRoot(elsewhere.worktree.id), path: 'src/app.ts' }, ok: true });
    expect(s.manager.unmerged('tp_login').map((worktree) => worktree.id)).toEqual([elsewhere.worktree.id]);
    // The main workspace's own changes say nothing about a worktree.
    s.t.ctx.bus.emit('file.changed', { root: { kind: 'main' }, changes: [{ path: 'src/app.ts', change: 'change' }] });
    expect(listed()).toEqual(['cart-api']);

    // A snapshot that is not merged: a draft, a reviewed draft, a rejected one.
    const draft = await draftOf(s, id);
    expect(listed()).toEqual(['cart-api']);
    s.manager.setReviewed(draft.request.id, true);
    expect(listed()).toEqual(['cart-api']);
    // Merged: nothing of it is missing in the main workspace any more.
    await s.host.conn.request('worktree.merge.approve', { requestId: draft.request.id });
    expect(listed()).toEqual([]);
    // Work after the merge.
    await writeFile(join(dir, 'src', 'other.ts'), 'export const other = 2;\n');
    recordActivity(s.t.ctx, { actor: { kind: 'user', userId: 'dev:mei', displayName: 'mei' }, kind: 'human.edit', file: { root: worktreeRoot(id), path: 'src/other.ts' } });
    expect(listed()).toEqual(['cart-api']);
    const second = await draftOf(s, id);
    await s.host.conn.request('worktree.merge.reject', { requestId: second.request.id });
    expect(listed()).toEqual(['cart-api']);
    expect(s.manager.unmerged('tp_checkout')[0]).toEqual(s.manager.get(id));

    // A refused snapshot leaves a commit on the branch that no request carries: still work that was never merged.
    await writeFile(join(s.worktreeDir(other.worktree.id), 'CLAUDE.md'), 'x\n');
    expect(await s.manager.snapshot({ worktreeId: other.worktree.id, message: MESSAGE, topicSlug: 'checkout' })).toMatchObject({ ok: false, reason: 'host-only-paths' });
    expect(listed().sort()).toEqual(['cart-api', 'untouched']);
  });

  it('looks again once the writes have stopped: an edit that was taken back, or an event that came after the commit that holds it, does not count for long', async () => {
    const { s, id, dir } = await itemStack({ files: { ...FILES, '.gitignore': 'build/\n' }, module: { limits: { treeCheckDelayMs: 40 } } });
    const listed = (): (string | undefined)[] => s.manager.unmerged('tp_checkout').map((worktree) => worktree.itemId);
    const wrote = (path: string): void => s.t.ctx.bus.emit('file.changed', { root: worktreeRoot(id), changes: [{ path, change: 'change' }] });
    const settled = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

    // A write that changed nothing (the same bytes again): counted at once, corrected by the look.
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 42;\n');
    wrote('src/app.ts');
    expect(listed()).toEqual(['cart-api']);
    await waitFor(() => listed().length === 0, { what: 'the look to find the tree unchanged' });
    // A real edit stays, however long one waits.
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    wrote('src/app.ts');
    await settled();
    expect(listed()).toEqual(['cart-api']);
    // Taken back.
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 42;\n');
    wrote('src/app.ts');
    await waitFor(() => listed().length === 0, { what: 'the look to find the edit taken back' });
    // A new file is work; a file git ignores is nobody's (a snapshot would not carry it either).
    await mkdir(join(dir, 'build'), { recursive: true });
    await writeFile(join(dir, 'build', 'out.js'), 'x\n');
    wrote('build/out.js');
    await settled();
    expect(listed()).toEqual([]);
    await writeFile(join(dir, 'src', 'new.ts'), 'export {};\n');
    wrote('src/new.ts');
    await settled();
    expect(listed()).toEqual(['cart-api']);

    // The commit holds it; the watcher's event for that write arrives late. Merged, the worktree holds nothing more.
    const draft = await draftOf(s, id);
    await s.host.conn.request('worktree.merge.approve', { requestId: draft.request.id });
    wrote('src/new.ts');
    expect(listed()).toEqual(['cart-api']);
    await waitFor(() => listed().length === 0, { what: 'the look to find the tree equal to the merged commit' });
    // A removal ends the looking (no timer outlives its worktree).
    wrote('src/new.ts');
    await s.manager.releaseItem(id);
    await settled();
    expect(s.manager.unmerged('tp_checkout')).toEqual([]);
  });
});

describe('the diff of a request is every member\'s, with what is the host\'s alone withheld', { timeout: 60_000 }, () => {
  it('a file on a host-private path is listed as hidden and left out of the text for everyone but the host', async () => {
    const { s, id, dir } = await itemStack({ files: { ...FILES, '.envrc': 'export OLD=1\n', 'tools/CLAUDE.local.md': 'the host\'s notes\n' } });
    const eddie = await s.connect('dev:eddie', 'editor');
    const mei = await s.connect('dev:mei', 'agent');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(dir, '.envrc'), 'export DEPLOY_KEY=hunter2hunter2\n');
    await writeFile(join(dir, 'tools', 'CLAUDE.local.md'), 'private memory, changed\n');
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'settings.local.json'), '{"env":{"KEY":"value"}}\n');
    await rename(join(dir, 'src', 'other.ts'), join(dir, 'src', 'moved.ts'));
    // Only the host's own request can carry such files at all (a snapshot or a member's request is refused).
    expect(await s.manager.snapshot({ worktreeId: id, message: MESSAGE, topicSlug: 'checkout' })).toMatchObject({ ok: false, reason: 'host-only-paths' });
    const { request } = await s.host.conn.request('worktree.merge.request', { worktreeId: id });

    const full = await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(full.files.map((file) => file.path).sort()).toEqual(['.claude/settings.local.json', '.envrc', 'src/app.ts', 'src/moved.ts', 'tools/CLAUDE.local.md']);
    expect(full.files.every((file) => file.hidden === undefined)).toBe(true);
    expect(full.diff).toContain('private memory, changed');
    expect(full.diff).toContain('export OLD=1');

    for (const member of [eddie, mei]) {
      const seen = await member.conn.request('worktree.merge.diff', { requestId: request.id });
      const byPath = new Map(seen.files.map((file) => [file.path, file]));
      expect([...byPath.keys()].sort()).toEqual(['.claude/settings.local.json', '.envrc', 'src/app.ts', 'src/moved.ts', 'tools/CLAUDE.local.md']);
      for (const path of ['.claude/settings.local.json', '.envrc', 'tools/CLAUDE.local.md']) {
        expect(byPath.get(path)).toEqual({ path, status: path === '.claude/settings.local.json' ? 'added' : 'modified', additions: 0, deletions: 0, hidden: true });
      }
      expect(byPath.get('src/app.ts')).toEqual({ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 });
      expect(byPath.get('src/moved.ts')).toMatchObject({ status: 'renamed', oldPath: 'src/other.ts' });
      // The text has every other file, whole, and nothing of the withheld ones: not their content, not their names.
      expect(seen.truncated).toBe(false);
      expect(seen.diff).toContain('+export const answer = 43;');
      expect(seen.diff).toContain('rename from src/other.ts');
      for (const secret of ['DEPLOY_KEY', 'hunter2', 'OLD=1', 'private memory', 'the host\'s notes', '"env"', '.envrc', 'CLAUDE.local.md', 'settings.local.json']) expect(seen.diff).not.toContain(secret);
      // One by one: the same.
      expect(await member.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: '.envrc' })).toEqual({ path: '.envrc', diff: '', truncated: false, binary: false, hidden: true });
      expect(await member.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'tools/CLAUDE.local.md' })).toMatchObject({ diff: '', hidden: true });
      expect((await member.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'src/app.ts' })).diff).toContain('+export const answer = 43;');
    }
    const own = await s.host.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'tools/CLAUDE.local.md' });
    expect(own.hidden).toBeUndefined();
    expect(own.diff).toContain('+private memory, changed');
  });

  it('a host-private file renamed to an ordinary name (or the other way) is withheld under both names', async () => {
    const { s, id, dir } = await itemStack({ files: { ...FILES, '.envrc': `${'export A=1\n'.repeat(30)}`, 'docs/notes.md': `${'a note\n'.repeat(30)}` } });
    const eddie = await s.connect('dev:eddie', 'editor');
    await rename(join(dir, '.envrc'), join(dir, 'env.txt'));
    await mkdir(join(dir, 'nested'), { recursive: true });
    await rename(join(dir, 'docs', 'notes.md'), join(dir, 'nested', '.envrc'));
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await s.host.conn.request('worktree.merge.request', { worktreeId: id });
    const seen = await eddie.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(seen.files.filter((file) => file.hidden).map((file) => [file.oldPath, file.path]).sort()).toEqual([
      ['.envrc', 'env.txt'],
      ['docs/notes.md', 'nested/.envrc'],
    ]);
    expect(seen.files.filter((file) => !file.hidden).map((file) => file.path)).toEqual(['src/app.ts']);
    expect(seen.diff).not.toContain('export A=1');
    expect(seen.diff).not.toContain('a note');
    expect(seen.diff).toContain('+export const answer = 43;');
    expect(await eddie.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'env.txt' })).toMatchObject({ diff: '', hidden: true });
  });

  it('the diff text passes mask(): what looks like a credential is not sent, in the whole diff and in one file\'s', async () => {
    const { s, id, dir } = await itemStack();
    const eddie = await s.connect('dev:eddie', 'editor');
    const key = `sk-ant-${'a1B2'.repeat(10)}`;
    await writeFile(join(dir, 'src', 'config.ts'), `export const config = { name: 'cart' };\nconst client = connect('${key}');\n`);
    const { request } = await draftOf(s, id);
    for (const member of [eddie, s.host]) {
      const whole = await member.conn.request('worktree.merge.diff', { requestId: request.id });
      expect(whole.diff).not.toContain(key);
      expect(whole.diff).toContain(`+const client = connect('${MASKED}');`);
      expect(whole.diff).toContain("+export const config = { name: 'cart' };");
      const one = await member.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'src/config.ts' });
      expect(one.diff).not.toContain(key);
      expect(one.diff).toContain(MASKED);
    }
    // The file itself is what it is: the mask is on what leaves in a diff.
    expect(await readFile(join(dir, 'src', 'config.ts'), 'utf8')).toContain(key);
    expect(await lstat(join(s.t.root, 'src', 'config.ts')).catch(() => null)).toBeNull();
  });

  it('with withheld files a large diff is still cut at a file boundary, and every other file can be read on its own', async () => {
    const { s, id, dir } = await itemStack({ files: { ...FILES, '.envrc': 'export OLD=1\n' } });
    const eddie = await s.connect('dev:eddie', 'editor');
    const block = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${'x'.repeat(60)}\n`).join('');
    await writeFile(join(dir, 'a-large.txt'), block(9_000, 'a'));
    await writeFile(join(dir, 'b-large.txt'), block(9_000, 'b'));
    await writeFile(join(dir, '.envrc'), 'export NEW=2\n');
    const { request } = await s.host.conn.request('worktree.merge.request', { worktreeId: id });
    const seen = await eddie.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(seen.truncated).toBe(true);
    const sections = seen.diff.split(/^(?=diff --git )/m).filter(Boolean);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.split('\n').filter((line) => line.startsWith('+a line')).length).toBe(9_000);
    expect(seen.diff).not.toContain('NEW=2');
    const rest = await eddie.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'b-large.txt' });
    expect(rest.diff.split('\n').filter((line) => line.startsWith('+b line')).length).toBe(9_000);
  });
});
