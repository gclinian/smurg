// The small parts the work-item paths of the worktree module are built from: names, the conflict-marker scan, the
// single-file helpers that never go through a link, the checkpoint message, what a non-host is not shown of a diff,
// the stored document's forms, and the second parent of a staged commit.
import { execFile } from 'node:child_process';
import { link, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MASKED, SmurgError, mergeRequestSchema, worktreeInfoSchema } from '@smurg/protocol';
import { createTempDir, isolatedGitEnv, removeTempDir } from '../../src/testing/index.ts';
import { filesWithConflictMarkers, plainFileKind, readPlainFileBelow, removeEntryBelow } from '../../src/worktree/fs-ops.ts';
import { GitRunner, findGit } from '../../src/worktree/git.ts';
import { checkpointMessage } from '../../src/worktree/main-repo.ts';
import { itemBranch } from '../../src/worktree/names.ts';
import { isWithheldFile, maskedDiffText, policyError, withheldEntry } from '../../src/worktree/review.ts';
import { stageCommit } from '../../src/worktree/stage-commit.ts';
import { storedMergeSchema, storedWorktreeSchema, toMergeRequest, toWorktreeInfo, worktreesDocumentSchema } from '../../src/worktree/store.ts';

const execFileAsync = promisify(execFile);

let dir = '';

