// smurg's own history of a shared folder without `.git` (DESIGN 0.6.0 D14, worktree/hidden-repo.ts): the REAL worktree
// module over scratch folders, with the real git on PATH (2.42 or later; without one these tests say so and are
// skipped, loudly, never passed). What it holds:
//  - the exclude lines are generated: every host-private sample is ignored at the top and nested, with the dependency
//    folders, a shared directory and a nested repository; a host-private file under a spelling no glob catches is
//    left out by name;
//  - lazy and crash-safe creation: nothing before the first thing that needs it, `.smurg/git` made under another name,
//    recorded, renamed; `core.worktree` unset and no `.git` in the user's folder; leftovers removed; a record without
//    `.smurg/git` starts anew unless records of it remain (`worktree.hidden.gone`); a `.smurg/git` without a record is
//    never adopted (`worktree.hidden.unknown`); an empty `.git` directory keeps 0.5.2's answer and gets no history;
//  - snapshot, clone, commit, merge: a person's edit in the folder stays, a conflict is named and the folder untouched,
//    a write between the snapshot and the merge is refused; what an agent installs in its checkout is never committed;
//  - the size bound refuses before anything is written; a listing over the runner's 4 MiB default is read whole;
//  - tampering is refused (config, HEAD, a link, alternates, grafts, shallow, replace refs), and so is a merge whose
//    base moved since its review (the recorded base);
//  - a stale index.lock, a snapshot killed by its deadline, the disk check, the repack rule, nested repositories, a
//    cloud-synced folder;
//  - the user's own `git init && git add -A` takes nothing of `.smurg`, and records of smurg's history keep merging
//    after `.git` appears while new work uses `.git`.
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOST_PERSONAL_FILES } from '@smurg/protocol';
import { createTempDir, createTestDaemon, isolatedGitEnv, removeTempDir, type TestDaemon } from '../../src/testing/index.ts';
import { GIT_MIN_VERSION, findGit, gitVersionAtLeast, parseGitVersion } from '../../src/worktree/git.ts';
import { hiddenExcludeLines, isCloudSynced, repackWhenLoose, sizeText } from '../../src/worktree/hidden-repo.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import { initialWorktreesDocument, worktreesDocumentSchema, type WorktreesDocument } from '../../src/worktree/store.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';
import { GitRunner } from '../../src/worktree/git.ts';
import { restartDaemonWith } from './restart.ts';
import { settleError, startWorktreeStack, type WorktreeStack, type WorktreeStackOptions } from './support.ts';

const run = promisify(execFile);

/** The real git on PATH, when it is new enough: these tests need it. */
async function realGit(): Promise<string | null> {
  const path = await findGit(process.env['PATH']);
  if (path === null) return null;
  const out = await run(path, ['version']).then((result) => result.stdout, () => '');
  const version = parseGitVersion(out);
  return version !== null && gitVersionAtLeast(version, GIT_MIN_VERSION) ? path : null;
}
const GIT = await realGit();
if (GIT === null) console.warn(`[hidden-repo] SKIPPED: these tests need git ${GIT_MIN_VERSION.join('.')} or later on PATH`);
const withGit = GIT === null ? describe.skip : describe;

let stack: WorktreeStack | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await stack?.cleanup();
  stack = null;
  for (const dir of dirs.splice(0)) await removeTempDir(dir).catch(() => {});
}, 60_000);

const FILES = { 'README.md': '# demo\n', 'src/app.ts': 'export const answer = 42;\n', 'specs/checkout/SPEC.md': '# Checkout\n', 'specs/checkout/PLAN.md': '# Plan\n' };

async function dropStack(): Promise<void> {
  const running = stack;
  stack = null;
  await running?.cleanup();
}

async function hiddenStack(options: Omit<WorktreeStackOptions, 'git'> = {}): Promise<WorktreeStack> {
  stack = await startWorktreeStack({ git: false, files: FILES, ...options });
  return stack;
}

