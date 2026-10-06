// A work item's worktree with the REAL locks (activity feed), files (watcher), docs and worktree modules composed, and
// real clients: people beside an agent in the worktree. What only shows when the modules meet:
//  - S21 through the wire: no member writes the item's copy of the spec or its report (file.*, doc.*); code is theirs;
//  - a hand edit reaches the report's `changes.byHand` through the activity feed's own entry, an "agent's" write on
//    disk reaches the worktree's "holds unmerged work" through the file watcher;
//  - reviewed, ready to merge: the draft the report shows is what the host merges, and every member reads its diff;
//  - with the REAL inbox module: a reviewed draft is in the host's inbox by itself, a conflict stays there marked, and
//    the request a resolved conflict replaced leaves it.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPages, isSmurgError, worktreeRoot, type FileRef, type InboxItem, type MergeRequest } from '@smurg/protocol';
import type { Connection } from '@smurg/protocol/client';
import { buildPlan, buildTopic, buildWorkItem, fakesModule, fakesOf } from '../../src/core/fakes/index.ts';
import { docsModule } from '../../src/docs/module.ts';
import { filesModule } from '../../src/files/module.ts';
import { inboxModule } from '../../src/inbox/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, isolatedGitEnv, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';
import { DocClient, destroyDocClients } from '../docs/helpers.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

let t: TestDaemon | null = null;

afterEach(async () => {
  destroyDocClients();
  await t?.cleanup();
  t = null;
}, 60_000);

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: unknown } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return isSmurgError(err) ? { code: err.code, reason: err.detail?.['reason'] } : { code: 'not-a-smurg-error', reason: String(err) };
  }
}

