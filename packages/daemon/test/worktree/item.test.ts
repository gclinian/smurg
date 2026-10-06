// A work item's worktree (ARCHITECTURE §5.10 "A work item's worktree", §7.8 "A conflict"; DESIGN §3.11, §4.7): created
// on smurg/<topic slug>/<item id>, the item's and not a session's, its topic's folder unwritable for people (S21), and
// the conflict path of T5.3: smurg merges the main workspace into it, the agent resolves, the next snapshot is a commit
// with two parents. Everything runs on plain git: no model, the "agent" is this test writing files.
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorktreeInfo } from '@smurg/protocol';
import { PathDeniedError } from '../../src/core/errors.ts';
import { fakesModule, fakesOf } from '../../src/core/fakes/index.ts';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { waitFor } from '../../src/testing/index.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';
import { restartDaemonWith } from './restart.ts';
import { settleError, startWorktreeStack, utf8, type WorktreeStack } from './support.ts';

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

async function itemStack(options: Parameters<typeof startWorktreeStack>[0] = {}): Promise<WorktreeStack> {
  stack = await startWorktreeStack({ files: FILES, ...options });
  await stack.connect('dev:mei', 'agent');
  return stack;
}

function acquire(s: WorktreeStack, itemId: string, owner = 'dev:mei') {
  return s.manager.acquireForItem({ topic: TOPIC, itemId, owner: s.principal(owner) });
}

