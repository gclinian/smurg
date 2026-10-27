// smurg merges a work item by itself (DESIGN 0.7.0 D7): `WorktreeManager.autoMerge`, the same body as the host's
// `approve`, on the host's standing consent. The REAL worktree module over scratch folders with the real git on PATH
// (2.42 or later; without one these tests say so and are skipped, loudly, never passed). U2's scripts and R-SAFE's
// resolve-over-person run are the model. What it holds:
//  - a clean merge: author the host, committer smurg, smurg's trailer, `auto: true`, `requestedBy` absent, the audit's
//    `worktree.merge.auto` with its consent and nothing of `approve`, the activity line, the merged request's diff as
//    in 0.6.0, the overlap since the item started;
//  - a conflict marks the request and says who changed the other side (a member's commit, one made outside smurg, a
//    work item's merge, a person's saved edit in smurg's own history from the activity log, a change nobody names);
//  - waits and holds as outcomes, nothing changed: the branch switched or detached, the checkpoint gone from the branch,
//    a git operation under way (smurg's own leftover named), an undo left unsettled, staged changes, a lock on the
//    request's own file (no snapshot, no trial), local changes, an untracked file in the way, the policy without the
//    host's waiver, smurg's own history changed;
//  - only a draft or a conflict nobody requested; "still in order" at entry and just before `git merge`; the branch
//    switched between the trial and the merge;
//  - a kill between `git merge` and its record, a merge smurg left half-done in its own history, the merge parent.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type MergeRequest } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { AutoMergeInput, AutoMergeOutcome } from '../../src/core/interfaces.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';
import { GIT_MIN_VERSION, findGit, gitVersionAtLeast, parseGitVersion } from '../../src/worktree/git.ts';
import { AUTO_MERGE_TRAILER } from '../../src/worktree/names.ts';
import { initialWorktreesDocument, worktreesDocumentSchema } from '../../src/worktree/store.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';
import { restartDaemonWith } from './restart.ts';
import { settleError, startWorktreeStack, type WorktreeStack, type WorktreeStackOptions } from './support.ts';

const run = promisify(execFile);

async function realGit(): Promise<string | null> {
  const path = await findGit(process.env['PATH']);
  if (path === null) return null;
  const out = await run(path, ['version']).then((result) => result.stdout, () => '');
  const version = parseGitVersion(out);
  return version !== null && gitVersionAtLeast(version, GIT_MIN_VERSION) ? path : null;
}
const GIT = await realGit();
if (GIT === null) console.warn(`[auto-merge] SKIPPED: these tests need git ${GIT_MIN_VERSION.join('.')} or later on PATH`);
const withGit = GIT === null ? describe.skip : describe;

let stack: WorktreeStack | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await stack?.cleanup();
  stack = null;
  for (const dir of dirs.splice(0)) await removeTempDir(dir).catch(() => {});
}, 60_000);

const TOPIC = { id: 'tp_checkout', slug: 'checkout' };
const FILES = {
  'README.md': '# demo\n',
  'src/app.ts': 'export const answer = 42;\n',
  'notes.txt': 'one\ntwo\nthree\n',
  'config.txt': 'title: Shop\nprice: 10\nfooter: (c) 2026\n',
  'specs/checkout/SPEC.md': '# Checkout\n',
  'specs/checkout/PLAN.md': '# Plan\n',
};

interface Item {
  readonly worktreeId: string;
  readonly dir: string;
  readonly request: MergeRequest;
}

async function folderStack(options: WorktreeStackOptions = {}): Promise<WorktreeStack> {
  stack = await startWorktreeStack({ files: FILES, extraModules: [locksModule], ...options });
  await stack.connect('dev:mei', 'agent');
  return stack;
}

async function hiddenStack(options: Omit<WorktreeStackOptions, 'git'> = {}): Promise<WorktreeStack> {
  stack = await startWorktreeStack({ git: false, files: FILES, extraModules: [locksModule], ...options });
  await stack.connect('dev:mei', 'agent');
  return stack;
}

function share(s: WorktreeStack): string {
  return s.t.ctx.roots.main.realPath;
}
function hiddenGit(s: WorktreeStack, ...args: string[]): Promise<string> {
  return s.git(['--git-dir', join(share(s), '.smurg', 'git'), '--work-tree', share(s), ...args]);
}
async function head(s: WorktreeStack): Promise<string> {
  return (await s.git(['rev-parse', 'HEAD'])).trim();
}
async function docOf(s: WorktreeStack) {
  return s.t.ctx.state.document('worktrees', worktreesDocumentSchema, initialWorktreesDocument);
}