describe('a work item\'s worktree (real locks, files, docs and worktree modules)', { timeout: 120_000 }, () => {
  it('people edit code beside the agent and are named in the report\'s changes; nobody writes the spec copy or the report; the reviewed draft is what the host merges', async () => {
    t = await createTestDaemon({
      modules: [locksModule, filesModule, docsModule, createWorktreeModule({ limits: { treeCheckDelayMs: 100 } })],
      project: {
        git: true,
        files: { 'src/app.ts': 'export const answer = 42;\n', 'src/cart.ts': 'export const cart = [];\n', 'specs/checkout/SPEC.md': '# Checkout\n', 'specs/checkout/PLAN.md': '# Plan\n' },
      },
    });
    const d = t;
    const manager = d.ctx.services.worktrees as WorktreeManagerImpl;
    const host = await d.connectHost();
    const mei = await d.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const vera = await d.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
    const meiPrincipal = d.ctx.members.principalOf('dev:mei');
    if (meiPrincipal === null) throw new Error('mei');

    // The scheduler starts the item: its own worktree.
    const handle = await manager.acquireForItem({ topic: { id: 'tp_checkout', slug: 'checkout' }, itemId: 'cart-api', owner: meiPrincipal });
    const root = worktreeRoot(handle.worktree.id);
    const dir = handle.root.realPath;
    const at = (path: string): FileRef => ({ root, path });
    expect((await vera.conn.request('worktree.list', {})).worktrees).toEqual([handle.worktree]);
    expect(manager.unmerged('tp_checkout')).toEqual([]);

    // S21: the copy of the spec and the plan is what the agent was started from, the report is the agent's.
    for (const member of [amy, mei, host]) {
      expect(await refusal(member.conn.request('file.write', { file: at('specs/checkout/SPEC.md'), content: encode('# Checkout, as I would like it\n') }))).toMatchObject({ code: 'path_denied', reason: 'read-only' });
      expect(await refusal(member.conn.request('file.create', { file: at('specs/checkout/reports'), kind: 'dir' }))).toMatchObject({ code: 'path_denied', reason: 'read-only' });
      expect(await refusal(member.conn.request('file.rename', { root, from: 'specs/checkout/PLAN.md', to: 'specs/checkout/OLD.md' }))).toMatchObject({ code: 'path_denied' });
      expect(await refusal(member.conn.request('file.delete', { file: at('specs/checkout/SPEC.md') }))).toMatchObject({ code: 'path_denied' });
    }
    const specDoc = await DocClient.open(amy.conn, at('specs/checkout/SPEC.md'));
    expect(specDoc.opened.canEdit).toBe(false);
    expect(await readFile(join(dir, 'specs', 'checkout', 'SPEC.md'), 'utf8')).toBe('# Checkout\n');
    // In the main workspace the same file is the team's to edit.
    await amy.conn.request('file.write', { file: { root: { kind: 'main' }, path: 'specs/checkout/SPEC.md' }, content: encode('# Checkout\n\nA note from Amy.\n') });

    // Hand-coding beside the agent is the product: Amy (an Editor) writes code in the item's worktree.
    await amy.conn.request('file.write', { file: at('src/cart.ts'), content: encode('export const cart: string[] = [];\n') });
    await mei.conn.request('file.create', { file: at('src/by-mei.ts'), kind: 'file' });
    // The "agent" works on disk: its own file, and the report (nobody's agent runs git).
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await mkdir(join(dir, 'specs', 'checkout', 'reports'), { recursive: true });
    await writeFile(join(dir, 'specs', 'checkout', 'reports', 'cart-api.md'), '# Result\n');
    // The watcher saw writes in the worktree: it holds work no snapshot has (what an Archive would ask about).
    await waitFor(() => manager.unmerged('tp_checkout').length === 1, { timeoutMs: 15_000, what: 'the worktree to count as holding unmerged work' });

    // The turn ends with a checked report: the snapshot is the report's diff.
    const updates: MergeRequest[] = [];
    vera.conn.on('worktree.merge.updated', (payload) => updates.push(payload.request));
    const snapshot = await manager.snapshot({ worktreeId: handle.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' });
    if (!snapshot.ok) throw new Error(`snapshot refused: ${snapshot.reason}`);
    expect(snapshot.request).toMatchObject({ status: 'draft', reviewed: false, topicId: 'tp_checkout', itemId: 'cart-api' });
    expect(snapshot.files).toBe(4);
    // Named: the files people edited through smurg, with who; not what the agent wrote itself.
    expect(snapshot.byHand).toEqual([
      { path: 'src/cart.ts', by: [{ userId: 'dev:amy', displayName: 'Amy' }] },
      { path: 'src/by-mei.ts', by: [{ userId: 'dev:mei', displayName: 'Mei' }] },
    ]);
    await waitFor(() => updates.some((request) => request.id === snapshot.request.id), { what: 'the draft at a viewer' });

    // Every member reads the report's changes, the viewer too.
    for (const member of [vera, amy, mei, host]) {
      const review = await member.conn.request('worktree.merge.diff', { requestId: snapshot.request.id });
      expect(review.files.map((file) => file.path).sort()).toEqual(['specs/checkout/reports/cart-api.md', 'src/app.ts', 'src/by-mei.ts', 'src/cart.ts']);
      expect(review.diff).toContain('+export const answer = 43;');
    }
    // "I've reviewed this" marks the draft; it is the host's to merge from then on, and only the host's.
    const reviewed = manager.setReviewed(snapshot.request.id, true);
    await waitFor(() => updates.some((request) => request.id === reviewed.id && request.reviewed), { what: 'the reviewed draft at a viewer' });
    expect(await refusal(mei.conn.request('worktree.merge.approve', { requestId: reviewed.id }))).toMatchObject({ code: 'forbidden' });
    // Amy's uncommitted note in the main workspace's spec is not in the merge's way (the item did not touch that file).
    const { request: merged } = await host.conn.request('worktree.merge.approve', { requestId: reviewed.id });
    expect(merged).toMatchObject({ status: 'merged', reviewed: true, itemId: 'cart-api' });
    expect(await readFile(join(d.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(await readFile(join(d.root, 'src', 'cart.ts'), 'utf8')).toBe('export const cart: string[] = [];\n');
    expect(await readFile(join(d.root, 'specs', 'checkout', 'reports', 'cart-api.md'), 'utf8')).toBe('# Result\n');
    expect(await readFile(join(d.root, 'specs', 'checkout', 'SPEC.md'), 'utf8')).toBe('# Checkout\n\nA note from Amy.\n');
    // Merged: nothing of the worktree is missing in the main workspace (once the watcher's last words about writes the
    // commit already holds have been looked at); merged and reviewed, it is released.
    await waitFor(() => manager.unmerged('tp_checkout').length === 0, { timeoutMs: 15_000, what: 'the worktree to hold nothing unmerged' });
    specDoc.destroy();
    await manager.releaseItem(handle.worktree.id);
    expect((await host.conn.request('worktree.list', {})).worktrees).toEqual([]);
    expect(await refusal(amy.conn.request('file.read', { file: at('src/app.ts') }))).not.toBeNull();
  });
});

/** Every item of kind `merge` in a member's inbox, as the wire gives it. */
async function mergeItems(conn: Connection): Promise<InboxItem[]> {
  const items = await collectPages(
    async (after) => {
      const page = await conn.request('inbox.list', after === undefined ? {} : { after });
      return { items: page.items, hasMore: page.hasMore };
    },
    (item) => item.key,
  );
  return items.filter((item) => item.kind === 'merge');
}

describe('reviewed, ready to merge (real worktree and inbox modules)', { timeout: 120_000 }, () => {
  it('a reviewed draft is in the host\'s inbox by itself; a conflict stays there, marked; what the resolved conflict replaced leaves it; merged, it is gone', async () => {
    t = await createTestDaemon({
      modules: [fakesModule({ except: ['worktrees', 'inbox'], handlers: true }), createWorktreeModule(), inboxModule],
      project: { git: true, files: { 'src/app.ts': 'export const answer = 42;\n', 'specs/checkout/SPEC.md': '# Checkout\n', 'specs/checkout/PLAN.md': '# Plan\n' } },
      agents: { escalationSweepMs: 3_600_000 },
    });
    const d = t;
    const manager = d.ctx.services.worktrees as WorktreeManagerImpl;
    const fakes = fakesOf(d.ctx);
    const host = await d.connectHost();
    const mei = await d.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const meiPrincipal = d.ctx.members.principalOf('dev:mei');
    if (meiPrincipal === null) throw new Error('mei');
    // What the topics module would hold: the topic and its plan (item 2 waits for item 1's merge).
    fakes.topics.put(buildTopic({ id: 'tp_checkout', slug: 'checkout', name: 'Checkout', phase: 'executing' }));
    fakes.plans.putPlan(
      buildPlan({
        topicId: 'tp_checkout',
        items: [buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API', state: 'done' }), buildWorkItem({ id: 'payment-form', number: 2, title: 'Payment form', dependsOn: ['cart-api'], state: 'waiting', waitsFor: ['cart-api'] })],
      }),
    );

    const handle = await manager.acquireForItem({ topic: { id: 'tp_checkout', slug: 'checkout' }, itemId: 'cart-api', owner: meiPrincipal });
    const dir = handle.root.realPath;
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const first = await manager.snapshot({ worktreeId: handle.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' });
    if (!first.ok) throw new Error('snapshot refused');
    // A draft nobody reviewed asks nothing of the host.
    expect(await mergeItems(host.conn)).toEqual([]);

    // "I've reviewed this": the draft is in the host's inbox by itself, and only there.
    manager.setReviewed(first.request.id, true);
    await waitFor(async () => (await mergeItems(host.conn)).length === 1, { what: 'the reviewed draft in the host\'s inbox' });
    expect(await mergeItems(host.conn)).toMatchObject([
      { key: `merge:${first.request.id}`, kind: 'merge', ready: true, conflict: false, topicId: 'tp_checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, unblocks: [2], target: { kind: 'changes', requestId: first.request.id } },
    ]);
    expect(await mergeItems(mei.conn)).toEqual([]);

    // The host changed the same line meanwhile: merging conflicts. The row stays, marked.
    await writeFile(join(d.root, 'src', 'app.ts'), 'export const answer = 7;\n');
    const git = (args: string[]) => promisify(execFile)('git', args, { cwd: d.root, env: isolatedGitEnv(join(d.stateDir, '..', '.git-home')) });
    await mkdir(join(d.stateDir, '..', '.git-home'), { recursive: true });
    await git(['commit', '-q', '-am', 'the host changed it too']);
    expect((await host.conn.request('worktree.merge.approve', { requestId: first.request.id })).request.status).toBe('conflict');
    await waitFor(async () => (await mergeItems(host.conn))[0]?.conflict === true, { what: 'the conflict in the host\'s inbox' });
    expect(await mergeItems(host.conn)).toMatchObject([{ key: `merge:${first.request.id}`, ready: false, conflict: true }]);

    // smurg merges, the "agent" resolves, the turn's snapshot replaces the conflicted request: it leaves the inbox
    // (the new draft is not reviewed yet).
    expect((await manager.updateFromMain(handle.worktree.id)).conflicted).toEqual(['src/app.ts']);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 50;\n');
    const second = await manager.snapshot({ worktreeId: handle.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' });
    if (!second.ok) throw new Error(`snapshot refused: ${second.reason}`);
    await waitFor(async () => (await mergeItems(host.conn)).length === 0, { what: 'the replaced request to leave the inbox' });
    // Reviewed again: ready again, under the new request.
    manager.setReviewed(second.request.id, true);
    await waitFor(async () => (await mergeItems(host.conn)).length === 1, { what: 'the new draft in the host\'s inbox' });
    expect(await mergeItems(host.conn)).toMatchObject([{ key: `merge:${second.request.id}`, ready: true, conflict: false, unblocks: [2] }]);

    // Merged: nothing waits for the host any more.
    expect((await host.conn.request('worktree.merge.approve', { requestId: second.request.id })).request.status).toBe('merged');
    await waitFor(async () => (await mergeItems(host.conn)).length === 0, { what: 'the merged request to leave the inbox' });
    expect(await readFile(join(d.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 50;\n');
  });
});