beforeEach(async () => {
  dir = await createTempDir('p5-units');
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('names of a work item\'s worktree', () => {
  it('smurg/<topic slug>/<item id>, only from the protocol\'s own forms', () => {
    expect(itemBranch('checkout', 'cart-api')).toBe('smurg/checkout/cart-api');
    expect(itemBranch('a', '1')).toBe('smurg/a/1');
    expect(itemBranch('x'.repeat(48), 'y'.repeat(40))).toHaveLength(6 + 48 + 1 + 40);
    for (const [slug, itemId] of [['Checkout', 'a'], ['check out', 'a'], ['checkout', 'a.lock'], ['checkout', 'a/b'], ['..', 'a'], ['-x', 'a'], ['checkout', ''], ['', 'a'], ['checkout', 'a..b'], ['x'.repeat(49), 'a'], ['結帳', 'a']] as const) {
      expect(() => itemBranch(slug, itemId)).toThrow(/unsafe/);
    }
  });
});

describe('conflict markers', () => {
  const put = async (name: string, content: string | Buffer): Promise<void> => {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  };

  it('finds a line that starts with <<<<<<< or >>>>>>> the way git writes them, and nothing that only looks similar', async () => {
    await put('ours.ts', 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> 1234abcd\nd\n');
    await put('only-open.ts', 'a\n<<<<<<< HEAD\nb\n');
    await put('only-close.ts', 'x\n>>>>>>> theirs');
    await put('bare.ts', '<<<<<<<\n');
    await put('bare-end.ts', 'a\n>>>>>>>');
    await put('crlf.ts', 'a\r\n<<<<<<<\r\nb\r\n');
    await put('tab.ts', '>>>>>>>\tbranch\n');
    // Not markers: the separator alone, more or fewer characters, not at the start of a line, other characters after.
    await put('separator.md', 'Title\n=======\ntext\n');
    await put('eight.txt', '<<<<<<<< eight\n>>>>>>>> eight\n');
    await put('six.txt', '<<<<<< six\n>>>>>> six\n');
    await put('indented.txt', ' <<<<<<< HEAD\n\t>>>>>>> x\n');
    await put('glued.txt', '<<<<<<<HEAD\n>>>>>>>x\n');
    await put('shift.ts', 'const a = b <<<<<<< c;\nconst heredoc = `\n<<<<<<<EOF\n`;\n');
    await put('empty.txt', '');
    const all = ['ours.ts', 'only-open.ts', 'only-close.ts', 'bare.ts', 'bare-end.ts', 'crlf.ts', 'tab.ts', 'separator.md', 'eight.txt', 'six.txt', 'indented.txt', 'glued.txt', 'shift.ts', 'empty.txt'];
    expect(await filesWithConflictMarkers(dir, all)).toEqual(['ours.ts', 'only-open.ts', 'only-close.ts', 'bare.ts', 'bare-end.ts', 'crlf.ts', 'tab.ts']);
  });

  it('reads a file of any size in pieces: a marker across a piece\'s end, after a very long line, in a binary file', async () => {
    const piece = 256 * 1024;
    // The marker's seven characters straddle the first piece's end, at every offset.
    for (let before = piece - 9; before <= piece + 1; before++) {
      await put('straddle.txt', `${'x'.repeat(before - 1)}\n<<<<<<< HEAD\nrest\n`);
      expect(await filesWithConflictMarkers(dir, ['straddle.txt'])).toEqual(['straddle.txt']);
      await put('straddle.txt', `${'x'.repeat(before - 1)}\n<<<<<< six only\n`);
      expect(await filesWithConflictMarkers(dir, ['straddle.txt'])).toEqual([]);
    }
    await put('long-line.txt', `${'y'.repeat(3 * piece + 17)}\n>>>>>>> theirs\n`);
    await put('long-line-clean.txt', `${'<'.repeat(3 * piece)}\nfine\n`);
    await put('binary.bin', Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0x0a]), Buffer.from('<<<<<<< HEAD\n'), Buffer.alloc(1024, 0)]));
    await put('binary-clean.bin', Buffer.alloc(2 * piece, 0x3c));
    expect(await filesWithConflictMarkers(dir, ['long-line.txt', 'long-line-clean.txt', 'binary.bin', 'binary-clean.bin'])).toEqual(['long-line.txt', 'binary.bin']);
  });

  it('a file that is gone (or is no file any more) is resolved; what cannot be read safely is not', async () => {
    await put('kept/a.ts', '<<<<<<< HEAD\n');
    await put('outside/b.ts', '<<<<<<< HEAD\n');
    await put('plain-file', 'x\n');
    await mkdir(join(dir, 'now-a-dir.ts'));
    await symlink(join(dir, 'kept', 'a.ts'), join(dir, 'link.ts'));
    await symlink(join(dir, 'outside'), join(dir, 'linked-dir'));
    expect(
      await filesWithConflictMarkers(dir, [
        'kept/a.ts',
        'missing.ts', // deleted as the resolution
        'missing-dir/x.ts',
        'plain-file/below.ts', // a file where a folder was: nothing lies below it
        'now-a-dir.ts', // a folder now
        'link.ts', // a link is its target's text, not a file with markers
        'linked-dir/b.ts', // behind a link: not the daemon's to read; counts as unresolved
      ]),
    ).toEqual(['kept/a.ts', 'linked-dir/b.ts']);
  });
});

