// The host's undo (DESIGN 0.7.0 D14): `WorktreeManager.undoPreview` / `undo` of the REAL worktree module over scratch
// folders with the real git on PATH (2.42 or later; without one these tests say so and are skipped, loudly, never
// passed). U2's scripts (exp1, exp3, exp5, exp6) and R-SAFE's undo-order.sh are the model. What it holds:
//  - one item taken back in ONE commit (author and committer the host, git's own words naming the merge), its report
//    kept, a host's commit elsewhere kept; the whole topic newest first; what is built on it goes with it; a later merge
//    of another topic on the same lines goes with it, one on other lines of the same file does not;
//  - what stops it, named, with nothing changed: a person's later commit on those lines (a member by name, one made
//    outside smurg as such), an uncommitted edit, someone typing, staged changes, a git operation under way, another
//    branch; an earlier item's merge on the same lines is nobody's change; git's own refusal of a file edited between
//    the look and the apply;
//  - smurg's own history: the folder is recorded FIRST, so a person's saved edit nobody recorded yet (in an untouched
//    file, on an untouched line of a touched file) stays and the undo commit changes only the item's file (R-SAFE S1);
//    who changed the lines is named from the activity log; an unrelated saved edit changes nothing of what it does;
//  - a merge with no recorded commit is found by its second parent;
//  - a crash: after the commit and before its record (recorded at the next start); between `read-tree -m -u` and the
//    commit in both histories (smurg's own finishes it, also with a person's edit meanwhile, which stays; the
//    folder's own git commits case b, holds every merge while the folder is between the two, and goes on once the
//    host put the files back).
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type MergeRequest } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { AutoMergeInput, UndoAsk, UndoFacts, UndoItemKey, WorktreeManager } from '../../src/core/interfaces.ts';
import { locksModule } from '../../src/locks/module.ts';
import { GIT_MIN_VERSION, findGit, gitVersionAtLeast, parseGitVersion } from '../../src/worktree/git.ts';
import { initialWorktreesDocument, worktreesDocumentSchema } from '../../src/worktree/store.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import { HIDDEN_UNDO_MESSAGE } from '../../src/worktree/undo.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';
import { restartDaemonWith } from './restart.ts';
import { settleError, startWorktreeStack, type WorktreeStack } from './support.ts';

const run = promisify(execFile);

async function realGit(): Promise<string | null> {
  const path = await findGit(process.env['PATH']);
  if (path === null) return null;
  const out = await run(path, ['version']).then((result) => result.stdout, () => '');
  const version = parseGitVersion(out);
  return version !== null && gitVersionAtLeast(version, GIT_MIN_VERSION) ? path : null;
}
const GIT = await realGit();
if (GIT === null) console.warn(`[undo] SKIPPED: these tests need git ${GIT_MIN_VERSION.join('.')} or later on PATH`);
const withGit = GIT === null ? describe.skip : describe;

let stack: WorktreeStack | null = null;
afterEach(async () => {
  await stack?.cleanup();
  stack = null;
}, 60_000);