/** A work item's worktree in which `write` does the agent's work, then the daemon's snapshot: a draft. */
async function itemDraft(s: WorktreeStack, itemId: string, write: (dir: string) => Promise<void>, owner = 'dev:mei'): Promise<Item> {
  const handle = await s.manager.acquireForItem({ topic: TOPIC, itemId, owner: s.principal(owner) });
  const dir = s.worktreeDir(handle.worktree.id);
  await write(dir);
  const snapshot = await s.manager.snapshot({ worktreeId: handle.worktree.id, message: `smurg: work item (${itemId})` });
  if (!snapshot.ok) throw new Error(`snapshot refused: ${snapshot.reason}`);
  return { worktreeId: handle.worktree.id, dir, request: snapshot.request };
}

/** The Start's pin of the folder's own git: the branch HEAD is on and its commit. */
async function folderPin(s: WorktreeStack): Promise<AutoMergeInput['pin']> {
  return { branch: (await s.git(['symbolic-ref', '--short', 'HEAD'])).trim(), commit: await head(s) };
}

function hostRef(s: WorktreeStack): { userId: string; displayName: string } {
  const host = s.t.ctx.members.get(s.host.userId);
  if (host === null) throw new Error('no host');
  return { userId: host.userId, displayName: host.displayName };
}

function autoMerge(s: WorktreeStack, requestId: string, pin: AutoMergeInput['pin'], options: { readonly stillInOrder?: () => boolean; readonly consent?: AutoMergeInput['consent'] } = {}): Promise<AutoMergeOutcome> {
  return s.manager.autoMerge({ requestId, host: hostRef(s), pin, consent: options.consent ?? 'host-setting', stillInOrder: options.stillInOrder ?? (() => true) });
}

async function storedMerge(s: WorktreeStack, requestId: string) {
  return (await docOf(s)).get().merges.find((merge) => merge.id === requestId);
}

async function audits(s: WorktreeStack, action: string) {
  return (await s.t.ctx.audit.query({ limit: 200 })).filter((entry) => entry.action === action);
}

/** A git on PATH that runs `hook` (a shell line) once, the first time it is asked for a `merge-tree`, when `flag` exists. */
async function gitWithHook(hook: string): Promise<{ readonly gitPath: string; readonly flag: string; readonly log: string }> {
  const bin = await createTempDir('auto-merge-git');
  dirs.push(bin);
  const flag = join(bin, 'armed');
  const log = join(bin, 'calls.log');
  const wrapper = join(bin, 'git');
  await writeFile(
    wrapper,
    `#!/bin/sh\nfor a in "$@"; do if [ "$a" = merge-tree ]; then echo merge-tree >> '${log}'; if [ -f '${flag}' ]; then rm -f '${flag}'; ${hook}; fi; fi; done\nexec '${GIT as string}' "$@"\n`,
    { mode: 0o755 },
  );
  return { gitPath: wrapper, flag, log };
}

// ---------------------------------------------------------------------------------------------------------------------

