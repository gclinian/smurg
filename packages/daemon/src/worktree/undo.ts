// The host's undo (DESIGN 0.7.0 D14, U2's scripts exp1..7, R-SAFE's undo-order.sh): the git steps of taking merged work
// items back out of the main workspace, used by WorktreeManager.undoPreview / undo on the `main` queue.
//
//  - The trial, objects only: every merge to take back is reverted newest first, `git merge-tree --write-tree
//    --merge-base <M> <current> <M^1>`, chained through `commit-tree` (nothing of the folder or its index is touched).
//  - The reports stay: the tree the trial ends with gets the undone items' report files back as the head has them
//    (`specs/<slug>/reports/<item>.md`), in a daemon-private index.
//  - The apply writes exactly that tree: `read-tree -m -u <pre> <target>` (it refuses a touched file that holds an edit
//    git does not have) and ONE commit on `pre` (`commit-tree`, then `update-ref HEAD <new> <pre>`, which refuses when
//    HEAD moved), whose body names every merge it reverts with git's own words: `This reverts commit <M>, reversing
//    changes made to <M^1>.` A crash between the record and its end is told apart by those words and by the trees.
//
// Only the hardened runner of git.ts runs git here; paths are named to git literally (GIT_LITERAL_PATHSPECS).
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError, gitCommitSchema } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { firstLine, requireOk, type GitIdentity } from './git.ts';
import { parseMergeTree, parseNameOnly, parseNameStatus, splitNul } from './git-parse.ts';
import type { MainRepo } from './review.ts';

/** An object id as git prints it (the protocol's form of a commit id, which a tree id shares). */
const OID = { test: (value: string): boolean => gitCommitSchema.safeParse(value).success } as const;
/** Paths named to one git command (a command line stays short; more paths are more commands). */
const PATHS_PER_COMMAND = 200;
/** What one listing of the main workspace's first-parent history may take. */
const LINE_OUTPUT_MAX = 64 * 1024 * 1024;

/** The snapshot smurg's own history takes first, before an undo is computed or applied (R-SAFE S1). */
export const HIDDEN_UNDO_MESSAGE = 'smurg: the shared folder before an undo';

/** A merge to take back: the merge commit and its first parent (what it was merged into). */
export interface UndoMergeCommit {
  readonly commit: string;
  readonly parent: string;
}

/** The words of git's own `git revert -m 1` for one merge (the crash check reads them). */
export function revertsLine(merge: UndoMergeCommit): string {
  return `This reverts commit ${merge.commit}, reversing changes made to ${merge.parent}.`;
}

/** The undo commit's message: the subject, then one line per merge, newest first. Fixed English (one shared history). */
export function undoMessage(subject: string, merges: readonly UndoMergeCommit[]): string {
  return `${subject}\n\n${merges.map(revertsLine).join('\n')}\n`;
}

function oid(value: string, step: 'readCommit' | 'commit' | 'stage'): string {
  if (!OID.test(value)) throw new SmurgError('internal', msg('git.objectUnreadable', { step }), { reason: 'git-output-unparsable', step });
  return value;
}

/**
 * The main workspace's first-parent history from `head` (position 0 is `head`, larger is older): where each merge an
 * undo takes back lies, and which merges came later. Null when it cannot be read whole.
 */
export async function firstParentLine(repo: MainRepo, head: string, timeoutMs: number): Promise<Map<string, number> | null> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['rev-list', '--first-parent', head], readOnly: true, maxStdoutBytes: LINE_OUTPUT_MAX, timeoutMs });
  if (result.truncated) return null;
  requireOk(result, 'readCommit');
  const line = new Map<string, number>();
  for (const entry of result.stdout.toString('latin1').split('\n')) {
    const commit = entry.trim();
    if (OID.test(commit) && !line.has(commit)) line.set(commit, line.size);
  }
  return line;
}

/** A commit's first parent (null: none, or not a commit here). */
export async function parentOf(repo: MainRepo, commit: string): Promise<string | null> {
  if (!OID.test(commit)) return null;
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['rev-parse', '--verify', '--quiet', `${commit}^1`], readOnly: true, maxStdoutBytes: 1024 });
  if (result.code !== 0) return null;
  const parent = firstLine(result);
  return OID.test(parent) ? parent : null;
}

/** A commit's tree (null: not a commit here). */
export async function treeOf(repo: MainRepo, commit: string): Promise<string | null> {
  if (!OID.test(commit)) return null;
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], readOnly: true, maxStdoutBytes: 1024 });
  if (result.code !== 0) return null;
  const tree = firstLine(result);
  return OID.test(tree) ? tree : null;
}

export type RevertTrial = { readonly clean: true; readonly tree: string } | { readonly clean: false; readonly conflicted: readonly string[] };

/**
 * The trial (DESIGN 0.7.0 D14 step 3, U2 exp3, exp7): `merges` reverted newest first on top of `head`, objects only.
 * Clean: the tree the folder would hold. Not clean: the files the first revert that does not apply cleanly conflicts on.
 */