describe('single files below a root, never through a link', () => {
  it('removeEntryBelow removes a file, a link (not its target) or a folder; a link on the way blocks it', async () => {
    await mkdir(join(dir, 'specs', 'checkout', 'reports'), { recursive: true });
    await mkdir(join(dir, 'outside'), { recursive: true });
    await writeFile(join(dir, 'outside', 'cart-api.md'), 'keep me\n');
    const report = 'specs/checkout/reports/cart-api.md';
    expect(await removeEntryBelow(dir, report)).toBe('absent');
    expect(await removeEntryBelow(dir, 'specs/nothing/reports/cart-api.md')).toBe('absent');
    await writeFile(join(dir, report), 'old\n');
    expect(await removeEntryBelow(dir, report)).toBe('removed');
    expect(await lstat(join(dir, report)).catch(() => null)).toBeNull();
    // A link under the report's own name goes; what it points to stays.
    await symlink(join(dir, 'outside', 'cart-api.md'), join(dir, report));
    expect(await removeEntryBelow(dir, report)).toBe('removed');
    expect(await readFile(join(dir, 'outside', 'cart-api.md'), 'utf8')).toBe('keep me\n');
    // A folder under that name, with content.
    await mkdir(join(dir, report, 'deep'), { recursive: true });
    await writeFile(join(dir, report, 'deep', 'x'), 'x\n');
    expect(await removeEntryBelow(dir, report)).toBe('removed');
    expect(await lstat(join(dir, report)).catch(() => null)).toBeNull();
    // A link on the way: nothing is touched.
    await symlink(join(dir, 'outside'), join(dir, 'specs', 'checkout', 'linked'));
    expect(await removeEntryBelow(dir, 'specs/checkout/linked/cart-api.md')).toBe('blocked');
    expect(await readFile(join(dir, 'outside', 'cart-api.md'), 'utf8')).toBe('keep me\n');
    await writeFile(join(dir, 'specs', 'checkout', 'a-file'), 'x\n');
    expect(await removeEntryBelow(dir, 'specs/checkout/a-file/cart-api.md')).toBe('blocked');
    expect(await removeEntryBelow(dir, '')).toBe('blocked');
  });

  it('readPlainFileBelow / plainFileKind: a regular file reached through plain folders, within the bound; a link is never "missing"', async () => {
    await mkdir(join(dir, 'specs', 'checkout'), { recursive: true });
    await mkdir(join(dir, 'outside'), { recursive: true });
    await writeFile(join(dir, 'specs', 'checkout', 'SPEC.md'), '# Checkout\n');
    await writeFile(join(dir, 'outside', 'secret'), 'TOP SECRET\n');
    await symlink(join(dir, 'outside', 'secret'), join(dir, 'specs', 'checkout', 'PLAN.md'));
    await symlink(join(dir, 'outside'), join(dir, 'specs', 'linked'));
    await symlink(join(dir, 'nowhere'), join(dir, 'specs', 'dangling'));
    expect((await readPlainFileBelow(dir, 'specs/checkout/SPEC.md', 1024))?.toString()).toBe('# Checkout\n');
    expect(await readPlainFileBelow(dir, 'specs/checkout/SPEC.md', 5)).toBe('too-large');
    expect(await plainFileKind(dir, 'specs/checkout/SPEC.md')).toBe('file');
    const kinds: Record<string, 'missing' | 'other'> = {
      'specs/checkout/PLAN.md': 'other', // a link
      'specs/linked/secret': 'other', // behind a link
      'specs/linked/not-there': 'other', // behind a link, whatever is there
      'specs/dangling': 'other', // a link to nothing is still a link
      'specs/dangling/x': 'other',
      'specs/checkout': 'other', // a folder
      'specs/checkout/MISSING.md': 'missing',
      'nope/SPEC.md': 'missing',
      'specs/checkout/SPEC.md/below': 'missing', // nothing lies below a file
      '': 'other',
    };
    for (const [path, kind] of Object.entries(kinds)) {
      expect(await readPlainFileBelow(dir, path, 1024), path).toBeNull();
      expect(await plainFileKind(dir, path), path).toBe(kind);
    }
  });
});

describe('the checkpoint\'s commit message', () => {
  it('puts the trailers into one last paragraph, one per line, and nothing a trailer value could break out with', () => {
    expect(checkpointMessage('smurg: spec and plan of checkout', [])).toBe('smurg: spec and plan of checkout\n');
    expect(checkpointMessage('  smurg: spec and plan of checkout\n\n', ['Edited-by: Amy', 'Edited-by: Ian'])).toBe('smurg: spec and plan of checkout\n\nEdited-by: Amy\nEdited-by: Ian\n');
    // A name with a line break cannot start a paragraph or a second trailer of its own.
    expect(checkpointMessage('subject', ['Edited-by: Amy\n\nSigned-off-by: Somebody Else', '   ', 'Edited-by: Ian\r\n'])).toBe('subject\n\nEdited-by: Amy Signed-off-by: Somebody Else\nEdited-by: Ian\n');
    expect(checkpointMessage('sub\u0000ject', ['Edited-by: A\u0000my'])).toBe('subject\n\nEdited-by: A my\n');
    expect(checkpointMessage('subject', Array.from({ length: 150 }, (_, i) => `Edited-by: ${i}`)).trim().split('\n')).toHaveLength(102);
    expect(checkpointMessage('subject', [`Edited-by: ${'n'.repeat(1000)}`]).split('\n')[2]).toHaveLength(400);
  });
});