describe('a work item\'s worktree', { timeout: 60_000 }, () => {
  it('is a clone on smurg/<topic slug>/<item id> at the main HEAD, registered with its item; a retry reuses it', async () => {
    const s = await itemStack();
    const seen: WorktreeInfo[] = [];
    s.host.conn.on('worktree.updated', (payload) => seen.push(payload.worktree));
    const handle = await acquire(s, 'cart-api');
    const dir = s.worktreeDir(handle.worktree.id);
    expect(handle.worktree).toMatchObject({ ownerUserId: 'dev:mei', ownerName: 'mei', branch: 'smurg/checkout/cart-api', kept: false, topicId: 'tp_checkout', itemId: 'cart-api' });
    expect(handle.worktree.sessionId).toBeUndefined();
    expect(handle.root).toMatchObject({ ref: { kind: 'worktree', worktreeId: handle.worktree.id }, realPath: dir, item: { topicId: 'tp_checkout', topicSlug: 'checkout', itemId: 'cart-api' } });
    expect((await s.git(['symbolic-ref', '--short', 'HEAD'], dir)).trim()).toBe('smurg/checkout/cart-api');
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe((await s.git(['rev-parse', 'HEAD'])).trim());
    // The spec and the plan the agent starts from are the committed ones.
    expect(await readFile(join(dir, 'specs', 'checkout', 'SPEC.md'), 'utf8')).toBe('# Checkout\n');
    await waitFor(() => seen.some((worktree) => worktree.id === handle.worktree.id), { what: 'worktree.updated' });
    expect((await s.host.conn.request('worktree.list', {})).worktrees).toEqual([handle.worktree]);
    const audit = await s.t.ctx.audit.query({ limit: 20 });
    expect(audit.find((entry) => entry.action === 'worktree.create')).toMatchObject({ outcome: 'ok', target: handle.worktree.id, actor: { userId: 'dev:mei' }, detail: { topicId: 'tp_checkout', itemId: 'cart-api', branch: 'smurg/checkout/cart-api' } });

    // A retry: the same worktree with the work that is in it, for whoever asks.
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const again = await acquire(s, 'cart-api', s.host.userId);
    expect(again.worktree).toEqual(handle.worktree);
    expect(await readFile(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(s.manager.list()).toHaveLength(1);
    // Another item of the topic, and the same item id in another topic, are worktrees of their own.
    const other = await acquire(s, 'payment-form');
    const elsewhere = await s.manager.acquireForItem({ topic: { id: 'tp_login', slug: 'login' }, itemId: 'cart-api', owner: s.principal('dev:mei') });
    expect(new Set([handle.worktree.id, other.worktree.id, elsewhere.worktree.id]).size).toBe(3);
    expect(elsewhere.worktree.branch).toBe('smurg/login/cart-api');
  });

  it('removes a result report that is already there: one committed earlier at creation, the one of the attempt before at a retry', async () => {
    const s = await itemStack({ files: { ...FILES, 'specs/checkout/reports/cart-api.md': '# planted before the start\n', 'specs/checkout/reports/other.md': '# another item\n' } });
    const handle = await acquire(s, 'cart-api');
    const dir = s.worktreeDir(handle.worktree.id);
    expect(await lstat(join(dir, 'specs', 'checkout', 'reports', 'cart-api.md')).catch(() => null)).toBeNull();
    // Only this item's report: the others' are part of the checkout.
    expect(await readFile(join(dir, 'specs', 'checkout', 'reports', 'other.md'), 'utf8')).toBe('# another item\n');
    // The main workspace keeps its file.
    expect(await readFile(join(s.t.root, 'specs', 'checkout', 'reports', 'cart-api.md'), 'utf8')).toBe('# planted before the start\n');

    await writeFile(join(dir, 'specs', 'checkout', 'reports', 'cart-api.md'), '# the first attempt\n');
    await acquire(s, 'cart-api');
    expect(await lstat(join(dir, 'specs', 'checkout', 'reports', 'cart-api.md')).catch(() => null)).toBeNull();
  });

  it('never removes a report through a link: a topic folder that is a link in the checkout fails the start closed', async () => {
    const s = await itemStack();
    const first = await acquire(s, 'cart-api');
    const dir = s.worktreeDir(first.worktree.id);
    // The reports folder swapped for a link to a folder outside the worktree that has a file of that name.
    const outside = join(s.t.root, 'outside-reports');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'cart-api.md'), 'not the daemon\'s to delete\n');
    await rm(join(dir, 'specs', 'checkout', 'reports'), { recursive: true, force: true });
    await symlink(outside, join(dir, 'specs', 'checkout', 'reports'));
    expect(await settleError(acquire(s, 'cart-api'))).toMatchObject({ code: 'conflict', reason: 'report-path-blocked' });
    expect(await readFile(join(outside, 'cart-api.md'), 'utf8')).toBe('not the daemon\'s to delete\n');
  });

  it('refuses ids that are not the protocol\'s forms (they become a ref name and a path)', async () => {
    const s = await itemStack();
    for (const [slug, itemId] of [['Check Out', 'a'], ['checkout', 'A/..'], ['checkout', '../x'], ['..', 'a'], ['checkout', '']] as const) {
      expect(await settleError(s.manager.acquireForItem({ topic: { id: 'tp_1', slug }, itemId, owner: s.principal('dev:mei') }))).toMatchObject({ code: 'bad_request', reason: 'bad-work-item' });
    }
    expect(s.manager.list()).toEqual([]);
  });

  it('does not count toward its owner\'s limit, but toward the workspace\'s (`mainState().free`)', async () => {
    const s = await itemStack({ module: { limits: { maxWorktreesPerOwner: 1, maxWorktrees: 4 } } });
    expect(await s.manager.mainState()).toMatchObject({ isRepo: true, hasCommit: true, gitOk: true, busy: false, free: 4 });
    await acquire(s, 'a');
    await acquire(s, 'b');
    // Mei's own session worktree: her first, whatever items she started.
    await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_1' });
    expect(await settleError(s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_2' }))).toMatchObject({ code: 'conflict', reason: 'worktree-limit-owner' });
    await acquire(s, 'c');
    expect((await s.manager.mainState()).free).toBe(0);
    expect(await settleError(acquire(s, 'd'))).toMatchObject({ code: 'conflict', reason: 'worktree-limit' });
    expect(s.manager.list().map((worktree) => worktree.itemId ?? 'session').sort()).toEqual(['a', 'b', 'c', 'session']);
  });

  it('S21 an Editor cannot write the spec copy or the report in an item worktree; code there stays writable', async () => {
    const s = await itemStack();
    const eddie = await s.connect('dev:eddie', 'editor');
    const handle = await acquire(s, 'cart-api');
    const root = handle.root.ref;
    for (const principal of [s.principal(eddie.userId), s.principal('dev:mei'), s.principal(s.host.userId)]) {
      for (const path of ['specs/checkout/SPEC.md', 'specs/checkout/PLAN.md', 'specs/checkout/reports/cart-api.md']) {
        const error = await s.t.ctx.paths.writeFileAtomic({ root, path }, utf8('planted\n'), { principal }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(PathDeniedError);
        expect((error as PathDeniedError).reason).toBe('read-only');
      }
      await s.t.ctx.paths.writeFileAtomic({ root, path: 'src/app.ts' }, utf8(`// by ${principal.userId}\n`), { principal });
    }
    const dir = s.worktreeDir(handle.worktree.id);
    expect(await readFile(join(dir, 'specs', 'checkout', 'SPEC.md'), 'utf8')).toBe('# Checkout\n');
    expect(await lstat(join(dir, 'specs', 'checkout', 'reports', 'cart-api.md')).catch(() => null)).toBeNull();
    // The daemon itself may (it removes a stale report); and a worktree that is no item's has no such rule.
    await mkdir(join(dir, 'specs', 'checkout', 'reports'), { recursive: true });
    await s.t.ctx.paths.writeFileAtomic({ root, path: 'specs/checkout/reports/cart-api.md' }, utf8('by the daemon\n'), { principal: SYSTEM_PRINCIPAL });
    const plain = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_plain' });
    await s.t.ctx.paths.writeFileAtomic({ root: plain.root.ref, path: 'specs/checkout/SPEC.md' }, utf8('a session worktree\n'), { principal: s.principal('dev:mei') });
  });

  it('outlives every session: no session\'s end removes it, `releaseItem` does (clone, root, its draft), once', async () => {
    const s = await itemStack();
    const handle = await acquire(s, 'cart-api');
    const id = handle.worktree.id;
    const dir = s.worktreeDir(id);
    // Whatever `keep` says, and for a session that never held it.
    await s.manager.releaseFromSession(id, 'ses_item', { keep: false });
    expect(s.manager.get(id)).not.toBeNull();
    // The owner may open a terminal in it; when that ends without keeping, the worktree is still the item's.
    const resumed = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_term', worktreeId: id });
    expect(resumed.worktree).toMatchObject({ sessionId: 'ses_term', itemId: 'cart-api', kept: false });
    await s.manager.releaseFromSession(id, 'ses_term', { keep: false });
    expect(s.manager.get(id)).toMatchObject({ itemId: 'cart-api', kept: false });
    expect(s.manager.get(id)?.sessionId).toBeUndefined();
    expect((await lstat(dir)).isDirectory()).toBe(true);

    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const snapshot = await s.manager.snapshot({ worktreeId: id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' });
    if (!snapshot.ok) throw new Error('snapshot refused');
    const removed: string[] = [];
    s.host.conn.on('worktree.removed', (payload) => removed.push(payload.worktreeId));
    const bus: (WorktreeInfo | null)[] = [];
    s.t.ctx.bus.on('worktree.changed', (event) => bus.push(event.worktree));

    await s.manager.releaseItem(id);
    expect(s.manager.get(id)).toBeNull();
    expect(await lstat(dir).catch(() => null)).toBeNull();
    expect(s.t.ctx.roots.get({ kind: 'worktree', worktreeId: id })).toBeNull();
    expect(bus).toEqual([null]);
    await waitFor(() => removed.includes(id), { what: 'worktree.removed' });
    // The draft was the daemon's snapshot of that working tree: gone with it, and its ref.
    expect(s.manager.listMerges(s.principal(s.host.userId))).toEqual([]);
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    expect((await s.t.ctx.audit.query({ limit: 20 })).find((entry) => entry.action === 'worktree.remove')).toMatchObject({ outcome: 'ok', target: id, actor: { kind: 'system' }, detail: { topicId: 'tp_checkout', itemId: 'cart-api' } });
    // Again is fine (archive after a merge already released it); a session's worktree is not released this way.
    await s.manager.releaseItem(id);
    const plain = await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_plain' });
    expect(await settleError(s.manager.releaseItem(plain.worktree.id))).toMatchObject({ code: 'bad_request', reason: 'not-an-item-worktree' });
  });

  it('a request somebody asked for stays decidable after `releaseItem` (its commit lives in the main repository)', async () => {
    const s = await itemStack();
    const mei = await s.connect('dev:mei', 'agent');
    const handle = await acquire(s, 'cart-api');
    await writeFile(join(s.worktreeDir(handle.worktree.id), 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await mei.conn.request('worktree.merge.request', { worktreeId: handle.worktree.id });
    expect(request).toMatchObject({ status: 'pending', topicId: 'tp_checkout', itemId: 'cart-api' });
    await s.manager.releaseItem(handle.worktree.id);
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
  });

  it('setOwner hands it over: the new owner is announced and may remove it, the former one may not', async () => {
    const s = await itemStack();
    const mei = await s.connect('dev:mei', 'agent');
    const handle = await acquire(s, 'cart-api');
    const id = handle.worktree.id;
    const seen: WorktreeInfo[] = [];
    s.host.conn.on('worktree.updated', (payload) => seen.push(payload.worktree));
    await s.manager.setOwner(id, s.principal(s.host.userId));
    expect(s.manager.get(id)).toMatchObject({ ownerUserId: s.host.userId, ownerName: 'Host', itemId: 'cart-api' });
    await waitFor(() => seen.some((worktree) => worktree.ownerUserId === s.host.userId), { what: 'worktree.updated with the new owner' });
    expect(await settleError(mei.conn.request('worktree.remove', { worktreeId: id }))).toMatchObject({ code: 'forbidden' });
    // The commit of its next snapshot is the new owner's.
    await writeFile(join(s.worktreeDir(id), 'src', 'app.ts'), 'export const answer = 43;\n');
    await s.manager.snapshot({ worktreeId: id, message: 'smurg: work item 1 (cart-api)' });
    expect((await s.git(['log', '-1', '--format=%an|%s'], s.worktreeDir(id))).trim()).toBe('Host|smurg: work item 1 (cart-api)');
    await s.host.conn.request('worktree.remove', { worktreeId: id });
    expect(s.manager.get(id)).toBeNull();
    expect(await settleError(s.manager.setOwner(id, s.principal(s.host.userId)))).toMatchObject({ code: 'not_found' });
  });

  it('`worktree.remove` is refused while a session of the item works in it', async () => {
    stack = await startWorktreeStack({ files: FILES, extraModules: [fakesModule({ except: ['worktrees'] })] });
    const s = stack;
    const mei = await s.connect('dev:mei', 'agent');
    const fakes = fakesOf(s.t.ctx);
    const handle = await acquire(s, 'cart-api');
    const session = await fakes.agents.start({
      purpose: 'item',
      topic: { ...TOPIC, name: 'Checkout' },
      item: { id: 'cart-api', number: 1, title: 'Cart API', attempt: 1 },
      openedBy: s.principal('dev:mei'),
      responsible: null,
      workspace: { mode: 'worktree', worktreeId: handle.worktree.id },
      mode: 'ask-commands',
      rolePrompt: () => 'prompt',
    });
    expect(await settleError(mei.conn.request('worktree.remove', { worktreeId: handle.worktree.id }))).toMatchObject({ code: 'conflict', reason: 'worktree-in-use' });
    await fakes.agents.end(session.id, { by: { kind: 'system' }, reason: 'stopped', keepWorktree: true });
    await mei.conn.request('worktree.remove', { worktreeId: handle.worktree.id });
    expect(s.manager.get(handle.worktree.id)).toBeNull();
  });

  it('survives a restart as the item\'s worktree: its root keeps the item, and what it holds is looked at again', async () => {
    const s = await itemStack();
    const handle = await acquire(s, 'cart-api');
    const clean = await acquire(s, 'clean');
    const id = handle.worktree.id;
    await s.manager.acquireForSession({ owner: s.principal('dev:mei'), sessionId: 'ses_term', worktreeId: id });
    await writeFile(join(s.worktreeDir(id), 'src', 'app.ts'), 'export const answer = 43;\n');
    await s.t.daemon.stop();

    const daemon = await restartDaemonWith(s.t);
    try {
      const manager = daemon.ctx.services.worktrees as WorktreeManagerImpl;
      // Not a "kept" worktree of a session that died: still the item's, without a session.
      expect(manager.get(id)).toEqual({ ...handle.worktree });
      expect(daemon.ctx.roots.get({ kind: 'worktree', worktreeId: id })?.item).toEqual({ topicId: 'tp_checkout', topicSlug: 'checkout', itemId: 'cart-api' });
      const mei = daemon.ctx.members.principalOf('dev:mei');
      if (mei === null) throw new Error('mei');
      await expect(daemon.ctx.paths.resolve({ root: handle.root.ref, path: 'specs/checkout/SPEC.md' }, { principal: mei, forWrite: true })).rejects.toBeInstanceOf(PathDeniedError);
      // Once the daemon has looked: the one with edits no snapshot has holds unmerged work, the untouched one does not.
      await manager.inspected();
      expect(manager.unmerged('tp_checkout').map((worktree) => worktree.itemId)).toEqual(['cart-api']);
      expect(manager.get(clean.worktree.id)).not.toBeNull();
    } finally {
      await daemon.stop();
    }
  });
});

describe('T5.3 a conflict between a work item and the main workspace', { timeout: 90_000 }, () => {
  /** Two items that change the same line; the first is merged, the second then conflicts. */
  async function conflictingPair(s: WorktreeStack): Promise<{ first: string; second: string; dir: string; conflictRequest: string; committed: string }> {
    const a = await acquire(s, 'cart-api');
    const b = await acquire(s, 'payment-form');
    await writeFile(join(s.worktreeDir(a.worktree.id), 'src', 'app.ts'), 'export const answer = 1;\n');
    await writeFile(join(s.worktreeDir(a.worktree.id), 'src', 'from-a.ts'), 'export const a = true;\n');
    const dir = s.worktreeDir(b.worktree.id);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 2;\n');
    await writeFile(join(dir, 'src', 'from-b.ts'), 'export const b = true;\n');
    const first = await s.manager.snapshot({ worktreeId: a.worktree.id, message: 'smurg: work item 1 (cart-api)', topicSlug: 'checkout' });
    const second = await s.manager.snapshot({ worktreeId: b.worktree.id, message: 'smurg: work item 2 (payment-form)', topicSlug: 'checkout' });
    if (!first.ok || !second.ok) throw new Error('snapshot refused');
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: first.request.id })).request.status).toBe('merged');
    const conflict = (await s.host.conn.request('worktree.merge.approve', { requestId: second.request.id })).request;
    expect(conflict).toMatchObject({ status: 'conflict', conflictFiles: ['src/app.ts'], itemId: 'payment-form' });
    return { first: a.worktree.id, second: b.worktree.id, dir, conflictRequest: second.request.id, committed: second.request.commit };
  }

  it('T5.3 a conflict is merged by smurg and resolved by the agent', async () => {
    const s = await itemStack();
    const { second, dir, conflictRequest, committed } = await conflictingPair(s);
    const mainHead = (await s.git(['rev-parse', 'HEAD'])).trim();

    // smurg merges: nobody's agent runs git.
    const update = await s.manager.updateFromMain(second);
    expect(update).toEqual({ mergeParent: mainHead, conflicted: ['src/app.ts'] });
    const merged = await readFile(join(dir, 'src', 'app.ts'), 'utf8');
    expect(merged).toContain('<<<<<<< ');
    expect(merged).toContain('export const answer = 2;');
    expect(merged).toContain('export const answer = 1;');
    expect(merged).toContain('>>>>>>> ');
    // What the main workspace gained without a conflict is simply there; the worktree's own work too.
    expect(await readFile(join(dir, 'src', 'from-a.ts'), 'utf8')).toBe('export const a = true;\n');
    expect(await readFile(join(dir, 'src', 'from-b.ts'), 'utf8')).toBe('export const b = true;\n');
    // git's own merge state is over (a session's `git status` shows no merge in progress); the branch did not move.
    expect(await lstat(join(dir, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe(committed);
    // The main workspace was not touched by any of it.
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(mainHead);

    // While a listed file still has a marker line, the working tree is not committed: not as a snapshot, not as a request.
    const refused = await s.manager.snapshot({ worktreeId: second, message: 'smurg: work item 2 (payment-form)', topicSlug: 'checkout' });
    expect(refused).toEqual({ ok: false, reason: 'conflict-markers', files: ['src/app.ts'] });
    const asked = await settleError(s.host.conn.request('worktree.merge.request', { worktreeId: second }));
    expect(asked).toMatchObject({ code: 'conflict', reason: 'conflict-markers', text: { id: 'report.changes.markers', params: { files: ['src/app.ts'] } } });
    expect(await settleError(s.manager.updateFromMain(second))).toMatchObject({ code: 'conflict', reason: 'conflict-markers' });
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe(committed);
    // Half resolved (one marker left) is still unresolved.
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 3;\n>>>>>>> leftover\n');
    expect(await s.manager.snapshot({ worktreeId: second, message: 'x', topicSlug: 'checkout' })).toMatchObject({ ok: false, reason: 'conflict-markers' });

    // The agent resolves (here: this test writes the file).
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 3;\n');
    const resolved = await s.manager.snapshot({ worktreeId: second, message: 'smurg: work item 2 (payment-form)', topicSlug: 'checkout' });
    if (!resolved.ok) throw new Error(`snapshot refused: ${resolved.reason}`);
    // A commit with TWO parents: the worktree's work and the main HEAD that was merged.
    expect((await s.git(['rev-list', '--parents', '-n', '1', resolved.request.commit], dir)).trim().split(' ')).toEqual([resolved.request.commit, committed, mainHead]);
    expect(resolved.request).toMatchObject({ status: 'draft', reviewed: false, itemId: 'payment-form', topicId: 'tp_checkout' });
    expect(resolved.request.id).not.toBe(conflictRequest);
    // It replaces the request that conflicted: the host has one thing to merge, not a stale conflict beside it.
    expect(s.manager.listMerges(s.principal(s.host.userId)).map((request) => [request.itemId, request.status]).sort()).toEqual([
      ['cart-api', 'merged'],
      ['payment-form', 'draft'],
    ]);
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: conflictRequest }))).toMatchObject({ code: 'not_found' });
    // What the host reviews is the item's own change against the main workspace as it is now.
    const review = await s.host.conn.request('worktree.merge.diff', { requestId: resolved.request.id });
    expect(review.files.map((file) => file.path).sort()).toEqual(['src/app.ts', 'src/from-b.ts']);
    expect(review.diff).toContain('-export const answer = 1;');
    expect(review.diff).toContain('+export const answer = 3;');

    // The host's trial merge is clean now.
    const { request: done } = await s.host.conn.request('worktree.merge.approve', { requestId: resolved.request.id });
    expect(done.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 3;\n');
    expect(await readFile(join(s.t.root, 'src', 'from-a.ts'), 'utf8')).toBe('export const a = true;\n');
    expect(await readFile(join(s.t.root, 'src', 'from-b.ts'), 'utf8')).toBe('export const b = true;\n');
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');
    // The merge state is spent: the next snapshot is an ordinary commit again.
    await writeFile(join(dir, 'src', 'from-b.ts'), 'export const b = false;\n');
    const later = await s.manager.snapshot({ worktreeId: second, message: 'smurg: work item 2 (payment-form)', topicSlug: 'checkout' });
    if (!later.ok) throw new Error('snapshot refused');
    expect((await s.git(['rev-list', '--parents', '-n', '1', later.request.commit], dir)).trim().split(' ')).toEqual([later.request.commit, resolved.request.commit]);
  });

  it('a conflict resolved by deleting the file, and a file that only one side changed, need no marker hunt', async () => {
    const s = await itemStack();
    const { second, dir, committed } = await conflictingPair(s);
    const mainHead = (await s.git(['rev-parse', 'HEAD'])).trim();
    expect((await s.manager.updateFromMain(second)).conflicted).toEqual(['src/app.ts']);
    await rm(join(dir, 'src', 'app.ts'));
    const resolved = await s.manager.snapshot({ worktreeId: second, message: 'smurg: work item 2 (payment-form)', topicSlug: 'checkout' });
    if (!resolved.ok) throw new Error(`snapshot refused: ${resolved.reason}`);
    expect((await s.git(['rev-list', '--parents', '-n', '1', resolved.request.commit], dir)).trim().split(' ')).toEqual([resolved.request.commit, committed, mainHead]);
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: resolved.request.id })).request.status).toBe('merged');
    expect(await lstat(join(s.t.root, 'src', 'app.ts')).catch(() => null)).toBeNull();
  });

  it('without a conflict the main workspace\'s changes arrive, and the next snapshot still records the second parent', async () => {
    const s = await itemStack();
    const a = await acquire(s, 'cart-api');
    const b = await acquire(s, 'payment-form');
    await writeFile(join(s.worktreeDir(a.worktree.id), 'src', 'other.ts'), 'export const other = 2;\n');
    const dir = s.worktreeDir(b.worktree.id);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 2;\n');
    const first = await s.manager.snapshot({ worktreeId: a.worktree.id, message: 'item a', topicSlug: 'checkout' });
    if (!first.ok) throw new Error('snapshot refused');
    await s.host.conn.request('worktree.merge.approve', { requestId: first.request.id });
    const mainHead = (await s.git(['rev-parse', 'HEAD'])).trim();

    // The worktree's uncommitted work is committed first (as its owner), then the main HEAD merged in.
    const update = await s.manager.updateFromMain(b.worktree.id);
    expect(update).toEqual({ mergeParent: mainHead, conflicted: [] });
    const work = (await s.git(['rev-parse', 'HEAD'], dir)).trim();
    expect((await s.git(['log', '-1', '--format=%an|%s'], dir)).trim()).toBe('mei|smurg: work before merging the main workspace');
    expect(await readFile(join(dir, 'src', 'other.ts'), 'utf8')).toBe('export const other = 2;\n');
    expect(await readFile(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 2;\n');
    expect(await lstat(join(dir, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
    // Asking again changes nothing (the same HEAD is merged already; its commit is still owed).
    const snapshot = await s.manager.snapshot({ worktreeId: b.worktree.id, message: 'item b', topicSlug: 'checkout' });
    if (!snapshot.ok) throw new Error('snapshot refused');
    expect((await s.git(['rev-list', '--parents', '-n', '1', snapshot.request.commit], dir)).trim().split(' ')).toEqual([snapshot.request.commit, work, mainHead]);
    // Only the item's own change is in its request.
    expect((await s.host.conn.request('worktree.merge.diff', { requestId: snapshot.request.id })).files.map((file) => file.path)).toEqual(['src/app.ts']);
    // Up to date now: another update merges nothing and owes no second parent.
    expect(await s.manager.updateFromMain(b.worktree.id)).toEqual({ mergeParent: mainHead, conflicted: [] });
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 4;\n');
    const next = await s.manager.snapshot({ worktreeId: b.worktree.id, message: 'item b', topicSlug: 'checkout' });
    if (!next.ok) throw new Error('snapshot refused');
    expect((await s.git(['rev-list', '--parents', '-n', '1', next.request.commit], dir)).trim().split(' ')).toHaveLength(2);
  });

  it('a merge git refuses (an ignored file of the worktree is in the way) leaves the working tree as it was', async () => {
    const s = await itemStack({ files: { ...FILES, '.gitignore': 'build/\n' } });
    const b = await acquire(s, 'payment-form');
    const dir = s.worktreeDir(b.worktree.id);
    await mkdir(join(dir, 'build'), { recursive: true });
    await writeFile(join(dir, 'build', 'out.js'), 'the worktree\'s own build output\n');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 2;\n');
    // The main workspace starts to track a file at that very path.
    await mkdir(join(s.t.root, 'build'), { recursive: true });
    await writeFile(join(s.t.root, 'build', 'out.js'), 'tracked in main now\n');
    await s.git(['add', '-f', 'build/out.js']);
    await s.git(['commit', '-q', '-m', 'track build output']);

    const refused = await settleError(s.manager.updateFromMain(b.worktree.id));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'merge-refused' });
    expect(refused?.detail?.['paths']).toEqual(['build/out.js']);
    expect(await readFile(join(dir, 'build', 'out.js'), 'utf8')).toBe('the worktree\'s own build output\n');
    expect(await readFile(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 2;\n');
    expect(await lstat(join(dir, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
    // No second parent is owed: the next snapshot is an ordinary commit of the worktree's work.
    const snapshot = await s.manager.snapshot({ worktreeId: b.worktree.id, message: 'item b', topicSlug: 'checkout' });
    if (!snapshot.ok) throw new Error('snapshot refused');
    expect((await s.git(['rev-list', '--parents', '-n', '1', snapshot.request.commit], dir)).trim().split(' ')).toHaveLength(2);
  });
});