export async function revertTrial(repo: MainRepo, head: string, merges: readonly UndoMergeCommit[], timeoutMs: number): Promise<RevertTrial> {
  let current = head;
  let tree = await treeOf(repo, head);
  if (tree === null) throw new SmurgError('internal', msg('git.stepFailed', { step: 'readCommit' }), { reason: 'git-failed', step: 'readCommit' });
  for (const merge of merges) {
    const result = await repo.git.run({
      gitDir: repo.gitDir,
      args: ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', '--merge-base', merge.commit, current, merge.parent],
      maxStdoutBytes: 64 * 1024 * 1024,
      timeoutMs,
    });
    if (result.truncated || (result.code !== 0 && result.code !== 1)) requireOk(result, 'trialMerge');
    const parsed = parseMergeTree(result.stdout);
    if (result.code === 1) return { clean: false, conflicted: parsed.conflicted.map((path) => path.path) };
    tree = parsed.tree;
    const made = requireOk(await repo.git.run({ gitDir: repo.gitDir, args: ['commit-tree', parsed.tree, '-p', current, '-F', '-'], input: 'smurg: the trial of an undo\n', maxStdoutBytes: 1024, timeoutMs }), 'commit');
    current = oid(firstLine(made), 'commit');
  }
  return { clean: true, tree };
}

/**
 * `tree` with these files as `head` has them, or without them when `head` has none (the undone items' reports stay,
 * U2 exp1 #9). In an index of the daemon's own (`stagingDir`): nothing of the repository's index changes. Report paths
 * are ASCII (the topic's slug and the item's id), named to git as they are.
 */