describe('what a member who is not the host is not shown of a diff', () => {
  it('a file on a host-private path under its new or its old name, at any depth and in any spelling the file system folds', () => {
    const file = (path: string, oldPath?: string) => ({ path, status: oldPath === undefined ? ('modified' as const) : ('renamed' as const), additions: 3, deletions: 1, ...(oldPath === undefined ? {} : { oldPath }) });
    for (const path of ['.envrc', 'apps/web/.envrc', '.claude/settings.local.json', 'pkg/.claude/settings.local.json', 'CLAUDE.local.md', 'docs/CLAUDE.local.md', '.ENVRC', 'claude.local.md', '.git/config']) {
      expect(isWithheldFile(file(path))).toBe(true);
    }
    for (const path of ['src/app.ts', 'CLAUDE.md', '.claude/settings.json', '.mcp.json', 'envrc', 'docs/settings.local.json', 'specs/checkout/SPEC.md']) {
      expect(isWithheldFile(file(path))).toBe(false);
    }
    expect(isWithheldFile(file('env.txt', '.envrc'))).toBe(true);
    expect(isWithheldFile(file('nested/.envrc', 'docs/notes.md'))).toBe(true);
    // Listed by name and status only.
    expect(withheldEntry({ ...file('env.txt', '.envrc'), binary: true })).toEqual({ path: 'env.txt', status: 'renamed', additions: 0, deletions: 0, oldPath: '.envrc', hidden: true });
    expect(withheldEntry(file('.envrc'))).toEqual({ path: '.envrc', status: 'modified', additions: 0, deletions: 0, hidden: true });
  });

  it('diff text is masked, then fitted: a mask that makes the text longer never pushes it past the limit', () => {
    const text = '+password=abcd\n'.repeat(100);
    const whole = maskedDiffText(Buffer.from(text), 1024 * 1024, false);
    expect(whole).toEqual({ diff: `+password=${MASKED}\n`.repeat(100), truncated: false });
    const tight = maskedDiffText(Buffer.from(text), Buffer.byteLength(text), false);
    expect(Buffer.byteLength(tight.diff)).toBeLessThanOrEqual(Buffer.byteLength(text));
    expect(tight.truncated).toBe(true);
    expect(tight.diff).not.toContain('abcd');
    // Bytes that are no text become U+FFFD, a NUL too (the wire's strings carry none).
    expect(maskedDiffText(Buffer.from([0x2b, 0xff, 0x00, 0x0a]), 1024, false).diff).toBe('+��\n');
    expect(maskedDiffText(Buffer.from('+ok\n'), 1024, true)).toEqual({ diff: '+ok\n', truncated: true });
  });

  it('the policy\'s refusal of a work item that touches its topic\'s two files is an error only the host is past', () => {
    const error = policyError({ reason: 'spec-files', paths: ['specs/checkout/SPEC.md'] });
    expect(error).toBeInstanceOf(SmurgError);
    expect(error).toMatchObject({ code: 'host_only', text: { id: 'report.changes.specFiles' }, detail: { reason: 'spec-files', paths: ['specs/checkout/SPEC.md'], count: 1 } });
  });
});