withGit('an automatic merge in the folder\'s own git', { timeout: 60_000 }, () => {
  it('merges a draft for the host: author the host, committer smurg, the trailer, auto, the audit with its consent, the activity line, the diff as in 0.6.0', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const vera = await s.connect('dev:vera', 'viewer');
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    // The main workspace moves on meanwhile.
    await writeFile(join(share(s), 'README.md'), '# demo (host edit)\n');
    await s.git(['commit', '-qam', 'host edit']);
    const before = await head(s);

    const outcome = await autoMerge(s, item.request.id, pin, { consent: 'update-default' });
    expect(outcome).toMatchObject({ kind: 'merged', files: 1, overlap: [], request: { id: item.request.id, status: 'merged', auto: true } });
    if (outcome.kind !== 'merged') return;
    expect(outcome.request.requestedBy).toBeUndefined();
    expect(outcome.mergeCommit).toBe(await head(s));
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(await readFile(join(share(s), 'README.md'), 'utf8')).toBe('# demo (host edit)\n');
    expect((await s.git(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').slice(1)).toEqual([before, item.request.commit]);
    expect((await s.git(['log', '-1', '--format=%an|%ae|%cn|%ce'])).trim()).toBe(`${hostRef(s).displayName}|dev-host@users.smurg.invalid|smurg|daemon@smurg.invalid`);
    // 0.6.0's message (the branch, whose work, the snapshot's words) with smurg's trailer as its last paragraph.
    expect((await s.git(['log', '-1', '--format=%B'])).trim()).toBe(`Merge smurg/checkout/cart-api (mei)\n\nsmurg: work item (cart-api)\n\n${AUTO_MERGE_TRAILER}`);
    expect((await s.git(['log', '-1', '--format=%(trailers:key=Merged-by,valueonly)'])).trim()).toBe("smurg (automatic merging, the host's setting)");
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    expect(await storedMerge(s, item.request.id)).toMatchObject({ status: 'merged', auto: true, mergeCommit: outcome.mergeCommit });
    expect((await storedMerge(s, item.request.id))?.requestedBy).toBeUndefined();

    // The audit says smurg merged it on the host's behalf, with which consent; no `approve` entry at all.
    const entries = await audits(s, 'worktree.merge.auto');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: { kind: 'system' },
      outcome: 'ok',
      target: item.request.id,
      detail: { requestId: item.request.id, worktreeId: item.worktreeId, commit: item.request.commit, mergeCommit: outcome.mergeCommit, topicId: 'tp_checkout', itemId: 'cart-api', files: 1, consent: 'update-default', onBehalfOf: s.host.userId, overlap: [] },
    });
    expect(await audits(s, 'worktree.merge.approve')).toEqual([]);

    // Everyone's activity feed: smurg's own line, naming whose work item it was.
    const events = (await vera.conn.request('activity.list', {})).events.filter((event) => event.kind === 'merge');
    expect(events.map((event) => [event.actor.kind, event.text])).toEqual([['system', msg('activity.mergeAuto', { item: 'cart-api', starter: 'mei' })]]);

    // The merged request's diff is what it was in 0.6.0: the item's change against the main workspace it was merged into.
    const diff = await vera.conn.request('worktree.merge.diff', { requestId: item.request.id });
    expect(diff.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(diff.diff).toContain('+export const answer = 43;');

    // Merged once: a second try is not smurg's any more, and the host's approve says so as in 0.6.0.
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'gone' });
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: item.request.id }))).toMatchObject({ code: 'conflict', reason: 'not-pending' });
  });

  it('records the paths both sides changed since the item started (the overlap), never a reason to wait', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'notes', async (dir) => {
      await writeFile(join(dir, 'notes.txt'), 'one\ntwo\nthree (item)\n');
      await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    });
    await writeFile(join(share(s), 'notes.txt'), 'one (host)\ntwo\nthree\n');
    await s.git(['commit', '-qam', 'host edits the first line']);
    const outcome = await autoMerge(s, item.request.id, pin);
    expect(outcome).toMatchObject({ kind: 'merged', overlap: ['notes.txt'] });
    expect(await readFile(join(share(s), 'notes.txt'), 'utf8')).toBe('one (host)\ntwo\nthree (item)\n');
    expect((await audits(s, 'worktree.merge.auto'))[0]?.detail).toMatchObject({ overlap: ['notes.txt'] });
  });

  it('a conflict marks the request (nobody asked for it, so it stays smurg\'s) and audits it as smurg\'s try, not an approve; the main workspace is untouched', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'notes', (dir) => writeFile(join(dir, 'notes.txt'), 'one\ntwo (item)\nthree\n'));
    await writeFile(join(share(s), 'notes.txt'), 'one\ntwo (outside)\nthree\n');
    await s.git(['commit', '-qam', 'a commit made outside smurg']);
    const pre = await head(s);
    const outcome = await autoMerge(s, item.request.id, pin);
    expect(outcome).toMatchObject({ kind: 'conflict', paths: ['notes.txt'], request: { status: 'conflict', conflictFiles: ['notes.txt'] } });
    if (outcome.kind !== 'conflict') return;
    expect(outcome.request.requestedBy).toBeUndefined();
    // The other side is a commit whose author is nobody smurg knows: a change made outside smurg.
    expect(outcome.people).toEqual([{ path: 'notes.txt', by: [], outside: true }]);
    expect(await head(s)).toBe(pre);
    expect((await s.git(['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('');
    expect(await readFile(join(share(s), 'notes.txt'), 'utf8')).toBe('one\ntwo (outside)\nthree\n');
    expect((await audits(s, 'worktree.merge.auto')).map((entry) => [entry.outcome, entry.detail?.['reason']])).toEqual([['error', 'conflict']]);
    expect(await audits(s, 'worktree.merge.approve')).toEqual([]);
    // A conflict nobody requested is still smurg's to try (after the item's agent brought it up to date, D8).
    expect(await autoMerge(s, item.request.id, pin)).toMatchObject({ kind: 'conflict' });
  });

  it('who changed the other side: a member\'s commit names the member; a work item\'s merge, by smurg or by the host, is nobody\'s change', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const host = hostRef(s);
    // A commit smurg wrote for a member (the address of smurg's form) is that member's.
    const first = await itemDraft(s, 'first', (dir) => writeFile(join(dir, 'notes.txt'), 'one\ntwo (first)\nthree\n'));
    await writeFile(join(share(s), 'notes.txt'), 'one\ntwo (host)\nthree\n');
    await s.git(['commit', '-qam', 'the host, through smurg', `--author=${host.displayName} <dev-host@users.smurg.invalid>`]);
    expect(await autoMerge(s, first.request.id, pin)).toMatchObject({ kind: 'conflict', people: [{ path: 'notes.txt', by: [host], outside: false }] });

    // Two items change the same line: the second one's other side is the first one's merge, made by smurg...
    const pin2 = await folderPin(s);
    const a = await itemDraft(s, 'item-a', (dir) => writeFile(join(dir, 'config.txt'), 'title: Shop\nprice: 12\nfooter: (c) 2026\n'));
    const b = await itemDraft(s, 'item-b', (dir) => writeFile(join(dir, 'config.txt'), 'title: Shop\nprice: 14\nfooter: (c) 2026\n'));
    const c = await itemDraft(s, 'item-c', (dir) => writeFile(join(dir, 'config.txt'), 'title: Shop\nprice: 16\nfooter: (c) 2026\n'));
    expect(await autoMerge(s, a.request.id, pin2)).toMatchObject({ kind: 'merged' });
    expect(await autoMerge(s, b.request.id, pin2)).toMatchObject({ kind: 'conflict', paths: ['config.txt'], people: [] });
    // ...or by the host's own approve.
    const d = await itemDraft(s, 'item-d', (dir) => writeFile(join(dir, 'README.md'), '# demo (item d)\n'));
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: d.request.id })).request.status).toBe('merged');
    expect(await autoMerge(s, c.request.id, pin2)).toMatchObject({ kind: 'conflict', paths: ['config.txt'], people: [] });
  });
});

