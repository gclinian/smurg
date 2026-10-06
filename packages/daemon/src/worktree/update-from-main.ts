// A conflict between a work item and the main workspace (ARCHITECTURE §7.8 "A conflict", §5.10 `plan.item.resolve`):
// smurg merges, the agent resolves, nobody's agent runs git. The worktree's work is a commit S on its branch (the
// caller made it: the working tree is clean against it); this merges the main workspace's HEAD into the working tree
// WITHOUT committing, lists the files git could not merge and ends git's own merge state, leaving the files and their
// conflict markers. The worktree's next commit (stage-commit.ts) gets that HEAD as its second parent, and is refused
// while a listed file still has a marker line.
//
// The clone reads the main repository's objects through its alternates, so nothing is fetched. Everything runs with
// the hardened runner (no hooks, no host config) in a clone whose git directory the caller verified (integrity.ts).
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { untrackedInTheWay } from './fs-ops.ts';
import { requireOk, type GitRunner } from './git.ts';
import { parseMergeTree, parseNameOnly, parseNameStatus } from './git-parse.ts';

export interface MergeMainInput {
  readonly git: GitRunner;
  /** realpath of the worktree. */
  readonly workTree: string;
  /** The branch head: the commit the working tree is clean against. */
  readonly head: string;
  /** The main workspace's HEAD. */
  readonly mainCommit: string;
  readonly timeoutMs: number;
  /** Called right before the merge with the files it will write in the working tree (protocol spelling). */
  readonly beforeMerge?: (paths: string[]) => void;
}

export type MergeMainResult =
  /** The branch already contains the main workspace's HEAD: nothing changed, no second parent is owed. */
  | { readonly merged: false }
  /** The working tree now holds the merge; `conflicted` still have markers. */
  | { readonly merged: true; readonly conflicted: string[] };

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

export async function mergeMainIntoWorktree(input: MergeMainInput): Promise<MergeMainResult> {
  const { git, workTree, timeoutMs } = input;
  const gitDir = join(workTree, '.git');
  const contained = await git.run({ gitDir, args: ['merge-base', '--is-ancestor', input.mainCommit, input.head], readOnly: true, timeoutMs });
  if (contained.code === 0) return { merged: false };
  if (contained.code !== 1) requireOk(contained, 'mergeBase');

  // What the merge would do, decided without touching the working tree (merge-tree writes objects only): the entries
  // it changes against the branch head. Where it ADDS one that the working tree already has untracked or ignored, git
  // would overwrite it without a word (an ignored build output, a local data file): refused, nothing changed.
  const trial = await git.run({ gitDir, attrSource: input.head, args: ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', input.head, input.mainCommit], maxStdoutBytes: 64 * 1024 * 1024, timeoutMs });
  if (trial.truncated || (trial.code !== 0 && trial.code !== 1)) requireOk(trial, 'trialMerge');
  const changes = parseNameStatus(
    requireOk(await git.run({ gitDir, args: ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', input.head, parseMergeTree(trial.stdout).tree], readOnly: true, maxStdoutBytes: 64 * 1024 * 1024, timeoutMs }), 'listMergeChanges').stdout,
  ).map((change) => ({ letter: change.letter, path: change.path.path }));
  const inTheWay = await untrackedInTheWay(workTree, changes);
  if (inTheWay.length > 0) {
    throw new SmurgError('conflict', msg('git.stepFailed', { step: 'trialMerge' }), { reason: 'merge-refused', step: 'trialMerge', paths: inTheWay.slice(0, 20), count: inTheWay.length });
  }
  input.beforeMerge?.(changes.map((change) => change.path));

  // --no-commit: the commit is the daemon's own (staged, verified, two parents). --no-overwrite-ignore keeps git from
  // overwriting an ignored file that appeared since the check above. Attributes come from the branch head, which the
  // daemon committed.
  const merge = await git.run({
    gitDir,
    workTree,
    attrSource: input.head,
    args: ['merge', '--no-commit', '--no-ff', '--no-edit', '--no-verify', '--no-stat', '--quiet', '--no-overwrite-ignore', input.mainCommit],
    timeoutMs,
  });
  if (!(await exists(join(gitDir, 'MERGE_HEAD')))) {
    // git refused before it merged anything (unrelated histories, a file that appeared in the way): the working tree
    // is as it was.
    throw new SmurgError('conflict', msg('git.stepFailed', { step: 'trialMerge' }), { reason: 'merge-refused', step: 'trialMerge' });
  }
  // From here git is "merging". Either the daemon ends that state keeping the files and their markers (--quit), or,
  // when anything goes wrong, puts the working tree back to the branch head (--abort): never a half-merged tree that
  // nobody recorded, which the next commit would take for the item's own work.
  const abort = async (): Promise<void> => {
    await git.run({ gitDir, workTree, attrSource: input.head, args: ['merge', '--abort'], timeoutMs }).catch(() => null);
  };
  try {
    if (merge.code !== 0 && merge.code !== 1) requireOk(merge, 'trialMerge');
    const unmerged = requireOk(
      await git.run({ gitDir, workTree, attrSource: input.head, args: ['diff', '--name-only', '-z', '--diff-filter=U', '--no-ext-diff', '--ignore-submodules=all'], readOnly: true, maxStdoutBytes: 16 * 1024 * 1024, timeoutMs }),
      'listMergeChanges',
    );
    const seen = new Set<string>();
    for (const path of parseNameOnly(unmerged.stdout)) seen.add(path.path);
    requireOk(await git.run({ gitDir, workTree, args: ['merge', '--quit'], timeoutMs }), 'trialMerge');
    return { merged: true, conflicted: [...seen] };
  } catch (err) {
    await abort();
    throw err;
  }
}