const CHECKOUT = { id: 'tp_checkout', slug: 'checkout' };
const FRONT = { id: 'tp_front', slug: 'front' };
const lines = (prefix: string, count: number): string => Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}\n`).join('');
const FILES = {
  'a.txt': lines('a', 10),
  'b.txt': 'b notes\n',
  'c.txt': lines('c', 3),
  'README.md': '# demo\n',
  'specs/checkout/SPEC.md': '# Checkout\n',
  'specs/checkout/PLAN.md': '# Plan\n',
  'specs/front/SPEC.md': '# Front\n',
  'specs/front/PLAN.md': '# Plan\n',
};

async function folderStack(): Promise<WorktreeStack> {
  stack = await startWorktreeStack({ files: FILES, extraModules: [locksModule] });
  await stack.connect('dev:mei', 'agent');
  await stack.connect('dev:bo', 'editor');
  return stack;
}
async function hiddenStack(): Promise<WorktreeStack> {
  stack = await startWorktreeStack({ git: false, files: FILES, extraModules: [locksModule] });
  await stack.connect('dev:mei', 'agent');
  await stack.connect('dev:bo', 'editor');
  return stack;
}

const share = (s: WorktreeStack): string => s.t.ctx.roots.main.realPath;
const read = (s: WorktreeStack, path: string): Promise<string> => readFile(join(share(s), path), 'utf8');
const hiddenGit = (s: WorktreeStack, ...args: string[]): Promise<string> => s.git(['--git-dir', join(share(s), '.smurg', 'git'), '--work-tree', share(s), ...args]);
const isHidden = async (s: WorktreeStack): Promise<boolean> => (await s.gitCode(['rev-parse', '--git-dir'], share(s))).code !== 0;
const gitOf = async (s: WorktreeStack, ...args: string[]): Promise<string> => ((await isHidden(s)) ? hiddenGit(s, ...args) : s.git(args));
const headOf = async (s: WorktreeStack): Promise<string> => (await gitOf(s, 'rev-parse', 'HEAD')).trim();
const docOf = (s: { readonly t: { readonly ctx: WorktreeStack['t']['ctx'] } } | WorktreeStack) => s.t.ctx.state.document('worktrees', worktreesDocumentSchema, initialWorktreesDocument);

/** Line `n` (1-based) of `text` replaced by `to`. */
function withLine(text: string, n: number, to: string): string {
  const all = text.split('\n');
  all[n - 1] = to;
  return all.join('\n');
}
async function editLine(path: string, n: number, to: string): Promise<void> {
  await writeFile(path, withLine(await readFile(path, 'utf8'), n, to));
}

function hostRef(s: WorktreeStack): { userId: string; displayName: string } {
  const host = s.t.ctx.members.get(s.host.userId);
  if (host === null) throw new Error('no host');
  return { userId: host.userId, displayName: host.displayName };
}

interface Merged {
  readonly topic: { readonly id: string; readonly slug: string };
  readonly itemId: string;
  readonly request: MergeRequest;
  readonly mergeCommit: string;
}

/** A work item of `topic` made from the main workspace as it is now, in which `write` does the agent's work; smurg merges it. */
async function mergeItem(s: WorktreeStack, topic: Merged['topic'], itemId: string, write: (dir: string) => Promise<void>, options: { readonly report?: boolean } = {}): Promise<Merged> {
  const handle = await s.manager.acquireForItem({ topic, itemId, owner: s.principal('dev:mei') });
  const dir = s.worktreeDir(handle.worktree.id);
  await write(dir);
  if (options.report !== false) {
    await mkdir(join(dir, 'specs', topic.slug, 'reports'), { recursive: true });
    await writeFile(join(dir, 'specs', topic.slug, 'reports', `${itemId}.md`), `report of ${itemId}\n`);
  }
  const snapshot = await s.manager.snapshot({ worktreeId: handle.worktree.id, message: `smurg: work item (${itemId})` });
  if (!snapshot.ok) throw new Error(`snapshot refused: ${snapshot.reason}`);
  const hidden = await isHidden(s);
  const pin: AutoMergeInput['pin'] = hidden ? { commit: await headOf(s) } : { branch: (await s.git(['symbolic-ref', '--short', 'HEAD'])).trim(), commit: await headOf(s) };
  const outcome = await s.manager.autoMerge({ requestId: snapshot.request.id, host: hostRef(s), pin, consent: 'host-setting', stillInOrder: () => true });
  if (outcome.kind !== 'merged' || outcome.mergeCommit === undefined) throw new Error(`not merged: ${JSON.stringify(outcome)}`);
  return { topic, itemId, request: outcome.request, mergeCommit: outcome.mergeCommit };
}

/** What the topics module asks: every merged item, these asked, what is built on them as `builtOn` says (item id → its dependents). */
function ask(s: WorktreeStack, merged: readonly Merged[], asked: readonly Merged[], options: { readonly builtOn?: Readonly<Record<string, readonly string[]>>; readonly branch?: string; readonly host?: { userId: string; displayName: string } } = {}): UndoAsk {
  const history = existsSync(join(share(s), '.git')) ? 'folder' : 'smurg';
  const key = (item: UndoItemKey): string => `${item.topicId}/${item.itemId}`;
  return {
    host: options.host ?? hostRef(s),
    asked: asked.map((item) => ({ topicId: item.topic.id, itemId: item.itemId })),
    items: merged.map((item) => ({ topicId: item.topic.id, topicSlug: item.topic.slug, itemId: item.itemId, history, ...(options.branch === undefined ? {} : { branch: options.branch }) })),
    withBuiltOn: (keys) => {
      const out = new Map(keys.map((entry) => [key(entry), entry]));
      for (const entry of [...out.values()]) for (const dependent of options.builtOn?.[entry.itemId] ?? []) out.set(key({ topicId: entry.topicId, itemId: dependent }), { topicId: entry.topicId, itemId: dependent });
      return [...out.values()];
    },
  };
}

/** Nothing stops it: what the topics module's yes needs of the worktree module's facts. */
function inOrder(facts: UndoFacts): boolean {
  return facts.clean && facts.unavailable === null && facts.changedSince.length === 0 && facts.typing.length === 0 && facts.uncommitted.length === 0 && !facts.staged && !facts.busy && facts.branch === null;
}

function undo(manager: WorktreeManager, input: UndoAsk, subject = 'smurg: undo work item 1 (one) of checkout', confirm?: (facts: UndoFacts) => void) {
  return manager.undo({
    ...input,
    subject,
    confirm:
      confirm ??
      ((facts) => {
        if (!inOrder(facts)) throw new Error(`not in order: ${JSON.stringify(facts)}`);
      }),
  });
}

const parentOf = async (s: WorktreeStack, commit: string): Promise<string> => (await gitOf(s, 'rev-parse', `${commit}^1`)).trim();
const reverts = async (s: WorktreeStack, merge: Merged): Promise<string> => `This reverts commit ${merge.mergeCommit}, reversing changes made to ${await parentOf(s, merge.mergeCommit)}.`;

// ---------------------------------------------------------------------------------------------------------------------

withGit('undo in the folder\'s own git', { timeout: 60_000 }, () => {
  it('one item in ONE commit as the host, its report kept, the host\'s commit elsewhere kept; the preview changes nothing', async () => {
    const s = await folderStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    await writeFile(join(share(s), 'README.md'), '# demo (host)\n');
    await s.git(['commit', '-qam', 'the host, elsewhere']);
    const before = await headOf(s);

    const facts = await s.manager.undoPreview(ask(s, [one], [one]));
    expect(facts).toMatchObject({ history: 'folder', items: [{ topicId: CHECKOUT.id, itemId: 'one', why: 'asked' }], merges: [{ itemId: 'one', commit: one.mergeCommit, requestId: one.request.id }], clean: true, files: 1, changedSince: [], typing: [], uncommitted: [], staged: false, busy: false, branch: null, unavailable: null });
    expect(await headOf(s)).toBe(before);
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');

    const done = await undo(s.manager, ask(s, [one], [one]));
    expect(done.files).toBe(1);
    expect(await headOf(s)).toBe(done.commit);
    expect(await parentOf(s, done.commit)).toBe(before);
    expect((await s.git(['log', '-1', '--format=%an|%ae|%cn|%ce'])).trim()).toBe(`${hostRef(s).displayName}|dev-host@users.smurg.invalid|${hostRef(s).displayName}|dev-host@users.smurg.invalid`);
    expect((await s.git(['log', '-1', '--format=%B'])).trim()).toBe(`smurg: undo work item 1 (one) of checkout\n\n${await reverts(s, one)}`);
    expect((await s.git(['diff', '--name-only', 'HEAD^', 'HEAD'])).trim()).toBe('a.txt');
    expect(await read(s, 'a.txt')).toBe(lines('a', 10));
    expect(await read(s, 'specs/checkout/reports/one.md')).toBe('report of one\n');
    expect(await read(s, 'README.md')).toBe('# demo (host)\n');
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');
    const doc = await docOf(s);
    expect(doc.get().merges.find((merge) => merge.id === one.request.id)?.undone).toEqual({ commit: done.commit, at: expect.any(Number), by: hostRef(s) });
    expect(doc.get().undo).toBeUndefined();
    // Taken back once: it is nothing smurg could take back again.
    expect((await s.manager.undoPreview(ask(s, [one], [one]))).unavailable).toEqual(msg('undo.unavailable.notFound'));
    // Undo is the host's.
    expect(await settleError(s.manager.undoPreview(ask(s, [one], [one], { host: { userId: 'dev:mei', displayName: 'mei' } })))).toMatchObject({ code: 'forbidden', reason: 'not-the-host' });
  });

  it('the whole topic newest first; what is built on it goes with it; a later merge of another topic on the same lines goes with it, one on other lines of the same file does not', async () => {
    const s = await folderStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    const three = await mergeItem(s, FRONT, 'three', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one, then three)'));
    const two = await mergeItem(s, CHECKOUT, 'two', (dir) => editLine(join(dir, 'a.txt'), 8, 'a line 8 (two)'));
    const four = await mergeItem(s, CHECKOUT, 'four', (dir) => writeFile(join(dir, 'b.txt'), 'b notes (four)\n'));
    const all = [one, three, two, four];

    const facts = await s.manager.undoPreview(ask(s, all, [one], { builtOn: { one: ['four'] } }));
    expect(facts.items.map((item) => [item.topicId, item.itemId, item.why])).toEqual([
      [CHECKOUT.id, 'one', 'asked'],
      [CHECKOUT.id, 'four', 'built-on'],
      [FRONT.id, 'three', 'same-lines'],
    ]);
    expect(facts.merges.map((merge) => merge.itemId)).toEqual(['four', 'three', 'one']);
    expect(facts.clean).toBe(true);

    const done = await undo(s.manager, ask(s, all, [one], { builtOn: { one: ['four'] } }));
    expect((await s.git(['log', '-1', '--format=%B'])).trim()).toBe(`smurg: undo work item 1 (one) of checkout\n\n${await reverts(s, four)}\n${await reverts(s, three)}\n${await reverts(s, one)}`);
    expect(await read(s, 'a.txt')).toBe(withLine(lines('a', 10), 8, 'a line 8 (two)'));
    expect(await read(s, 'b.txt')).toBe('b notes\n');
    for (const item of [one, four]) expect(await read(s, `specs/checkout/reports/${item.itemId}.md`)).toBe(`report of ${item.itemId}\n`);
    expect(await read(s, 'specs/front/reports/three.md')).toBe('report of three\n');
    const merges = (await docOf(s)).get().merges;
    expect(merges.filter((merge) => merge.undone?.commit === done.commit).map((merge) => merge.itemId).sort()).toEqual(['four', 'one', 'three']);
    expect(merges.find((merge) => merge.id === two.request.id)?.undone).toBeUndefined();

    // What is left of the topic, as one undo of the whole of it (newest first, here one merge).
    const whole = await undo(s.manager, ask(s, [two], [two]), 'smurg: undo topic checkout');
    expect((await s.git(['log', '-1', '--format=%s'])).trim()).toBe('smurg: undo topic checkout');
    expect(await parentOf(s, whole.commit)).toBe(done.commit);
    expect(await read(s, 'a.txt')).toBe(lines('a', 10));
  });

  it('what stops it is named and nothing changes: a member\'s later commit on those lines, one made outside smurg; an earlier item\'s merge on them is nobody\'s change', async () => {
    const s = await folderStack();
    const zero = await mergeItem(s, CHECKOUT, 'zero', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (zero)'));
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (zero, then one)'));
    const bee = await mergeItem(s, CHECKOUT, 'bee', (dir) => writeFile(join(dir, 'b.txt'), 'b notes (bee)\n'));
    const all = [zero, one, bee];
    // zero's change before it is no person's: one alone goes back cleanly.
    expect(inOrder(await s.manager.undoPreview(ask(s, all, [one])))).toBe(true);

    await editLine(join(share(s), 'a.txt'), 2, 'a line 2 (Bo, on top)');
    await s.git(['commit', '-qam', 'Bo edits line 2', '--author=Bo <dev-bo@users.smurg.invalid>']);
    await writeFile(join(share(s), 'b.txt'), 'b notes (an editor outside smurg)\n');
    await s.git(['commit', '-qam', 'outside']);
    const before = await headOf(s);
    const blocked = await s.manager.undoPreview(ask(s, all, [one]));
    const bo = s.t.ctx.members.userRef('dev:bo');
    expect(blocked).toMatchObject({ clean: false, unavailable: null, items: [{ itemId: 'one', why: 'asked' }], changedSince: [{ path: 'a.txt', by: [bo], outside: false }] });
    expect((await s.manager.undoPreview(ask(s, all, [bee]))).changedSince).toEqual([{ path: 'b.txt', by: [], outside: true }]);
    await expect(undo(s.manager, ask(s, all, [one]))).rejects.toThrow(/not in order/);
    expect(await headOf(s)).toBe(before);
    expect(await read(s, 'a.txt')).toBe(withLine(lines('a', 10), 2, 'a line 2 (Bo, on top)'));
    expect((await docOf(s)).get().undo).toBeUndefined();
  });

  it('an uncommitted edit, someone typing, staged changes, a git operation under way, another branch: each named, nothing changed; a file edited between the look and the apply: git refuses, the record goes', async () => {
    const s = await folderStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    const input = ask(s, [one], [one], { branch: 'main' });
    const head = await headOf(s);
    const merged = withLine(lines('a', 10), 2, 'a line 2 (one)');

    await editLine(join(share(s), 'a.txt'), 5, 'a line 5 (typed, not committed)');
    expect((await s.manager.undoPreview(input)).uncommitted).toEqual(['a.txt']);
    await s.git(['checkout', '--', 'a.txt']);

    const amy = { userId: 'dev:amy', displayName: 'Amy' };
    expect(s.t.ctx.services.locks.touchHuman({ root: MAIN_ROOT, path: 'a.txt' }, amy).ok).toBe(true);
    expect((await s.manager.undoPreview(input)).typing).toEqual([{ path: 'a.txt', names: [amy] }]);
    s.t.ctx.services.locks.leaveHuman({ root: MAIN_ROOT, path: 'a.txt' }, amy.userId, 'closed');

    await writeFile(join(share(s), 'README.md'), '# demo (staged)\n');
    await s.git(['add', 'README.md']);
    expect((await s.manager.undoPreview(input)).staged).toBe(true);
    await s.git(['reset', '-q', '--hard']);

    await writeFile(join(share(s), '.git', 'CHERRY_PICK_HEAD'), `${head}\n`);
    expect((await s.manager.undoPreview(input)).busy).toBe(true);
    await rm(join(share(s), '.git', 'CHERRY_PICK_HEAD'));

    await s.git(['checkout', '-q', '-b', 'experiment']);
    expect((await s.manager.undoPreview(input)).branch).toEqual({ expected: 'main', current: 'experiment' });
    await s.git(['checkout', '-q', 'main']);
    expect(inOrder(await s.manager.undoPreview(input))).toBe(true);
    expect(await headOf(s)).toBe(head);
    expect(await read(s, 'a.txt')).toBe(merged);

    // Someone saves into the file between the look and the apply: git's own check refuses it, nothing of the undo is
    // written, the record goes, and the edit stays.
    const saved = withLine(merged, 9, 'a line 9 (saved just now)');
    const refused = await settleError(
      undo(s.manager, input, undefined, (facts) => {
        if (!inOrder(facts)) throw new Error('not in order');
        writeFileSync(join(share(s), 'a.txt'), saved);
      }),
    );
    expect(refused).toMatchObject({ code: 'conflict', reason: 'changed', text: { id: 'undo.changed' } });
    expect(await headOf(s)).toBe(head);
    expect(await read(s, 'a.txt')).toBe(saved);
    expect((await docOf(s)).get().undo).toBeUndefined();
    expect((await docOf(s)).get().merges.find((merge) => merge.id === one.request.id)?.undone).toBeUndefined();
  });

  it('a merge with no recorded merge commit is found by its second parent', async () => {
    const s = await folderStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    (await docOf(s)).update((draft) => {
      const merge = draft.merges.find((candidate) => candidate.id === one.request.id);
      if (merge !== undefined) delete merge.mergeCommit;
    });
    const facts = await s.manager.undoPreview(ask(s, [one], [one]));
    expect(facts.merges).toEqual([{ topicId: CHECKOUT.id, itemId: 'one', commit: one.mergeCommit, requestId: one.request.id }]);
    await undo(s.manager, ask(s, [one], [one]));
    expect(await read(s, 'a.txt')).toBe(lines('a', 10));
  });

  // 0.7.0 verify: worktrees.json keeps the newest decided merges only. One trimmed while its checkout was still there
  // read as holding work that was never merged (its topic could never be ready, and its undo was refused); and an undo
  // of an item whose request was gone went through `mergedAs.commit` only, which no recovery after a crash reaches (it
  // was taken back in git and still said "merged").
  it('a merged request of a checkout that is still there is never trimmed from the record', async () => {
    stack = await startWorktreeStack({ files: FILES, extraModules: [locksModule], module: { limits: { maxDecidedMerges: 1 } } });
    await stack.connect('dev:mei', 'agent');
    const s = stack;
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    const two = await mergeItem(s, FRONT, 'two', (dir) => editLine(join(dir, 'c.txt'), 1, 'c line 1 (two)'));
    // (a request is trimmed when another is stored: the next snapshot's)
    await mergeItem(s, FRONT, 'three', (dir) => editLine(join(dir, 'c.txt'), 3, 'c line 3 (three)'));
    const kept = (await docOf(s)).get().merges.map((merge) => merge.id);
    expect(kept).toEqual(expect.arrayContaining([one.request.id, two.request.id]));
    expect(s.manager.unmerged(CHECKOUT.id)).toEqual([]);
    expect((await s.manager.undoPreview(ask(s, [one], [one]))).unavailable).toBeNull();
  });

  it('an undo of an item whose merge request the record no longer keeps is refused (notFound), also with what is built on it, and nothing changes', async () => {
    stack = await startWorktreeStack({ files: FILES, extraModules: [locksModule], module: { limits: { maxDecidedMerges: 0 } } });
    await stack.connect('dev:mei', 'agent');
    const s = stack;
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    // Its checkout went (its topic was checked); the next merge request stored trims its request from the record.
    const worktree = s.manager.list().find((entry) => entry.itemId === 'one');
    if (worktree !== undefined) await s.manager.releaseItem(worktree.id);
    const two = await mergeItem(s, CHECKOUT, 'two', (dir) => editLine(join(dir, 'a.txt'), 8, 'a line 8 (two)'));
    expect((await docOf(s)).get().merges.some((merge) => merge.id === one.request.id)).toBe(false);
    const head = await headOf(s);
    const input = ask(s, [one, two], [one], { builtOn: { one: ['two'] } });
    const withCommit: UndoAsk = { ...input, items: input.items.map((item) => (item.itemId === 'one' ? { ...item, mergedAs: { commit: one.mergeCommit } } : item)) };
    const facts = await s.manager.undoPreview(withCommit);
    expect(facts.unavailable).toMatchObject(msg('undo.unavailable.notFound'));
    expect(await settleError(undo(s.manager, withCommit, 'smurg: undo work item 1 (one) of checkout', () => {}))).toMatchObject({ code: 'conflict' });
    expect(await headOf(s)).toBe(head);
    expect(await read(s, 'a.txt')).toBe(withLine(withLine(lines('a', 10), 2, 'a line 2 (one)'), 8, 'a line 8 (two)'));
  });
});

withGit('undo in smurg\'s own history', { timeout: 60_000 }, () => {
  it('R-SAFE\'s undo-order case: a person\'s saved edit nobody recorded yet stays, in an untouched file and on an untouched line of a touched file; the undo commit changes only the item\'s file', async () => {
    const s = await hiddenStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    // Bo saves after the merge; no snapshot took it yet.
    await writeFile(join(share(s), 'b.txt'), "b notes, and Bo's paragraph\n");
    await editLine(join(share(s), 'a.txt'), 9, 'a line 9 (Bo typed)');
    const lastSnapshot = await headOf(s);

    const first = await s.manager.undoPreview(ask(s, [one], [one]));
    expect(first).toMatchObject({ history: 'smurg', clean: true, files: 1, unavailable: null });
    // The look recorded the folder first, as the host.
    expect((await hiddenGit(s, 'log', '-1', '--format=%s|%an')).trim()).toBe(`${HIDDEN_UNDO_MESSAGE}|${hostRef(s).displayName}`);
    expect(await parentOf(s, await headOf(s))).toBe(lastSnapshot);
    // An unrelated saved edit moves smurg's history again, and changes nothing of what the undo does.
    await writeFile(join(share(s), 'README.md'), '# demo (Mei, meanwhile)\n');
    const second = await s.manager.undoPreview(ask(s, [one], [one]));
    expect({ items: second.items, merges: second.merges, clean: second.clean, files: second.files }).toEqual({ items: first.items, merges: first.merges, clean: first.clean, files: first.files });

    const done = await undo(s.manager, ask(s, [one], [one]));
    expect(await read(s, 'a.txt')).toBe(withLine(lines('a', 10), 9, 'a line 9 (Bo typed)'));
    expect(await read(s, 'b.txt')).toBe("b notes, and Bo's paragraph\n");
    expect(await read(s, 'README.md')).toBe('# demo (Mei, meanwhile)\n');
    expect(await read(s, 'specs/checkout/reports/one.md')).toBe('report of one\n');
    expect((await hiddenGit(s, 'diff', '--name-only', 'HEAD^', 'HEAD')).trim()).toBe('a.txt');
    expect(await headOf(s)).toBe(done.commit);
    expect((await hiddenGit(s, 'log', '-1', '--format=%B')).trim()).toBe(`smurg: undo work item 1 (one) of checkout\n\n${await reverts(s, one)}`);
    expect((await hiddenGit(s, 'status', '--porcelain')).trim()).toBe('');
  });

  it('who changed the lines it cannot take back is named from the activity log; nothing changes', async () => {
    const s = await hiddenStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    await editLine(join(share(s), 'a.txt'), 2, 'a line 2 (Bo: agreed with the client)');
    const bo = { userId: 'dev:bo', displayName: 'Bo' };
    s.t.ctx.services.activity.record({ actor: { kind: 'user', ...bo }, kind: 'human.edit', file: { root: MAIN_ROOT, path: 'a.txt' }, text: msg('activity.humanEdit', { name: 'Bo', path: 'a.txt' }) });
    const facts = await s.manager.undoPreview(ask(s, [one], [one]));
    expect(facts).toMatchObject({ clean: false, changedSince: [{ path: 'a.txt', by: [bo], outside: false }] });
    expect(await read(s, 'a.txt')).toBe(withLine(lines('a', 10), 2, 'a line 2 (Bo: agreed with the client)'));
  });
});

withGit('an undo a crash cut short', { timeout: 60_000 }, () => {
  it('after the commit and before its record: recorded at the next start from the commit\'s own words', async () => {
    const s = await folderStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'));
    const done = await undo(s.manager, ask(s, [one], [one]));
    // What a kill just after `update-ref` leaves: the record, and the request not marked yet.
    const doc = await docOf(s);
    doc.update((draft) => {
      const merge = draft.merges.find((candidate) => candidate.id === one.request.id);
      if (merge !== undefined) delete merge.undone;
    });
    const pre = await parentOf(s, done.commit);
    const tree = (await s.git(['rev-parse', `${done.commit}^{tree}`])).trim();
    doc.update((draft) => {
      draft.undo = { requestIds: [one.request.id], pre, target: tree, at: s.t.clock.now() };
    });
    await doc.flush();
    await s.t.daemon.stop();
    const daemon = await restartDaemonWith(s.t, [locksModule, createWorktreeModule()]);
    try {
      const after = (await docOf({ t: { ctx: daemon.ctx } })).get();
      expect(after.undo).toBeUndefined();
      expect(after.merges.find((merge) => merge.id === one.request.id)?.undone?.commit).toBe(done.commit);
      expect(await headOf(s)).toBe(done.commit);
      const recovered = (await daemon.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'worktree.merge.undo');
      expect(recovered).toMatchObject([{ outcome: 'ok', actor: { kind: 'system' }, detail: { reason: 'recovered-after-crash', case: 'a', commit: done.commit } }]);
    } finally {
      await daemon.stop();
    }
  });

  it('between read-tree and the commit, the folder\'s own git: case b is committed at the next start; between the two (case d) every merge is held until the host put the files back', async () => {
    const s = await folderStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'), { report: false });
    const pre = await headOf(s);
    const target = (await s.git(['merge-tree', '--write-tree', '--merge-base', one.mergeCommit, 'HEAD', `${one.mergeCommit}^1`])).split('\n')[0]?.trim() as string;
    const doc = await docOf(s);
    doc.update((draft) => {
      draft.undo = { requestIds: [one.request.id], pre, target, at: s.t.clock.now() };
    });
    await doc.flush();
    await s.git(['read-tree', '-m', '-u', 'HEAD', target]);
    await s.t.daemon.stop();
    const daemon = await restartDaemonWith(s.t, [locksModule, createWorktreeModule()]);
    try {
      const after = (await docOf({ t: { ctx: daemon.ctx } })).get();
      expect(after.undo).toBeUndefined();
      const commit = after.merges.find((merge) => merge.id === one.request.id)?.undone?.commit;
      expect(commit).toBe(await headOf(s));
      expect(await parentOf(s, commit as string)).toBe(pre);
      expect((await s.git(['log', '-1', '--format=%B'])).trim()).toBe(`smurg: undo work item one of checkout\n\n${await reverts(s, one)}`);
      expect((await s.git(['status', '--porcelain'])).trim()).toBe('');
      expect(await read(s, 'a.txt')).toBe(lines('a', 10));
    } finally {
      await daemon.stop();
    }

  });

  it('between read-tree and the commit, the folder\'s own git, case d: every automatic merge and every undo is held for the host; once the files are back, both go on', async () => {
    const s = await folderStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'), { report: false });
    const handle = await s.manager.acquireForItem({ topic: CHECKOUT, itemId: 'two', owner: s.principal('dev:mei') });
    await writeFile(join(s.worktreeDir(handle.worktree.id), 'c.txt'), 'c (two)\n');
    const draft = await s.manager.snapshot({ worktreeId: handle.worktree.id, message: 'smurg: work item (two)' });
    if (!draft.ok) throw new Error('no draft');
    const pre = await headOf(s);
    const target = (await s.git(['merge-tree', '--write-tree', '--merge-base', one.mergeCommit, 'HEAD', `${one.mergeCommit}^1`])).split('\n')[0]?.trim() as string;
    const doc = await docOf(s);
    doc.update((d) => {
      d.undo = { requestIds: [one.request.id], pre, target, at: s.t.clock.now() };
    });
    await doc.flush();
    // A kill inside read-tree: a.txt written as the undo has it, the index still the merge's.
    await writeFile(join(share(s), 'a.txt'), lines('a', 10));
    await s.t.daemon.stop();
    const daemon = await restartDaemonWith(s.t, [locksModule, createWorktreeModule()]);
    try {
      const manager = daemon.ctx.services.worktrees as WorktreeManagerImpl;
      expect((await docOf({ t: { ctx: daemon.ctx } })).get().undo).toBeDefined();
      const host = daemon.ctx.members.get(daemon.ctx.members.hostUserId());
      if (host === null) throw new Error('no host');
      const hostUser = { userId: host.userId, displayName: host.displayName };
      const mergeTwo = () => manager.autoMerge({ requestId: draft.request.id, host: hostUser, pin: { branch: 'main', commit: pre }, consent: 'host-setting', stillInOrder: () => true });
      expect(await mergeTwo()).toEqual({ kind: 'hold', reason: 'undo-interrupted' });
      expect((await manager.undoPreview({ ...ask(s, [one], [one]), host: hostUser })).unavailable).toEqual(msg('undo.unavailable.interrupted'));
      expect(await headOf(s)).toBe(pre);
      // The host puts the file back (git restore): nothing of the undo is in the folder any more; the record goes.
      await s.git(['restore', '--staged', '--worktree', '--', 'a.txt']);
      expect(await mergeTwo()).toMatchObject({ kind: 'merged' });
      expect((await docOf({ t: { ctx: daemon.ctx } })).get().undo).toBeUndefined();
      expect(await read(s, 'a.txt')).toBe(withLine(lines('a', 10), 2, 'a line 2 (one)'));
      const recovered = (await daemon.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'worktree.merge.undo');
      expect(recovered).toMatchObject([{ outcome: 'error', detail: { reason: 'recovered-after-crash', case: 'c', applied: false } }]);
    } finally {
      await daemon.stop();
    }
  });

  it('between read-tree and the commit in smurg\'s own history: finished at the first use (case b); between the two (case d) too, a person\'s edit since stays', async () => {
    const s = await hiddenStack();
    const one = await mergeItem(
      s,
      CHECKOUT,
      'one',
      async (dir) => {
        await editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)');
        await writeFile(join(dir, 'b.txt'), 'b notes (one)\n');
        await editLine(join(dir, 'c.txt'), 1, 'c line 1 (one)');
      },
      { report: false },
    );
    const pre = await headOf(s);
    const target = (await hiddenGit(s, 'merge-tree', '--write-tree', '--merge-base', one.mergeCommit, 'HEAD', `${one.mergeCommit}^1`)).split('\n')[0]?.trim() as string;
    const doc = await docOf(s);
    doc.update((d) => {
      d.undo = { requestIds: [one.request.id], pre, target, repo: 'smurg', at: s.t.clock.now() };
    });
    await doc.flush();
    // Case d: a kill inside read-tree wrote a.txt as the undo has it; Bo saved b.txt meanwhile (neither version);
    // c.txt still holds the merge's version; the index is still the merge's.
    await writeFile(join(share(s), 'a.txt'), lines('a', 10));
    await writeFile(join(share(s), 'b.txt'), 'b notes (Bo, after the crash)\n');
    await s.t.daemon.stop();
    const daemon = await restartDaemonWith(s.t, [locksModule, createWorktreeModule()]);
    try {
      const manager = daemon.ctx.services.worktrees as WorktreeManagerImpl;
      const host = daemon.ctx.members.get(daemon.ctx.members.hostUserId());
      if (host === null) throw new Error('no host');
      // The first use of smurg's own history in this run settles it.
      await manager.undoPreview({ ...ask(s, [one], [one]), host: { userId: host.userId, displayName: host.displayName } });
      const after = (await docOf({ t: { ctx: daemon.ctx } })).get();
      expect(after.undo).toBeUndefined();
      const commit = after.merges.find((merge) => merge.id === one.request.id)?.undone?.commit as string;
      expect(await parentOf(s, commit)).toBe(pre);
      expect((await hiddenGit(s, 'rev-parse', `${commit}^{tree}`)).trim()).toBe(target);
      expect(await read(s, 'a.txt')).toBe(lines('a', 10));
      expect(await read(s, 'c.txt')).toBe(lines('c', 3));
      // Bo's edit is not taken back: it is the folder's newest state, and the next snapshot (the look that followed)
      // recorded it after the undo commit.
      expect(await read(s, 'b.txt')).toBe('b notes (Bo, after the crash)\n');
      expect(await parentOf(s, await headOf(s))).toBe(commit);
      expect((await hiddenGit(s, 'diff', '--name-only', commit, 'HEAD')).trim()).toBe('b.txt');
      expect((await hiddenGit(s, 'status', '--porcelain')).trim()).toBe('');
      const recovered = (await daemon.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'worktree.merge.undo');
      expect(recovered).toMatchObject([{ outcome: 'ok', detail: { reason: 'recovered-after-crash', case: 'd', history: 'smurg' } }]);
    } finally {
      await daemon.stop();
    }
  });

  it('case b in smurg\'s own history: the index and the folder are the undo, the commit is made at the first use', async () => {
    const s = await hiddenStack();
    const one = await mergeItem(s, CHECKOUT, 'one', (dir) => editLine(join(dir, 'a.txt'), 2, 'a line 2 (one)'), { report: false });
    const pre = await headOf(s);
    const target = (await hiddenGit(s, 'merge-tree', '--write-tree', '--merge-base', one.mergeCommit, 'HEAD', `${one.mergeCommit}^1`)).split('\n')[0]?.trim() as string;
    const doc = await docOf(s);
    doc.update((d) => {
      d.undo = { requestIds: [one.request.id], pre, target, repo: 'smurg', at: s.t.clock.now() };
    });
    await doc.flush();
    await hiddenGit(s, 'read-tree', '-m', '-u', 'HEAD', target);
    await s.t.daemon.stop();
    const daemon = await restartDaemonWith(s.t, [locksModule, createWorktreeModule()]);
    try {
      const manager = daemon.ctx.services.worktrees as WorktreeManagerImpl;
      const host = daemon.ctx.members.get(daemon.ctx.members.hostUserId());
      if (host === null) throw new Error('no host');
      await manager.undoPreview({ ...ask(s, [one], [one]), host: { userId: host.userId, displayName: host.displayName } });
      const after = (await docOf({ t: { ctx: daemon.ctx } })).get();
      expect(after.undo).toBeUndefined();
      expect(after.merges.find((merge) => merge.id === one.request.id)?.undone?.commit).toBe(await headOf(s));
      expect((await hiddenGit(s, 'log', '-1', '--format=%B')).trim()).toBe(`smurg: undo work item one of checkout\n\n${await reverts(s, one)}`);
      expect(await read(s, 'a.txt')).toBe(lines('a', 10));
      expect((await daemon.ctx.audit.query({ limit: 100 })).filter((entry) => entry.action === 'worktree.merge.undo')).toMatchObject([{ outcome: 'ok', detail: { case: 'b' } }]);
    } finally {
      await daemon.stop();
    }
  });
});