export async function withFilesOf(repo: MainRepo, input: { readonly tree: string; readonly head: string; readonly paths: readonly string[]; readonly stagingDir: string; readonly timeoutMs: number }): Promise<string> {
  const paths = [...new Set(input.paths)];
  if (paths.length === 0) return input.tree;
  const dir = await mkdtemp(join(input.stagingDir, 'c-undo-'));
  const indexFile = join(dir, 'index');
  const { timeoutMs } = input;
  try {
    requireOk(await repo.git.run({ gitDir: repo.gitDir, indexFile, args: ['read-tree', input.tree], timeoutMs }), 'stage');
    const records: string[] = [];
    for (let at = 0; at < paths.length; at += PATHS_PER_COMMAND) {
      const group = paths.slice(at, at + PATHS_PER_COMMAND);
      const listed = requireOk(await repo.git.run({ gitDir: repo.gitDir, args: ['ls-tree', '-r', '-z', '--full-tree', input.head, '--', ...group], readOnly: true, maxStdoutBytes: 16 * 1024 * 1024, timeoutMs }), 'listChanges');
      const present = new Map<string, string>();
      for (const field of splitNul(listed.stdout)) {
        const entry = field.toString('utf8');
        const tab = entry.indexOf('\t');
        if (tab === -1) continue;
        const [mode, type, object] = entry.slice(0, tab).split(' ');
        if (type === 'blob' && mode !== undefined && object !== undefined && OID.test(object)) present.set(entry.slice(tab + 1), `${mode} ${object}`);
      }
      for (const path of group) records.push(`${present.get(path) ?? `0 ${'0'.repeat(input.head.length)}`}\t${path}`);
    }
    requireOk(await repo.git.run({ gitDir: repo.gitDir, indexFile, args: ['update-index', '-z', '--index-info'], input: `${records.join('\0')}\0`, timeoutMs }), 'stage');
    return oid(firstLine(requireOk(await repo.git.run({ gitDir: repo.gitDir, indexFile, args: ['write-tree'], maxStdoutBytes: 1024, timeoutMs }), 'stage')), 'stage');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Every path `from..to` changes, with its letter (no renames: a rename is its two names), objects only. */
export async function changesBetween(repo: MainRepo, from: string, to: string, timeoutMs: number): Promise<{ readonly letter: string; readonly path: string }[]> {
  const result = requireOk(await repo.git.run({ gitDir: repo.gitDir, args: ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', from, to], readOnly: true, maxStdoutBytes: 64 * 1024 * 1024, timeoutMs }), 'listChanges');
  return parseNameStatus(result.stdout).map((entry) => ({ letter: entry.letter, path: entry.path.path }));
}

/** Whether a merge changed one of `paths` against what it was merged into (U2 exp5: the candidates that may go with an undo). */
export async function mergeTouches(repo: MainRepo, merge: UndoMergeCommit, paths: readonly string[], timeoutMs: number): Promise<boolean> {
  for (let at = 0; at < paths.length; at += PATHS_PER_COMMAND) {
    const group = paths.slice(at, at + PATHS_PER_COMMAND);
    const result = await repo.git.run({ gitDir: repo.gitDir, args: ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', merge.parent, merge.commit, '--', ...group], readOnly: true, maxStdoutBytes: 1024 * 1024, timeoutMs });
    // (an answer that cannot be read counts as "it did": it is tried, never left out unseen)
    if (result.truncated || result.code !== 0 || parseNameOnly(result.stdout).length > 0) return true;
  }
  return false;
}

/**
 * Of `paths`, those the working tree does NOT hold as `commit` has them: a file that differs, one that is gone, or one
 * that is there although `commit` has none (an untracked file in its place). Reads the working tree through git's
 * own comparison (`git diff <commit> -- <paths>`, attributes from `attrSource`) and lstat, never through a link.
 */
export async function notAsIn(repo: MainRepo, input: { readonly workTree: string; readonly commit: string; readonly paths: readonly string[]; readonly attrSource?: string; readonly timeoutMs: number }): Promise<Set<string>> {
  const out = new Set<string>();
  const { timeoutMs } = input;
  for (let at = 0; at < input.paths.length; at += PATHS_PER_COMMAND) {
    const group = input.paths.slice(at, at + PATHS_PER_COMMAND);
    const listed = requireOk(await repo.git.run({ gitDir: repo.gitDir, args: ['ls-tree', '-r', '-z', '--name-only', '--full-tree', input.commit, '--', ...group], readOnly: true, maxStdoutBytes: 16 * 1024 * 1024, timeoutMs }), 'listChanges');
    const inCommit = new Set(parseNameOnly(listed.stdout).map((path) => path.path));
    const compared = await repo.git.run({
      gitDir: repo.gitDir,
      workTree: input.workTree,
      ...(input.attrSource === undefined ? {} : { attrSource: input.attrSource }),
      args: ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=all', input.commit, '--', ...group],
      readOnly: true,
      maxStdoutBytes: 16 * 1024 * 1024,
      timeoutMs,
    });
    // (a comparison that cannot be read: every path of it counts as changed, the closed side)
    const differs = compared.truncated || compared.code !== 0 ? new Set(group) : new Set(parseNameOnly(compared.stdout).map((path) => path.path));
    for (const path of group) {
      if (differs.has(path)) out.add(path);
      else if (!inCommit.has(path) && (await lstat(join(input.workTree, ...path.split('/'))).catch(() => null)) !== null) out.add(path);
    }
  }
  return out;
}

/** The repository's index as a tree (`git write-tree`, an object only); null while it holds a conflict or cannot be written. */
export async function indexTree(repo: MainRepo, timeoutMs: number): Promise<string | null> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['write-tree'], maxStdoutBytes: 1024, timeoutMs });
  if (result.code !== 0) return null;
  const tree = firstLine(result);
  return OID.test(tree) ? tree : null;
}

/**
 * ONE commit of `tree` on `parent` as `identity` (author and committer: the host's own act), and HEAD moved from
 * `parent` to it: `update-ref` refuses when HEAD is no longer `parent`, so nothing that landed meanwhile is lost.
 */
export async function commitOnHead(repo: MainRepo, input: { readonly tree: string; readonly parent: string; readonly message: string; readonly identity: GitIdentity; readonly timeoutMs: number }): Promise<string> {
  const made = requireOk(
    await repo.git.run({ gitDir: repo.gitDir, identity: input.identity, args: ['commit-tree', input.tree, '-p', input.parent, '-F', '-'], input: input.message, maxStdoutBytes: 1024, timeoutMs: input.timeoutMs, abortable: false }),
    'commit',
  );
  const commit = oid(firstLine(made), 'commit');
  requireOk(await repo.git.run({ gitDir: repo.gitDir, identity: input.identity, args: ['update-ref', '-m', 'smurg: undo', 'HEAD', commit, input.parent], timeoutMs: input.timeoutMs, abortable: false }), 'commit');
  return commit;
}

/** The first commit after `pre` on `head`'s first-parent line (null: none). */
export async function nextOnLine(repo: MainRepo, head: string, pre: string, timeoutMs: number): Promise<string | null> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['rev-list', '--first-parent', '--reverse', head, `^${pre}`], readOnly: true, maxStdoutBytes: LINE_OUTPUT_MAX, timeoutMs });
  if (result.code !== 0 || result.truncated) return null;
  const first = firstLine(result);
  return OID.test(first) ? first : null;
}

/** A commit's whole message (`%B`), at most 1 MiB. */
export async function messageOf(repo: MainRepo, commit: string): Promise<string | null> {
  const result = await repo.git.run({ gitDir: repo.gitDir, args: ['log', '-1', '--format=%B', commit], readOnly: true, maxStdoutBytes: 1024 * 1024 });
  return result.code === 0 && !result.truncated ? result.stdout.toString('utf8') : null;
}

/** Writes the index's version of these files into the working tree (`checkout-index -f`), never anything else. */
export async function checkoutFromIndex(repo: MainRepo, input: { readonly workTree: string; readonly paths: readonly string[]; readonly timeoutMs: number }): Promise<void> {
  for (let at = 0; at < input.paths.length; at += PATHS_PER_COMMAND) {
    const group = input.paths.slice(at, at + PATHS_PER_COMMAND);
    requireOk(await repo.git.run({ gitDir: repo.gitDir, workTree: input.workTree, args: ['checkout-index', '-f', '-q', '--', ...group], timeoutMs: input.timeoutMs, abortable: false }), 'checkout');
  }
}