withGit('what an automatic merge waits for, or holds for the host, with nothing changed', { timeout: 60_000 }, () => {
  it('the main workspace on another branch, or detached, or without the Start\'s checkpoint: held (branch), nothing merged anywhere', async () => {
    const s = await folderStack();
    // The Start's checkpoint is a commit of its own (the second of the branch).
    await writeFile(join(share(s), 'specs', 'checkout', 'PLAN.md'), '# Plan, confirmed\n');
    await s.git(['commit', '-qam', 'smurg: start checkout']);
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    await s.git(['checkout', '-q', '-b', 'experiment']);
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'branch', expected: pin.branch, current: 'experiment' });
    expect(await head(s)).toBe(pin.commit);
    await s.git(['checkout', '-q', '--detach']);
    const short = (await s.git(['rev-parse', '--short', 'HEAD'])).trim();
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'branch', expected: pin.branch, current: short });
    // Back on the branch, but the branch no longer holds the Start's checkpoint.
    await s.git(['checkout', '-q', pin.branch as string]);
    await s.git(['reset', '-q', '--hard', 'HEAD~1']);
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'branch', expected: pin.branch, current: pin.branch });
    expect(await storedMerge(s, item.request.id)).toMatchObject({ status: 'draft' });
    expect((await s.git(['log', '--all', '--merges', '--format=%H'])).trim()).toBe('');
  });

  it('a git operation under way: smurg waits; a merge smurg itself left half-done is named as smurg\'s, never touched; the host is told as in 0.6.0', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    await mkdir(join(share(s), '.git', 'rebase-merge'));
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'wait', reason: 'git-busy', marker: 'rebase-merge' });
    await rm(join(share(s), '.git', 'rebase-merge'), { recursive: true, force: true });
    // smurg's own merge of this request, stopped half-way (what a kill inside `git merge` leaves).
    await s.git(['merge', '--no-commit', '--no-ff', '-m', `Merge smurg/checkout/cart-api (mei)\n\n${AUTO_MERGE_TRAILER}`, item.request.commit]);
    const busy = await autoMerge(s, item.request.id, pin);
    expect(busy).toEqual({ kind: 'wait', reason: 'git-busy', marker: 'MERGE_HEAD', smurgMerge: { commit: item.request.commit, requestId: item.request.id, topicId: 'tp_checkout', itemId: 'cart-api' } });
    expect((await readFile(join(share(s), '.git', 'MERGE_HEAD'), 'utf8')).trim()).toBe(item.request.commit);
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: item.request.id }))).toMatchObject({ code: 'conflict', reason: 'main-busy' });
    // The host's own merge under way is not named as smurg's.
    await s.git(['merge', '--abort']);
    await s.git(['merge', '--no-commit', '--no-ff', '-m', 'the host merges something', item.request.commit]);
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'wait', reason: 'git-busy', marker: 'MERGE_HEAD' });
    await s.git(['merge', '--abort']);
    // An undo the start could not settle (DESIGN 0.7.0 D14 case d) holds every automatic merge.
    const doc = await docOf(s);
    doc.update((draft) => {
      draft.undo = { requestIds: [item.request.id], pre: pin.commit, target: pin.commit, at: 1 };
    });
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'undo-interrupted' });
    doc.update((draft) => {
      delete draft.undo;
    });
    expect(await autoMerge(s, item.request.id, pin)).toMatchObject({ kind: 'merged' });
  });

  it('staged changes: smurg holds it for the host, and the host\'s approve says so instead of "the merge failed"', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    await writeFile(join(share(s), 'README.md'), '# demo, staged by the host\n');
    await s.git(['add', 'README.md']);
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'staged' });
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: item.request.id }))).toMatchObject({ code: 'conflict', reason: 'staged', text: { id: 'merge.staged' } });
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('M  README.md');
    expect(await storedMerge(s, item.request.id)).toMatchObject({ status: 'draft' });
    await s.git(['restore', '--staged', 'README.md']);
    expect(await autoMerge(s, item.request.id, pin)).toMatchObject({ kind: 'merged' });
    // The host's unstaged edit is still there.
    expect(await readFile(join(share(s), 'README.md'), 'utf8')).toBe('# demo, staged by the host\n');
  });

  it('local changes in a file it touches, an untracked file where it adds one: held for the host with the paths, nothing overwritten, the request not marked', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'cart-api', async (dir) => {
      await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
      await writeFile(join(dir, 'brand-new.txt'), 'from the item\n');
    });
    await writeFile(join(share(s), 'src', 'app.ts'), 'export const answer = 42; // a teammate typing\n');
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'local-changes', paths: ['src/app.ts'] });
    await s.git(['checkout', '--', 'src/app.ts']);
    await writeFile(join(share(s), 'brand-new.txt'), 'the host\'s own, untracked\n');
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'in-the-way', paths: ['brand-new.txt'] });
    expect(await readFile(join(share(s), 'brand-new.txt'), 'utf8')).toBe('the host\'s own, untracked\n');
    expect(await storedMerge(s, item.request.id)).toMatchObject({ status: 'draft' });
    expect(await head(s)).toBe(pin.commit);
  });

  it('the policy is a member\'s request\'s, also for a request the host once made: host-only paths are held for the host', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const handle = await s.manager.acquireForItem({ topic: TOPIC, itemId: 'cart-api', owner: s.principal('dev:mei') });
    const dir = s.worktreeDir(handle.worktree.id);
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'settings.json'), '{"hooks":{}}\n');
    // The host's own request passes the policy (the host merges it)...
    const request = await s.manager.requestMerge({ worktreeId: handle.worktree.id }, s.principal(s.host.userId));
    expect(request.status).toBe('pending');
    // ...and smurg never merges what someone requested.
    expect(await autoMerge(s, request.id, pin)).toEqual({ kind: 'gone' });
    // A stored draft of that commit (a hand-edited store, an earlier version): smurg checks it without the waiver.
    (await docOf(s)).update((draft) => {
      const merge = draft.merges.find((candidate) => candidate.id === request.id);
      if (merge === undefined) throw new Error('no request');
      merge.status = 'draft';
      delete merge.requestedBy;
    });
    expect(await autoMerge(s, request.id, pin)).toEqual({ kind: 'hold', reason: 'policy', paths: ['.claude/settings.json'] });
    expect((await audits(s, 'worktree.merge.auto')).map((entry) => [entry.outcome, entry.detail?.['reason']])).toEqual([['denied', 'host-only-paths']]);
    expect(await head(s)).toBe(pin.commit);
  });

  it('only a draft or a conflict nobody requested: a pending request and a conflict that keeps its requester are gone, untouched', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'notes', (dir) => writeFile(join(dir, 'notes.txt'), 'one\ntwo (item)\nthree\n'));
    const pending = await s.manager.requestMerge({ worktreeId: item.worktreeId }, s.principal('dev:mei'));
    expect(pending).toMatchObject({ id: item.request.id, status: 'pending' });
    expect(await autoMerge(s, pending.id, pin)).toEqual({ kind: 'gone' });
    await writeFile(join(share(s), 'notes.txt'), 'one\ntwo (host)\nthree\n');
    await s.git(['commit', '-qam', 'host']);
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: pending.id })).request).toMatchObject({ status: 'conflict', requestedBy: { userId: 'dev:mei' } });
    expect(await autoMerge(s, pending.id, pin)).toEqual({ kind: 'gone' });
    expect(await storedMerge(s, pending.id)).toMatchObject({ status: 'conflict', requestedBy: { userId: 'dev:mei' } });
    expect(await audits(s, 'worktree.merge.auto')).toEqual([]);
    // A request that is not a work item's is never smurg's.
    expect(await autoMerge(s, 'mr_000000000000000000000000', pin)).toEqual({ kind: 'gone' });
  });

  it('"still in order" is asked at entry and again just before git merge: either answer no and nothing is merged or marked', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    let asked = 0;
    expect(await autoMerge(s, item.request.id, pin, { stillInOrder: () => (asked += 1) < 1 })).toEqual({ kind: 'gone' });
    expect(asked).toBe(1);
    // In order when the queue reached it, no longer after the trial (a Pause, a follow-up landed meanwhile).
    asked = 0;
    expect(await autoMerge(s, item.request.id, pin, { stillInOrder: () => (asked += 1) < 2 })).toEqual({ kind: 'gone' });
    expect(asked).toBe(2);
    expect(await head(s)).toBe(pin.commit);
    expect(await storedMerge(s, item.request.id)).toMatchObject({ status: 'draft' });
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect(await audits(s, 'worktree.merge.auto')).toEqual([]);
  });
});