describe('worktrees.json', () => {
  const HASH = 'a'.repeat(64);
  const COMMIT = 'c'.repeat(40);
  const worktree = { id: `wt_${'0'.repeat(24)}`, ownerUserId: 'dev:mei', ownerName: 'mei', branch: 'smurg/checkout/cart-api', kept: false, createdAt: 1, sharedDirs: [], baseCommit: COMMIT, configHash: HASH, headHash: HASH, alternatesHash: HASH };
  const merge = { id: `mr_${'0'.repeat(24)}`, worktreeId: worktree.id, ownerUserId: 'dev:mei', commit: COMMIT, status: 'draft' as const, createdAt: 2 };

  it('a work item\'s worktree and a draft are stored with their item; the wire forms follow', () => {
    const item = { topicId: 'tp_checkout', topicSlug: 'checkout', itemId: 'cart-api' };
    const stored = storedWorktreeSchema.parse({ ...worktree, item, merge: { parent: COMMIT, conflicted: ['src/app.ts'] }, handEdits: [{ path: 'src/app.ts', by: [{ userId: 'dev:amy', displayName: 'Amy' }] }] });
    const info = toWorktreeInfo(stored);
    expect(worktreeInfoSchema.safeParse(info).success).toBe(true);
    // The merge state and the hand edits are the daemon's own: not on the wire.
    expect(info).toEqual({ id: worktree.id, ownerUserId: 'dev:mei', ownerName: 'mei', branch: 'smurg/checkout/cart-api', kept: false, createdAt: 1, sharedDirs: [], topicId: 'tp_checkout', itemId: 'cart-api' });
    expect(toWorktreeInfo(storedWorktreeSchema.parse({ ...worktree, sessionId: 'ses_1' }))).toEqual({ id: worktree.id, ownerUserId: 'dev:mei', ownerName: 'mei', branch: 'smurg/checkout/cart-api', sessionId: 'ses_1', kept: false, createdAt: 1, sharedDirs: [] });

    const draft = toMergeRequest(storedMergeSchema.parse({ ...merge, topicId: 'tp_checkout', itemId: 'cart-api', topicSlug: 'checkout', message: 'smurg: work item 1 (cart-api)' }));
    expect(mergeRequestSchema.safeParse(draft).success).toBe(true);
    expect(draft).toEqual({ id: merge.id, worktreeId: worktree.id, commit: COMMIT, status: 'draft', reviewed: false, createdAt: 2, topicId: 'tp_checkout', itemId: 'cart-api', message: 'smurg: work item 1 (cart-api)' });
    expect(toMergeRequest(storedMergeSchema.parse({ ...merge, status: 'pending', reviewed: true, requestedBy: { userId: 'dev:mei', displayName: 'mei' } }))).toMatchObject({ status: 'pending', reviewed: true, requestedBy: { userId: 'dev:mei', displayName: 'mei' } });
  });

  it('refuses what is not one of its forms (a file that does not match stops the daemon, it is never repaired)', () => {
    expect(storedWorktreeSchema.safeParse({ ...worktree, item: { topicId: 'tp_1', topicSlug: 'Not A Slug', itemId: 'a' } }).success).toBe(false);
    expect(storedWorktreeSchema.safeParse({ ...worktree, item: { topicId: 'tp_1', topicSlug: 'checkout', itemId: '../a' } }).success).toBe(false);
    expect(storedWorktreeSchema.safeParse({ ...worktree, merge: { parent: 'HEAD', conflicted: [] } }).success).toBe(false);
    expect(storedWorktreeSchema.safeParse({ ...worktree, handEdits: [{ path: '../outside', by: [] }] }).success).toBe(false);
    expect(storedMergeSchema.safeParse({ ...merge, status: 'open' }).success).toBe(false);
    expect(storedMergeSchema.safeParse({ ...merge, reviewed: false }).success).toBe(false);
    expect(storedMergeSchema.safeParse({ ...merge, extra: 1 }).success).toBe(false);
    expect(worktreesDocumentSchema.safeParse({ version: 1, worktrees: [worktree], merges: [merge] }).success).toBe(true);
    expect(worktreesDocumentSchema.safeParse({ version: 2, worktrees: [], merges: [] }).success).toBe(false);
  });
});