function share(s: WorktreeStack): string {
  return s.t.ctx.roots.main.realPath;
}
function hiddenOf(s: WorktreeStack): string {
  return join(share(s), '.smurg', 'git');
}
async function docOf(s: WorktreeStack): Promise<WorktreesDocument> {
  return (await s.t.ctx.state.document('worktrees', worktreesDocumentSchema, initialWorktreesDocument)).get();
}
async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}
/** git on smurg's history as the test sees it (an isolated HOME). */
function hiddenGit(s: WorktreeStack, ...args: string[]): Promise<string> {
  return s.git(['--git-dir', hiddenOf(s), '--work-tree', share(s), ...args]);
}
async function hiddenFiles(s: WorktreeStack): Promise<string[]> {
  return (await hiddenGit(s, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n').filter(Boolean).sort();
}
/** The host's own worktree (the host's request may look for git, and makes smurg's history). */
async function hostWorktree(s: WorktreeStack, sessionId = 'ses_host'): Promise<{ id: string; dir: string }> {
  const handle = await s.manager.acquireForSession({ owner: s.principal(s.host.userId), sessionId });
  return { id: handle.worktree.id, dir: s.worktreeDir(handle.worktree.id) };
}

// ---------------------------------------------------------------------------------------------------------------------

withGit('the exclude lines of smurg\'s own history (hiddenExcludeLines)', { timeout: 60_000 }, () => {
  let repo = '';
  let home = '';
  beforeAll(async () => {
    repo = await createTempDir('hidden-excludes');
    home = await createTempDir('hidden-excludes-home');
    await run('git', ['init', '-q'], { cwd: repo, env: isolatedGitEnv(home) });
    await writeFile(join(repo, '.git', 'info', 'exclude'), `${hiddenExcludeLines({ sharedDirs: ['datasets', 'assets/big'], nestedRepos: ['frontend'] }).join('\n')}\n`);
  });
  afterAll(async () => {
    await removeTempDir(repo).catch(() => {});
    await removeTempDir(home).catch(() => {});
  });
  const ignored = async (path: string): Promise<boolean> => {
    const result = await run('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: repo, env: isolatedGitEnv(home) }).then(
      () => 0,
      (err: { code?: number }) => err.code ?? -1,
    );
    if (result !== 0 && result !== 1) throw new Error(`git check-ignore failed for ${path}`);
    return result === 0;
  };

  // The host-private samples of the protocol's paths.test.ts that a glob can name (the HFS+-ignorable spelling is left
  // out by name at each snapshot, see "a host-private file under a spelling no glob catches" below).
  const HOST_PRIVATE = ['.claude/settings.local.json', 'CLAUDE.local.md', '.git/config', '.git/logs/HEAD', '.envrc', ...HOST_PERSONAL_FILES];
  it.each(HOST_PRIVATE)('%s is ignored at the top and nested', async (path) => {
    expect(await ignored(path)).toBe(true);
    expect(await ignored(`a/b/${path}`)).toBe(true);
    expect(await ignored(`x/${path}`)).toBe(true);
  });

  it('the dependency folders, .DS_Store, the shared directories, nested repositories and smurg\'s folder; not what is merely alike', async () => {
    for (const path of ['node_modules/x/i.js', 'web/node_modules/y.js', '.venv/bin/python', 'pkg/__pycache__/m.pyc', '.DS_Store', 'docs/.DS_Store', 'datasets/a.csv', 'assets/big/x.bin', 'frontend/src/app.ts', '.smurg/git/HEAD']) {
      expect(await ignored(path), path).toBe(true);
    }
    for (const path of ['src/app.ts', 'docs/datasets/a.csv', 'assets/small/x.bin', 'web/frontend/x', '.envrc.example', 'CLAUDE.local.md.bak', 'settings.local.json', '.claude/settings.json', 'README.md']) {
      expect(await ignored(path), path).toBe(false);
    }
  });

  it('a clone\'s lines are the same without /.smurg/; the shared directories and nested repositories are anchored to the top', () => {
    const forClone = hiddenExcludeLines({ sharedDirs: ['datasets'], nestedRepos: ['web/frontend'], forClone: true });
    expect(forClone).not.toContain('/.smurg/');
    expect(forClone).toEqual(expect.arrayContaining(['node_modules/', '**/.claude/settings.local.json', '.envrc', 'CLAUDE.local.md', '.git/', '/datasets/', '/web/frontend/']));
    expect(hiddenExcludeLines({ sharedDirs: ['../x', ''] }).some((line) => line.includes('..'))).toBe(false);
  });

  it('isCloudSynced: below the home\'s iCloud Drive, File Provider folders and Dropbox only', () => {
    expect(isCloudSynced('/Users/ian/Library/CloudStorage/GoogleDrive-ian/project', '/Users/ian')).toBe(true);
    expect(isCloudSynced('/Users/ian/Library/Mobile Documents/com~apple~CloudDocs/p', '/Users/ian/')).toBe(true);
    expect(isCloudSynced('/Users/ian/Dropbox/p', '/Users/ian')).toBe(true);
    expect(isCloudSynced('/Users/ian/Dropboxy/p', '/Users/ian')).toBe(false);
    expect(isCloudSynced('/Users/ian/code/p', '/Users/ian')).toBe(false);
    expect(isCloudSynced('/Users/ian/Dropbox/p', null)).toBe(false);
  });

  it('sizeText says the bound as the refusal does', () => {
    expect(sizeText(1024 ** 3)).toBe('1 GB');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(20 * 1024 * 1024)).toBe('20 MB');
    expect(sizeText(12)).toBe('12 bytes');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

withGit('smurg\'s own history: made lazily and crash-safely, never adopted, never beside a .git', { timeout: 90_000 }, () => {
  it('nothing before the first thing that needs it; then .smurg/git with core.worktree unset, no .git in the folder, and a record of its config and HEAD', async () => {
    const s = await hiddenStack();
    await s.manager.mainState();
    expect(s.manager.workState()).toEqual({ history: 'smurg' });
    expect(await exists(hiddenOf(s))).toBe(false);
    expect((await docOf(s)).hidden).toBeUndefined();

    const facts = await s.manager.prepareStart();
    expect(facts).toEqual({ nestedRepos: [], cloudSynced: false, problem: null });
    expect(await exists(hiddenOf(s))).toBe(true);
    const config = await readFile(join(hiddenOf(s), 'config'), 'utf8');
    expect(config).not.toMatch(/worktree\s*=/);
    expect(await readFile(join(hiddenOf(s), 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(await exists(join(share(s), '.git'))).toBe(false);
    // A plain git in the folder finds no repository: the user's folder is not one.
    expect((await s.gitCode(['rev-parse', '--git-dir'])).code).not.toBe(0);
    const record = (await docOf(s)).hidden;
    expect(record).toMatchObject({ configHash: expect.stringMatching(/^[0-9a-f]{64}$/), headHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // No leftover of the making: only `git` and smurg's usual entries below .smurg.
    expect((await readdir(join(share(s), '.smurg'))).filter((name) => name.startsWith('git'))).toEqual(['git']);
  });

  it('a crash between the record and the rename: leftovers go and the next use starts anew; with records of it, the history is gone', async () => {
    const s = await hiddenStack();
    await s.manager.prepareStart();
    const first = (await docOf(s)).hidden;
    // As a crash leaves it: the record, no .smurg/git, a half-made directory.
    await rm(hiddenOf(s), { recursive: true, force: true });
    await mkdir(join(share(s), '.smurg', 'git.new-0123456789abcdef', 'objects'), { recursive: true });
    s.t.advanceClock(1_000);
    expect(await s.manager.prepareStart()).toMatchObject({ problem: null });
    expect(await exists(hiddenOf(s))).toBe(true);
    expect(await exists(join(share(s), '.smurg', 'git.new-0123456789abcdef'))).toBe(false);
    expect((await docOf(s)).hidden?.createdAt).toBeGreaterThan(first?.createdAt ?? 0);

    // A worktree made from it, then .smurg/git removed: what was made from it can only be rejected.
    const worktree = await hostWorktree(s);
    await rm(hiddenOf(s), { recursive: true, force: true });
    const gone = { code: 'conflict', reason: 'hidden-repo-gone', text: { id: 'worktree.hidden.gone' } };
    expect((await s.manager.mainState()).unavailable).toEqual({ id: 'worktree.hidden.gone' });
    expect((await s.manager.prepareStart()).problem).toEqual({ id: 'worktree.hidden.gone' });
    expect(await settleError(s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId)))).toMatchObject(gone);
    expect(await exists(hiddenOf(s))).toBe(false);
    // Removing that worktree (no repository needed) lets the next use start anew.
    await s.manager.releaseFromSession(worktree.id, 'ses_host', { keep: false });
    expect(await s.manager.prepareStart()).toMatchObject({ problem: null });
    expect(await exists(hiddenOf(s))).toBe(true);
  });

  it('a .smurg/git this workspace has no record of is never adopted; an empty .git directory keeps 0.5.2\'s answer and gets no history', async () => {
    const s = await hiddenStack();
    // Someone's own .smurg/git (another workspace of this folder, a copy): refused, not used, not changed.
    await mkdir(join(share(s), '.smurg'), { recursive: true });
    await s.git(['--git-dir', hiddenOf(s), 'init', '-q']);
    const planted = await readFile(join(hiddenOf(s), 'config'), 'utf8');
    expect((await s.manager.mainState()).unavailable).toEqual({ id: 'worktree.hidden.unknown' });
    expect((await s.manager.prepareStart()).problem).toEqual({ id: 'worktree.hidden.unknown' });
    expect(await settleError(s.manager.acquireForSession({ owner: s.principal(s.host.userId), sessionId: 'ses_x' }))).toMatchObject({ reason: 'hidden-repo-unknown', text: { id: 'worktree.hidden.unknown' } });
    expect(await settleError(s.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'm', trailers: [], as: s.principal(s.host.userId) }))).toMatchObject({ reason: 'hidden-repo-unknown' });
    expect(await readFile(join(hiddenOf(s), 'config'), 'utf8')).toBe(planted);
    expect((await docOf(s)).hidden).toBeUndefined();
    // The host moves it away: the next Start makes smurg's own.
    await rename(hiddenOf(s), join(share(s), 'moved-away.git'));
    expect((await s.manager.prepareStart()).problem).toBeNull();
    expect((await docOf(s)).hidden).toBeDefined();
    await rm(join(share(s), 'moved-away.git'), { recursive: true });

    // An empty `.git` directory: no repository, as 0.5.2 said, and smurg makes no history beside it.
    const t2 = await startWorktreeStack({ git: false, files: FILES });
    try {
      await mkdir(join(t2.t.ctx.roots.main.realPath, '.git'));
      await t2.manager.refreshGitState();
      expect(await t2.manager.mainState()).toMatchObject({ history: 'folder', unavailable: { id: 'worktree.unavailable.notAGitRepo' } });
      expect(await t2.manager.prepareStart()).toEqual({ nestedRepos: [], cloudSynced: false, problem: null });
      expect(await exists(join(t2.t.ctx.roots.main.realPath, '.smurg', 'git'))).toBe(false);
    } finally {
      await t2.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

withGit('smurg\'s own history: snapshots, worktrees and merges', { timeout: 120_000 }, () => {
  it('a worktree from a snapshot of the folder, its change merged into the folder while a person\'s edit stays; the user\'s own git takes nothing of .smurg', async () => {
    const s = await hiddenStack();
    const worktree = await hostWorktree(s);
    // The checkout is the folder as it was: the files, no .smurg, nothing that is the host's alone.
    expect(await readFile(join(worktree.dir, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
    expect(await exists(join(worktree.dir, '.smurg'))).toBe(false);
    expect((await docOf(s)).worktrees.find((record) => record.id === worktree.id)?.repo).toBe('smurg');
    expect(await hiddenGit(s, 'log', '-1', '--format=%s')).toBe('smurg: the shared folder for a new worktree\n');
    // The agent changes a file and installs dependencies in its checkout; a person edits another file in the folder.
    await writeFile(join(worktree.dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await mkdir(join(worktree.dir, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(worktree.dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    await writeFile(join(share(s), 'README.md'), '# demo, edited by Amy\n');
    const request = await s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId));
    const diff = await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(diff.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect((await docOf(s)).merges.find((merge) => merge.id === request.id)).toMatchObject({ repo: 'smurg', base: expect.stringMatching(/^[0-9a-f]{40}/) });
    const merged = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.request.status).toBe('merged');
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect(await readFile(join(share(s), 'README.md'), 'utf8')).toBe('# demo, edited by Amy\n');
    expect(await exists(join(share(s), 'node_modules'))).toBe(false);
    expect(await hiddenGit(s, 'log', '-2', '--format=%s')).toMatch(/^Merge smurg\/.*\nsmurg: the shared folder before merging smurg\//);
    expect(await hiddenFiles(s)).not.toContain('node_modules/left-pad/index.js');

    // The user makes the folder a repository: `git init && git add -A` takes nothing of .smurg (its .gitignore).
    await s.git(['init', '-q', '-b', 'main']);
    await s.git(['add', '-A']);
    expect((await s.git(['ls-files'])).split('\n').filter((path) => path.startsWith('.smurg'))).toEqual([]);
  });

  it('a conflict is named and the folder untouched; a person\'s write between the snapshot and the merge is refused with its name', async () => {
    const gitPath = GIT as string;
    const bin = await createTempDir('hidden-race-git');
    dirs.push(bin);
    const flag = join(bin, 'race');
    const wrapper = join(bin, 'git');
    // A person writes README.md right after smurg's snapshot, while the merge is being decided (merge-tree runs).
    await writeFile(wrapper, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = merge-tree ] && [ -f '${flag}' ]; then printf 'typed meanwhile\\n' >> "$(cat '${flag}')"; rm -f '${flag}'; fi; done\nexec '${gitPath}' "$@"\n`, { mode: 0o755 });
    const s = await hiddenStack({ module: { gitPath: wrapper } });
    const worktree = await hostWorktree(s);
    // 1. The item and a person changed the same line: a conflict, named; the folder is as it was.
    await writeFile(join(worktree.dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(share(s), 'src', 'app.ts'), 'export const answer = 44;\n');
    const conflicting = await s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId));
    const outcome = await s.host.conn.request('worktree.merge.approve', { requestId: conflicting.id });
    expect(outcome.request).toMatchObject({ status: 'conflict', conflictFiles: ['src/app.ts'] });
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 44;\n');
    expect(await exists(join(hiddenOf(s), 'MERGE_HEAD'))).toBe(false);

    // 2. A change of another file, and a person's write in the moment between snapshot and merge: refused, named.
    await writeFile(join(share(s), 'src', 'app.ts'), 'export const answer = 42;\n');
    const second = await hostWorktree(s, 'ses_second');
    await writeFile(join(second.dir, 'README.md'), '# demo, by the item\n');
    const request = await s.manager.requestMerge({ worktreeId: second.id }, s.principal(s.host.userId));
    await writeFile(flag, join(share(s), 'README.md'));
    const raced = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(raced.request).toMatchObject({ status: 'conflict', conflictFiles: ['README.md'] });
    expect(await readFile(join(share(s), 'README.md'), 'utf8')).toBe('# demo\ntyped meanwhile\n');
  });

  it('what a checkout\'s agent installs is never committed; the clone\'s exclude is written again before each commit', async () => {
    const s = await hiddenStack({ settings: { sharedDirs: ['datasets'] } });
    await mkdir(join(share(s), 'datasets'), { recursive: true });
    await writeFile(join(share(s), 'datasets', 'big.csv'), 'a,b\n');
    const worktree = await hostWorktree(s);
    // The shared directory is a link in the checkout, and not part of smurg's history.
    expect((await lstat(join(worktree.dir, 'datasets'))).isSymbolicLink()).toBe(true);
    expect(await hiddenFiles(s)).not.toContain('datasets/big.csv');
    // The session empties its exclude file; the commit writes it again.
    await writeFile(join(worktree.dir, '.git', 'info', 'exclude'), '');
    await mkdir(join(worktree.dir, 'web', 'node_modules', 'x'), { recursive: true });
    await writeFile(join(worktree.dir, 'web', 'node_modules', 'x', 'a.js'), '1\n');
    await mkdir(join(worktree.dir, '.venv', 'bin'), { recursive: true });
    await writeFile(join(worktree.dir, '.venv', 'bin', 'python'), '#!\n');
    await writeFile(join(worktree.dir, 'src', 'new.ts'), 'export {};\n');
    const request = await s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId));
    const diff = await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(diff.files.map((file) => file.path)).toEqual(['src/new.ts']);
    expect(await readFile(join(worktree.dir, '.git', 'info', 'exclude'), 'utf8')).toContain('node_modules/');
  });

  it('the size bound refuses before anything is written (files, then bytes); a listing over 4 MiB is read whole', async () => {
    const s = await hiddenStack({ module: { limits: { hiddenMaxFiles: 3 } } });
    expect(await s.manager.prepareStart()).toMatchObject({ problem: { id: 'worktree.hidden.tooLarge', params: { files: '4', maxFiles: '3', maxSize: '1 GB' } } });
    await writeFile(join(share(s), 'extra.txt'), 'one more\n');
    const refused = await settleError(s.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'm', trailers: [], as: s.principal(s.host.userId) }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'hidden-too-large', text: { id: 'worktree.hidden.tooLarge', params: { files: '5', maxFiles: '3' } } });
    expect(refused?.message).toContain('The largest: ');
    // Nothing was written into the history: no commit, no object.
    expect((await s.gitCode(['--git-dir', hiddenOf(s), 'rev-parse', '--verify', '-q', 'HEAD'])).code).not.toBe(0);
    expect(await s.git(['--git-dir', hiddenOf(s), 'count-objects'])).toMatch(/^0 objects/);
    await dropStack();

    const bytes = await hiddenStack({ module: { limits: { hiddenMaxBytes: 100 } } });
    await writeFile(join(share(bytes), 'data.bin'), Buffer.alloc(200, 1));
    await mkdir(join(share(bytes), 'big'), { recursive: true });
    await writeFile(join(share(bytes), 'big', 'one.bin'), Buffer.alloc(300, 1));
    await writeFile(join(share(bytes), 'big', 'two.bin'), Buffer.alloc(300, 1));
    // Every file is measured (0.6.0's review: measuring stopped at the first file beyond the bound, so the refusal said
    // what was measured up to there, and could leave out the real largest folder): the whole size, the real largest.
    expect(await bytes.manager.prepareStart()).toMatchObject({
      problem: { id: 'worktree.hidden.tooLarge', params: { size: '851 bytes', maxSize: '100 bytes', largest: expect.stringMatching(/^big \(600 bytes\), data\.bin \(200 bytes\)/) } },
    });
    await dropStack();

    // Long paths: the listing is over 4 MiB (the runner's default bound), and every file is recorded.
    const long = await hiddenStack();
    // (each path about 760 characters below the share, within the system's 1024 for the whole path)
    const deep = join(share(long), 'd'.repeat(150), 'e'.repeat(150), 'f'.repeat(150), 'g'.repeat(150));
    await mkdir(deep, { recursive: true });
    const count = 6_000;
    for (let i = 0; i < count; i++) await writeFile(join(deep, `${String(i).padStart(5, '0')}-${'h'.repeat(150)}`), '');
    const checkpoint = await long.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'm', trailers: [], as: long.principal(long.host.userId) });
    expect(checkpoint.history).toBe('smurg');
    expect((await hiddenFiles(long)).length).toBe(count + Object.keys(FILES).length);
  });

  it('tampering refuses every use: config, HEAD, a link, alternates, grafts, shallow, a replace ref', async () => {
    const s = await hiddenStack();
    await s.manager.prepareStart();
    const G = hiddenOf(s);
    const config = await readFile(join(G, 'config'), 'utf8');
    const expectChanged = async (what: string): Promise<void> => {
      expect((await s.manager.mainState()).unavailable, what).toEqual({ id: 'worktree.hidden.changed' });
      expect((await s.manager.prepareStart()).problem, what).toEqual({ id: 'worktree.hidden.changed' });
    };
    await writeFile(join(G, 'config'), `${config}[core]\n\tfsmonitor = /tmp/evil\n`);
    await expectChanged('config');
    await writeFile(join(G, 'config'), config);
    expect((await s.manager.mainState()).unavailable).toBeNull();
    await writeFile(join(G, 'HEAD'), 'ref: refs/heads/other\n');
    await expectChanged('HEAD');
    await writeFile(join(G, 'HEAD'), 'ref: refs/heads/main\n');
    for (const [path, text] of [
      [join('objects', 'info', 'alternates'), '/elsewhere/objects\n'],
      [join('info', 'grafts'), '0000000000000000000000000000000000000000\n'],
      ['shallow', '0000000000000000000000000000000000000000\n'],
      [join('refs', 'replace', '0000000000000000000000000000000000000000'), '1111111111111111111111111111111111111111\n'],
      ['packed-refs', '1111111111111111111111111111111111111111 refs/replace/0000000000000000000000000000000000000000\n'],
    ] as const) {
      await mkdir(join(G, path, '..'), { recursive: true });
      await writeFile(join(G, path), text);
      await expectChanged(path);
      await rm(join(G, path));
    }
    expect((await s.manager.mainState()).unavailable).toBeNull();
    // smurg's history replaced by a link to a copy of itself.
    await rename(G, join(share(s), '.smurg', 'elsewhere'));
    await symlink(join(share(s), '.smurg', 'elsewhere'), G);
    await expectChanged('a link');
  });

  it('a merge whose base moved since its review is refused, in the diff and at the approval', async () => {
    const s = await hiddenStack();
    const checkpoint = await s.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'smurg: spec and plan of checkout', trailers: [], as: s.principal(s.host.userId) });
    // The folder changed since: the worktree's base is a later snapshot.
    await writeFile(join(share(s), 'notes.txt'), 'later\n');
    const worktree = await hostWorktree(s);
    await writeFile(join(worktree.dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const request = await s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId));
    expect((await s.host.conn.request('worktree.merge.diff', { requestId: request.id })).files.map((file) => file.path)).toEqual(['src/app.ts']);
    // Something moves the branch of smurg's history back to the checkpoint (its config and HEAD are as they were).
    await hiddenGit(s, 'update-ref', 'refs/heads/main', checkpoint.commit);
    const changed = { code: 'conflict', reason: 'hidden-repo-changed', text: { id: 'worktree.hidden.changed' } };
    expect(await settleError(s.host.conn.request('worktree.merge.diff', { requestId: request.id }))).toMatchObject(changed);
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: request.id }))).toMatchObject(changed);
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
  });

  it('a stale index.lock is removed; a snapshot killed by its deadline leaves one, and the next Start succeeds', async () => {
    const gitPath = GIT as string;
    const bin = await createTempDir('hidden-slow-git');
    dirs.push(bin);
    const flag = join(bin, 'slow');
    const wrapper = join(bin, 'git');
    // `add` while the flag is there: the lock git would hold, then a sleep the deadline kills (exec: no child is left).
    await writeFile(
      wrapper,
      `#!/bin/sh\nif [ -f '${flag}' ]; then for a in "$@"; do case "$a" in --git-dir=*) dir="\${a#--git-dir=}";; add) touch "$dir/index.lock"; exec sleep 5;; esac; done; fi\nexec '${gitPath}' "$@"\n`,
      { mode: 0o755 },
    );
    const s = await hiddenStack({ module: { gitPath: wrapper, limits: { hiddenSnapshotTimeoutMs: 1_000 } } });
    await s.manager.mainState();
    await writeFile(flag, '');
    const killed = await settleError(s.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'm', trailers: [], as: s.principal(s.host.userId) }));
    expect(killed).toMatchObject({ reason: 'git-timeout' });
    expect(await exists(join(hiddenOf(s), 'index.lock'))).toBe(true);
    await rm(flag);
    const checkpoint = await s.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'm', trailers: [], as: s.principal(s.host.userId) });
    expect(checkpoint).toMatchObject({ created: true, history: 'smurg' });
    expect(await exists(join(hiddenOf(s), 'index.lock'))).toBe(false);
    // Planted by hand: the next command removes it too.
    await writeFile(join(hiddenOf(s), 'index.lock'), '');
    expect((await s.manager.mainState()).busy).toBe(false);
    expect(await s.manager.prepareStart()).toMatchObject({ problem: null });
    expect(await exists(join(hiddenOf(s), 'index.lock'))).toBe(false);
  });

  it('a clone needs the disk space of the folder beyond the host\'s reserve', async () => {
    let free = 10n * 1024n * 1024n * 1024n;
    const s = await hiddenStack({ module: { statfs: async () => ({ bsize: 1n, blocks: 100n * 1024n * 1024n * 1024n, bavail: free }) }, settings: { diskReserveBytes: 1024, diskReservePercent: 0 } });
    expect((await hostWorktree(s)).id).toMatch(/^wt_/);
    free = 1_000n;
    const refused = await settleError(s.manager.acquireForSession({ owner: s.principal(s.host.userId), sessionId: 'ses_full' }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'hidden-no-space', text: { id: 'worktree.hidden.noSpace' } });
    expect(s.manager.list()).toHaveLength(1);
  });

  it('repack after many loose objects keeps the unreachable ones', async () => {
    const s = await hiddenStack();
    await s.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'm', trailers: [], as: s.principal(s.host.userId) });
    const G = hiddenOf(s);
    const home = await createTempDir('hidden-repack-home');
    dirs.push(home);
    // An object nothing refers to (what a clone may still read): repack -A keeps it.
    const orphan = (await run('sh', ['-c', `printf orphan | '${GIT as string}' --git-dir='${G}' hash-object -w --stdin`], { env: isolatedGitEnv(home) })).stdout.trim();
    const git = new GitRunner({ gitPath: GIT as string, home });
    const looseBefore = Number(/count: (\d+)/.exec(await s.git(['--git-dir', G, 'count-objects', '-v']))?.[1]);
    expect(looseBefore).toBeGreaterThan(3);
    expect(await repackWhenLoose({ git, gitDir: G, shareReal: share(s), timeoutMs: 60_000, log: s.t.ctx.log }, 3)).toBe(true);
    const after = await s.git(['--git-dir', G, 'count-objects', '-v']);
    expect(Number(/in-pack: (\d+)/.exec(after)?.[1])).toBeGreaterThan(0);
    expect((await s.gitCode(['--git-dir', G, 'cat-file', '-e', orphan])).code).toBe(0);
    expect(await repackWhenLoose({ git, gitDir: G, shareReal: share(s), timeoutMs: 60_000, log: s.t.ctx.log }, 1_000)).toBe(false);
  });

  it('a nested repository is left out, named, and an item that did not touch it merges', async () => {
    const s = await hiddenStack();
    const nested = join(share(s), 'frontend');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'app.js'), 'console.log(1);\n');
    await s.git(['init', '-q', '-b', 'main'], nested);
    await s.git(['add', '-A'], nested);
    await s.git(['commit', '-q', '-m', 'frontend'], nested);
    expect(await s.manager.prepareStart()).toMatchObject({ nestedRepos: ['frontend'], problem: null });
    const worktree = await hostWorktree(s);
    expect(await exists(join(worktree.dir, 'frontend'))).toBe(false);
    expect((await hiddenGit(s, 'ls-files', '-s')).split('\n').some((line) => line.startsWith('160000'))).toBe(false);
    await writeFile(join(worktree.dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const request = await s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId));
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: request.id })).request.status).toBe('merged');
    expect(await readFile(join(nested, 'app.js'), 'utf8')).toBe('console.log(1);\n');
    expect((await s.git(['log', '--format=%s'], nested)).trim()).toBe('frontend');
  });

  it('after a restart a checkout\'s commit still leaves out a nested repository; a recorded file of a folder that became a repository leaves the history with it', async () => {
    const s = await hiddenStack();
    const nested = join(share(s), 'frontend');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'app.js'), 'console.log(1);\n');
    await s.git(['init', '-q', '-b', 'main'], nested);
    await s.git(['add', '-A'], nested);
    await s.git(['commit', '-q', '-m', 'frontend'], nested);
    // A folder the history records as ordinary files, until it becomes a repository of its own.
    await mkdir(join(share(s), 'vendor'), { recursive: true });
    await writeFile(join(share(s), 'vendor', 'lib.js'), 'lib\n');
    const worktree = await hostWorktree(s);
    expect(await hiddenFiles(s)).toContain('vendor/lib.js');
    await s.git(['init', '-q', '-b', 'main'], join(share(s), 'vendor'));
    // smurg stops and starts again: what the last listing found is forgotten (0.6.0's review: the clone's exclude then
    // lost `/frontend/`, the item's write into it reached the diff, and the merge wrote it into the user's repository).
    await s.t.daemon.stop();
    const daemon = await restartDaemonWith(s.t);
    try {
      const manager = daemon.ctx.services.worktrees as WorktreeManagerImpl;
      const host = daemon.ctx.members.principalOf(daemon.ctx.members.hostUserId());
      if (host === null) throw new Error('host');
      await mkdir(join(worktree.dir, 'frontend'), { recursive: true });
      await writeFile(join(worktree.dir, 'frontend', 'new.js'), 'by the item\n');
      await writeFile(join(worktree.dir, 'src', 'app.ts'), 'export const answer = 43;\n');
      const request = await manager.requestMerge({ worktreeId: worktree.id }, host);
      expect(await readFile(join(worktree.dir, '.git', 'info', 'exclude'), 'utf8')).toContain('/frontend/');
      expect((await manager.diff({ requestId: request.id }, host)).files.map((file) => file.path)).toEqual(['src/app.ts']);
      expect((await manager.approve({ requestId: request.id }, host)).status).toBe('merged');
      expect(await exists(join(nested, 'new.js'))).toBe(false);
      expect((await s.git(['status', '--porcelain'], nested)).trim()).toBe('');
      // The snapshot before that merge found vendor/ a repository: it is named, and its file left the history.
      expect(await manager.prepareStart()).toMatchObject({ nestedRepos: ['frontend', 'vendor'] });
      expect(await hiddenFiles(s)).not.toContain('vendor/lib.js');
      expect(await hiddenFiles(s)).not.toContain('frontend/new.js');
    } finally {
      await daemon.stop();
    }
  });

  it('a merge smurg made but did not get to record (it stopped right after git merge) is recorded merged at the next approval, not refused as a changed history', async () => {
    const s = await hiddenStack();
    const worktree = await hostWorktree(s);
    await writeFile(join(worktree.dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const request = await s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId));
    expect((await s.host.conn.request('worktree.merge.diff', { requestId: request.id })).files.map((file) => file.path)).toEqual(['src/app.ts']);
    // What the approval's `git merge` leaves when smurg stops before it records the request (0.6.0's review: both the
    // diff and the approval then said the history was changed by something else, and the request stayed open).
    await hiddenGit(s, 'merge', '--quiet', '--no-ff', '--no-edit', '-m', 'Merge (smurg stopped here)', request.commit);
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    expect((await s.host.conn.request('worktree.merge.diff', { requestId: request.id })).files).toEqual([]);
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: request.id })).request.status).toBe('merged');
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    // A history moved elsewhere is still refused (the case above is only a commit that is in it already).
    const second = await hostWorktree(s, 'ses_second');
    await writeFile(join(second.dir, 'README.md'), '# demo, by the item\n');
    const other = await s.manager.requestMerge({ worktreeId: second.id }, s.principal(s.host.userId));
    await hiddenGit(s, 'update-ref', 'refs/heads/main', `${request.commit}^`);
    expect(await settleError(s.host.conn.request('worktree.merge.approve', { requestId: other.id }))).toMatchObject({ reason: 'hidden-repo-changed' });
  });

  it('a .gitignore of the folder that un-ignores host-private names lets none of them into the history or a checkout', async () => {
    const s = await hiddenStack({
      files: { ...FILES, '.gitignore': '.*\n!.gitignore\n!.envrc\n!CLAUDE.local.md\n', '.envrc': 'export DEPLOY_TOKEN=host-secret\n', 'CLAUDE.local.md': 'host memory\n' },
    });
    const worktree = await hostWorktree(s);
    // (0.6.0's review: the negations take precedence over the exclude file, and `git add -A` took them again)
    const files = await hiddenFiles(s);
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('.envrc');
    expect(files).not.toContain('CLAUDE.local.md');
    expect(await exists(join(worktree.dir, '.envrc'))).toBe(false);
    expect(await exists(join(worktree.dir, 'CLAUDE.local.md'))).toBe(false);
    // The host's own files stay where they are.
    expect(await readFile(join(share(s), '.envrc'), 'utf8')).toBe('export DEPLOY_TOKEN=host-secret\n');
  });

  it('a host-private file under a spelling no glob catches is left out by name', async () => {
    const s = await hiddenStack();
    // HFS+ ignorable (a zero-width non-joiner): PathGuard folds it onto `.git`; git sees another name.
    const odd = '.g‌it';
    await mkdir(join(share(s), odd), { recursive: true });
    await writeFile(join(share(s), odd, 'config'), 'url = https://token@example.invalid\n');
    await writeFile(join(share(s), 'deploy.envrc'), 'not private\n');
    await s.manager.commitMainPaths({ paths: ['specs/checkout/SPEC.md'], message: 'm', trailers: [], as: s.principal(s.host.userId) });
    const files = await hiddenFiles(s);
    expect(files.some((path) => path.includes('config') && path.startsWith('.g'))).toBe(false);
    expect(files).toContain('deploy.envrc');
  });

  it('records of smurg\'s history keep merging after .git appears; new work uses .git and needs its commit', async () => {
    const s = await hiddenStack();
    const worktree = await hostWorktree(s);
    await writeFile(join(worktree.dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const request = await s.manager.requestMerge({ worktreeId: worktree.id }, s.principal(s.host.userId));
    // The host runs `git init` while sharing.
    await s.git(['init', '-q', '-b', 'main']);
    await s.manager.refreshGitState();
    expect(s.manager.workState()).toEqual({ history: 'folder' });
    expect((await s.manager.mainState()).unavailable).toEqual({ id: 'worktree.unavailable.noCommit' });
    expect(await settleError(s.manager.acquireForSession({ owner: s.principal(s.host.userId), sessionId: 'ses_new' }))).toMatchObject({ reason: 'no-commits' });
    // The request made from smurg's history is merged there, into the folder.
    expect((await s.host.conn.request('worktree.merge.approve', { requestId: request.id })).request.status).toBe('merged');
    expect(await readFile(join(share(s), 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    // A first commit of the user's: new work uses it.
    await s.git(['add', '-A']);
    await s.git(['commit', '-q', '-m', 'first']);
    const fresh = await s.manager.acquireForSession({ owner: s.principal(s.host.userId), sessionId: 'ses_new2' });
    expect((await docOf(s)).worktrees.find((record) => record.id === fresh.worktree.id)?.repo).toBeUndefined();
    // smurg's history stays on disk (smurg never deletes it).
    expect(await exists(hiddenOf(s))).toBe(true);
  });

  it('a cloud-synced folder is named in the Start dialog\'s facts', async () => {
    const home = await createTempDir('hidden-cloud-home');
    dirs.push(home);
    const root = join(home, 'Library', 'CloudStorage', 'Drive-ian', 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), '# synced\n');
    const t: TestDaemon = await createTestDaemon({ root, modules: [createWorktreeModule()], sessions: { hostHome: home } });
    try {
      const manager = t.ctx.services.worktrees as WorktreeManagerImpl;
      await manager.mainState();
      expect(await manager.prepareStart()).toMatchObject({ cloudSynced: true, problem: null });
    } finally {
      await t.cleanup();
    }
  });
});