withGit('between the trial and the merge, and after a crash', { timeout: 60_000 }, () => {
  it('the host switches branches after the trial and before the merge: smurg tries again later, nothing lands on the new branch', async () => {
    const hook = await gitWithHook(`'${GIT as string}' --git-dir="$(cat "$0.share")/.git" --work-tree="$(cat "$0.share")" checkout -q -b experiment >/dev/null 2>&1`);
    const s = await folderStack({ module: { gitPath: hook.gitPath } });
    await writeFile(`${hook.gitPath}.share`, share(s));
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    await writeFile(hook.flag, '');
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'wait', reason: 'retry' });
    expect((await s.git(['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('experiment');
    expect((await s.git(['rev-parse', 'experiment'])).trim()).toBe(pin.commit);
    expect((await s.git(['log', '--all', '--merges', '--format=%H'])).trim()).toBe('');
    expect(await storedMerge(s, item.request.id)).toMatchObject({ status: 'draft' });
    // Back on the Start's branch: merged there.
    await s.git(['checkout', '-q', pin.branch as string]);
    expect(await autoMerge(s, item.request.id, pin)).toMatchObject({ kind: 'merged' });
    expect((await s.git(['rev-parse', 'experiment'])).trim()).toBe(pin.commit);
  });

  it('a kill between git merge and its record: the next try finds it merged already and records it, with its merge commit', async () => {
    const s = await folderStack();
    const pin = await folderPin(s);
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    await s.git(['merge', '-q', '--no-ff', '-m', `Merge smurg/checkout/cart-api (mei)\n\n${AUTO_MERGE_TRAILER}`, item.request.commit]);
    const merged = await head(s);
    const outcome = await autoMerge(s, item.request.id, pin);
    expect(outcome).toMatchObject({ kind: 'merged', mergeCommit: merged, request: { status: 'merged', auto: true } });
    expect(await head(s)).toBe(merged);
    expect(await storedMerge(s, item.request.id)).toMatchObject({ status: 'merged', auto: true, mergeCommit: merged });
  });

  it('the merge parent an update from the main workspace recorded, until the next snapshot commits it', async () => {
    const s = await folderStack();
    const item = await itemDraft(s, 'notes', (dir) => writeFile(join(dir, 'notes.txt'), 'one\ntwo (item)\nthree\n'));
    expect(s.manager.pendingMergeParent(item.worktreeId)).toBeNull();
    await writeFile(join(share(s), 'notes.txt'), 'one\ntwo (host)\nthree\n');
    await s.git(['commit', '-qam', 'host']);
    const update = await s.manager.updateFromMain(item.worktreeId);
    expect(update.conflicted).toEqual(['notes.txt']);
    expect(s.manager.pendingMergeParent(item.worktreeId)).toBe(update.mergeParent);
    await writeFile(join(item.dir, 'notes.txt'), 'one\ntwo (both)\nthree\n');
    const snapshot = await s.manager.snapshot({ worktreeId: item.worktreeId, message: 'resolved' });
    expect(snapshot.ok).toBe(true);
    expect(s.manager.pendingMergeParent(item.worktreeId)).toBeNull();
    expect(s.manager.pendingMergeParent('wt_000000000000000000000000')).toBeNull();
  });
});

withGit('an automatic merge in smurg\'s own history', { timeout: 60_000 }, () => {
  it('a person\'s saved edit since the item\'s base stays, the item\'s change is merged, smurg is the committer', async () => {
    const s = await hiddenStack();
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    const pin = { commit: (await hiddenGit(s, 'rev-parse', 'HEAD')).trim() };
    await writeFile(join(share(s), 'README.md'), '# demo, edited by Amy\n');
    const outcome = await autoMerge(s, item.request.id, pin);
    expect(outcome).toMatchObject({ kind: 'merged', request: { status: 'merged', auto: true } });
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(await readFile(join(share(s), 'README.md'), 'utf8')).toBe('# demo, edited by Amy\n');
    expect((await hiddenGit(s, 'log', '-1', '--format=%cn|%B')).trim()).toBe(`smurg|Merge smurg/checkout/cart-api (mei)\n\nsmurg: work item (cart-api)\n\n${AUTO_MERGE_TRAILER}`);
    expect((await audits(s, 'worktree.merge.auto'))[0]).toMatchObject({ outcome: 'ok', detail: { history: 'smurg', consent: 'host-setting' } });
  });

  it('someone typing in a file of the request: smurg waits without a snapshot or a trial, and merges once the lock is gone', async () => {
    const hook = await gitWithHook('true');
    const s = await hiddenStack({ module: { gitPath: hook.gitPath } });
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    const pin = { commit: (await hiddenGit(s, 'rev-parse', 'HEAD')).trim() };
    const amy = { userId: 'dev:amy', displayName: 'Amy' };
    expect(s.t.ctx.services.locks.touchHuman({ root: MAIN_ROOT, path: 'src/app.ts' }, amy).ok).toBe(true);
    await writeFile(join(share(s), 'README.md'), '# demo, typed meanwhile\n');
    const hiddenHead = (await hiddenGit(s, 'rev-parse', 'HEAD')).trim();
    const trials = async (): Promise<number> => (await readFile(hook.log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    const before = await trials();
    const waiting = await autoMerge(s, item.request.id, pin);
    expect(waiting).toMatchObject({ kind: 'wait', reason: 'typing', paths: ['src/app.ts'], lock: { kind: 'human' } });
    // No hidden commit of what was typed, no trial.
    expect((await hiddenGit(s, 'rev-parse', 'HEAD')).trim()).toBe(hiddenHead);
    expect(await trials()).toBe(before);
    s.t.ctx.services.locks.leaveHuman({ root: MAIN_ROOT, path: 'src/app.ts' }, amy.userId, 'closed');
    expect(await autoMerge(s, item.request.id, pin)).toMatchObject({ kind: 'merged' });
    expect(await trials()).toBe(before + 1);
  });

  it('who changed the other side: a person\'s saved edit is named from the activity log (R-SAFE\'s resolve-over-person setup), and nothing merges', async () => {
    const s = await hiddenStack();
    await s.connect('dev:bo', 'editor');
    const item = await itemDraft(s, 'price', (dir) => writeFile(join(dir, 'config.txt'), 'title: Shop\nprice: 12\nfooter: (c) 2026\n'));
    const pin = { commit: (await hiddenGit(s, 'rev-parse', 'HEAD')).trim() };
    // Bo sets the price in the web editor while the item runs: saved, recorded in the activity log.
    await writeFile(join(share(s), 'config.txt'), 'title: Shop\nprice: 15 (Bo: agreed with the client)\nfooter: (c) 2026\n');
    const bo = { userId: 'dev:bo', displayName: 'Bo' };
    s.t.ctx.services.activity.record({ actor: { kind: 'user', ...bo }, kind: 'human.edit', file: { root: MAIN_ROOT, path: 'config.txt' }, text: msg('activity.humanEdit', { name: 'Bo', path: 'config.txt' }) });
    const outcome = await autoMerge(s, item.request.id, pin);
    expect(outcome).toMatchObject({ kind: 'conflict', paths: ['config.txt'], people: [{ path: 'config.txt', by: [bo], outside: false }] });
    expect(await readFile(join(share(s), 'config.txt'), 'utf8')).toBe('title: Shop\nprice: 15 (Bo: agreed with the client)\nfooter: (c) 2026\n');

    // A change nobody in the log made (an outside program): outside, named by nobody.
    const other = await itemDraft(s, 'title', (dir) => writeFile(join(dir, 'notes.txt'), 'one (item)\ntwo\nthree\n'));
    await writeFile(join(share(s), 'notes.txt'), 'one (an editor outside smurg)\ntwo\nthree\n');
    expect(await autoMerge(s, other.request.id, pin)).toMatchObject({ kind: 'conflict', people: [{ path: 'notes.txt', by: [], outside: true }] });
  });

  it('the base its review recorded moved: held for the host (smurg\'s own history changed), nothing merged', async () => {
    const s = await hiddenStack();
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    const pin = { commit: (await hiddenGit(s, 'rev-parse', 'HEAD')).trim() };
    // Some other commit of the history as the recorded base.
    const elsewhere = (await hiddenGit(s, 'commit-tree', '-m', 'elsewhere', (await hiddenGit(s, 'rev-parse', 'HEAD^{tree}')).trim())).trim();
    (await docOf(s)).update((draft) => {
      const merge = draft.merges.find((candidate) => candidate.id === item.request.id);
      if (merge !== undefined) merge.base = elsewhere;
    });
    expect(await autoMerge(s, item.request.id, pin)).toEqual({ kind: 'hold', reason: 'history-changed' });
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
  });

  it('a merge a crash left half-done in smurg\'s own history is aborted before the first command of the next run, and audited', async () => {
    const s = await hiddenStack();
    const item = await itemDraft(s, 'cart-api', (dir) => writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n'));
    const pin = { commit: (await hiddenGit(s, 'rev-parse', 'HEAD')).trim() };
    // What a kill inside smurg's `git merge` leaves: MERGE_HEAD, the change staged, the file written.
    await hiddenGit(s, 'merge', '--no-commit', '--no-ff', '-m', `Merge smurg/checkout/cart-api (mei)\n\n${AUTO_MERGE_TRAILER}`, item.request.commit);
    expect(await readFile(join(share(s), '.smurg', 'git', 'MERGE_HEAD'), 'utf8')).toContain(item.request.commit);
    await s.t.daemon.stop();
    const daemon = await restartDaemonWith(s.t, [locksModule, createWorktreeModule()]);
    try {
      const manager = daemon.ctx.services.worktrees as WorktreeManagerImpl;
      const host = daemon.ctx.members.get(daemon.ctx.members.hostUserId());
      if (host === null) throw new Error('no host');
      const outcome = await manager.autoMerge({ requestId: item.request.id, host: { userId: host.userId, displayName: host.displayName }, pin, consent: 'host-setting', stillInOrder: () => true });
      expect(outcome).toMatchObject({ kind: 'merged' });
      expect(await readFile(join(share(s), '.smurg', 'git', 'MERGE_HEAD'), 'utf8').catch(() => null)).toBeNull();
      expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
      const recovered = (await daemon.ctx.audit.query({ limit: 100 })).filter((entry) => entry.detail?.['reason'] === 'recovered-after-crash');
      expect(recovered).toMatchObject([{ action: 'worktree.merge.auto', outcome: 'error', actor: { kind: 'system' }, detail: { marker: 'MERGE_HEAD', aborted: true, history: 'smurg' } }]);
    } finally {
      await daemon.stop();
    }
  });
});