describe('a staged commit with a second parent', { timeout: 60_000 }, () => {
  it('records the merged commit as its second parent, even when the tree is the branch head\'s; verification still covers every blob', async () => {
    const home = join(dir, 'home');
    const main = join(dir, 'main');
    const staging = join(dir, 'staging');
    await mkdir(home);
    await mkdir(main);
    await mkdir(staging);
    const env = isolatedGitEnv(home);
    const git = async (args: string[], cwd: string): Promise<string> => (await execFileAsync('git', args, { cwd, env })).stdout.trim();
    await git(['init', '-q', '-b', 'main'], main);
    await writeFile(join(main, 'a.txt'), 'one\n');
    await git(['add', '.'], main);
    await git(['commit', '-q', '-m', 'init'], main);
    const clone = join(dir, 'clone');
    await git(['clone', '-q', '--shared', main, clone], dir);
    await git(['checkout', '-q', '-b', 'smurg/t/i'], clone);
    await writeFile(join(main, 'b.txt'), 'from main\n');
    await git(['add', '.'], main);
    await git(['commit', '-q', '-m', 'main moved'], main);
    const mainHead = await git(['rev-parse', 'HEAD'], main);
    const branchHead = await git(['rev-parse', 'HEAD'], clone);

    const gitPath = await findGit(process.env['PATH']);
    if (gitPath === null) throw new Error('git not found');
    const runner = new GitRunner({ gitPath, home });
    const identity = { name: 'mei', email: 'dev-mei@users.smurg.invalid' };
    const base = { git: runner, workTree: clone, branch: 'smurg/t/i', identity, stagingRoot: staging, verify: true } as const;

    // Nothing changed and nothing merged: no commit.
    expect(await stageCommit({ ...base, message: 'nothing' })).toEqual({ commit: branchHead, created: false });
    // Nothing changed, but a merge is owed: the commit is made, with both parents and the head's tree.
    const joined = await stageCommit({ ...base, message: 'smurg: joined', secondParent: mainHead });
    expect(joined.created).toBe(true);
    expect((await git(['rev-list', '--parents', '-n', '1', joined.commit], clone)).split(' ')).toEqual([joined.commit, branchHead, mainHead]);
    expect(await git(['rev-parse', `${joined.commit}^{tree}`], clone)).toBe(await git(['rev-parse', `${branchHead}^{tree}`], clone));
    expect(await git(['rev-parse', 'refs/heads/smurg/t/i'], clone)).toBe(joined.commit);
    expect(await git(['log', '-1', '--format=%an|%s', joined.commit], clone)).toBe('mei|smurg: joined');
    // With content: the merged file from main and the worktree's own, both verified against the working tree.
    await writeFile(join(clone, 'b.txt'), 'from main\n');
    await writeFile(join(clone, 'c.txt'), 'the item\'s own\n');
    const merged = await stageCommit({ ...base, message: 'smurg: merged', secondParent: mainHead });
    expect((await git(['rev-list', '--parents', '-n', '1', merged.commit], clone)).split(' ')).toEqual([merged.commit, joined.commit, mainHead]);
    expect(await git(['ls-tree', '--name-only', '-r', merged.commit], clone)).toBe('a.txt\nb.txt\nc.txt');
    // A hard link to a file outside is still refused, second parent or not; the branch does not move.
    await link(join(home, '..', 'main', 'a.txt'), join(clone, 'stolen.txt'));
    await expect(stageCommit({ ...base, message: 'x', secondParent: mainHead })).rejects.toMatchObject({ code: 'conflict', detail: { reason: 'hard-link' } });
    expect(await git(['rev-parse', 'refs/heads/smurg/t/i'], clone)).toBe(merged.commit);
    await expect(stageCommit({ ...base, message: 'x', secondParent: 'HEAD' })).rejects.toThrow(/object id/);
  });
});
