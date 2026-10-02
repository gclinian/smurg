// A worktree's content is guest-controlled, and the daemon that runs git on it is NOT sandboxed. A malicious
// worktree (git hooks, a .gitattributes filter, repository config, a symlink named like a tracked file, a swapped
// .git) cannot make the daemon run code or write outside the share. Every "attack" has a positive control that shows
// the same setup DOES run code when git is used naively, so no check here passes vacuously.
import { chmod, link, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathDeniedError } from '../../src/core/errors.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';
import { settleError, startWorktreeStack, type WorktreeStack } from './support.ts';

let stack: WorktreeStack | null = null;
let outside = '';

beforeEach(async () => {
  outside = await createTempDir('outside');
}, 60_000);

afterEach(async () => {
  await stack?.cleanup();
  stack = null;
  await removeTempDir(outside);
}, 60_000);

const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge', 'post-checkout', 'post-rewrite', 'reference-transaction', 'pre-auto-gc'];

/** Every hook writes `<outside>/hook-<name>` when it runs. */
async function plantHooks(gitDir: string): Promise<void> {
  const hooks = join(gitDir, 'hooks');
  await mkdir(hooks, { recursive: true });
  for (const name of HOOKS) {
    const script = join(hooks, name);
    await writeFile(script, `#!/bin/sh\ntouch '${outside}/hook-${name}'\nexit 0\n`);
    await chmod(script, 0o755);
  }
}

async function markers(): Promise<string[]> {
  return (await readdir(outside)).sort();
}

async function clearMarkers(): Promise<void> {
  for (const name of await markers()) await rm(join(outside, name), { force: true });
}

async function amyWorktree(s: WorktreeStack) {
  const amy = await s.connect('dev:amy', 'agent');
  const handle = await s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_evil' });
  return { amy, worktreeId: handle.worktree.id, dir: s.worktreeDir(handle.worktree.id) };
}

describe('a malicious worktree cannot make the daemon run code or write outside', { timeout: 60_000 }, () => {
  it('git hooks in the worktree and in the main repository never run for daemon git commands', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await plantHooks(join(dir, '.git'));
    await plantHooks(join(s.t.root, '.git'));
    // Control: plain git in the worktree does run them.
    await s.git(['commit', '--allow-empty', '-q', '-m', 'control'], dir);
    expect(await markers()).toEqual(expect.arrayContaining(['hook-pre-commit', 'hook-commit-msg', 'hook-post-commit']));
    await clearMarkers();

    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId, message: 'with hooks around' });
    await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'src', 'app.ts'), 'utf8')).toBe('export const answer = 43;\n');
    // commit, fetch (reference-transaction), merge-tree, merge (pre-merge-commit, post-merge), update-ref: no hook ran.
    expect(await markers()).toEqual([]);
  });

  it('repository config planted in the worktree (fsmonitor, a filter driver) is refused before any git command runs', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    const monitor = join(outside, 'fsmonitor.sh');
    await writeFile(monitor, `#!/bin/sh\ntouch '${outside}/ran-fsmonitor'\nexit 1\n`);
    await chmod(monitor, 0o755);
    const configPath = join(dir, '.git', 'config');
    const original = await readFile(configPath, 'utf8');
    await writeFile(configPath, `${original}[core]\n\tfsmonitor = ${monitor}\n[filter "evil"]\n\tclean = "sh -c 'touch ${outside}/ran-filter; cat'"\n`);
    await writeFile(join(dir, '.gitattributes'), '* filter=evil\n');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    // Control: plain git in that worktree runs both.
    await s.git(['add', '-A'], dir);
    await s.git(['reset', '-q'], dir);
    expect(await markers()).toEqual(expect.arrayContaining(['ran-filter', 'ran-fsmonitor']));
    await clearMarkers();

    const refused = await settleError(amy.conn.request('worktree.merge.request', { worktreeId }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'worktree-tampered' });
    expect(refused?.detail?.['problem']).toBe('config-changed');
    expect((await markers()).filter((name) => name.startsWith('ran-'))).toEqual([]);
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    // Resuming it in a new session is refused too.
    await s.manager.releaseFromSession(worktreeId, 'ses_evil', { keep: true });
    expect(await settleError(s.manager.acquireForSession({ owner: s.principal('dev:amy'), sessionId: 'ses_next', worktreeId }))).toMatchObject({ code: 'conflict', reason: 'worktree-tampered' });
  });

  it('a .gitattributes filter in the merged content never runs a driver of the host\'s config during review or merge', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    // The HOST's repository defines drivers (like git-lfs does); the guest's content selects them.
    for (const [key, value] of [
      ['filter.evil.clean', `sh -c 'touch ${outside}/ran-clean; cat'`],
      ['filter.evil.smudge', `sh -c 'touch ${outside}/ran-smudge; cat'`],
      ['diff.evil.textconv', `sh -c 'touch ${outside}/ran-textconv; cat "$1"' -`],
      ['merge.evil.driver', `sh -c 'touch ${outside}/ran-merge-driver; exit 1'`],
    ] as const) {
      await s.git(['config', key, value]);
    }
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, '.gitattributes'), '* filter=evil diff=evil merge=evil\n');
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await writeFile(join(dir, 'data.txt'), 'payload\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    const review = await s.host.conn.request('worktree.merge.diff', { requestId: request.id });
    expect(review.files.map((file) => file.path).sort()).toEqual(['.gitattributes', 'data.txt', 'src/app.ts']);
    await s.host.conn.request('worktree.merge.fileDiff', { requestId: request.id, path: 'src/app.ts' });
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
    expect(await readFile(join(s.t.root, 'data.txt'), 'utf8')).toBe('payload\n');
    expect(await markers()).toEqual([]);
    // Control: the same checkout with plain git runs the host's smudge filter.
    await rm(join(s.t.root, 'data.txt'));
    await s.git(['checkout', '--', 'data.txt']);
    expect(await markers()).toContain('ran-smudge');
  });

  it('a symlink named like a tracked file: git records the link (never its target\'s content) and a guest cannot merge it', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const secret = join(outside, 'id_rsa');
    await writeFile(secret, 'SECRET-KEY-MATERIAL\n');
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await rm(join(dir, 'src', 'app.ts'));
    await symlink(secret, join(dir, 'src', 'app.ts'));
    const refused = await settleError(amy.conn.request('worktree.merge.request', { worktreeId }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'unsafe-symlink' });
    expect(refused?.detail?.['paths']).toEqual(['src/app.ts']);
    // The daemon committed the link as a link: the object holds the path, not the secret.
    const blob = await s.git(['cat-file', '-p', 'HEAD:src/app.ts'], dir);
    expect(blob).toBe(secret);
    expect(await s.git(['log', '-p', '--all'], dir)).not.toContain('SECRET-KEY-MATERIAL');
    expect(await readFile(secret, 'utf8')).toBe('SECRET-KEY-MATERIAL\n');
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    // Relative escapes too.
    await rm(join(dir, 'src', 'app.ts'));
    await symlink('../../../../../../etc/hosts', join(dir, 'src', 'app.ts'));
    expect(await settleError(amy.conn.request('worktree.merge.request', { worktreeId }))).toMatchObject({ code: 'conflict', reason: 'unsafe-symlink' });
    // A link that stays inside the project is fine.
    await rm(join(dir, 'src', 'app.ts'));
    await symlink('../README.md', join(dir, 'src', 'app.ts'));
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    expect(request.status).toBe('pending');
  });

  it('a chain of in-repo links whose target climbs through another link is refused (it would resolve outside the share)', async () => {
    await writeFile(join(outside, 'marker.txt'), 'HOST-FILE-OUTSIDE-SHARE\n');
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    const share = await realpath(s.t.root);
    const rel = relative(dirname(share), await realpath(outside));
    const depth = rel.split('/').filter((segment) => segment === '..').length + 2;
    const linkDir = Array.from({ length: depth }, (_, i) => `d${i}`).join('/');
    await mkdir(join(dir, linkDir), { recursive: true });
    await symlink(Array.from({ length: depth }, () => '..').join('/'), join(dir, linkDir, 'b')); // the share root
    await symlink(`b/../${rel}`, join(dir, linkDir, 'a')); // through b, then above the root
    const refused = await settleError(amy.conn.request('worktree.merge.request', { worktreeId, message: 'add links' }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'unsafe-symlink' });
    expect(refused?.detail?.['paths']).toEqual([`${linkDir}/a`]);
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    await expect(lstat(join(share, linkDir))).rejects.toThrow();
  });

  it('a host file hard-linked into the worktree: the request is refused and its bytes never reach an object the guest can read', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const secret = join(outside, 'id_ed25519');
    await writeFile(secret, 'HOST-PRIVATE-KEY-MATERIAL\n');
    const { amy, worktreeId, dir } = await amyWorktree(s);
    const head = (await s.git(['rev-parse', 'HEAD'], dir)).trim();
    // The daemon's git is not sandboxed: a naive `git add` would read the host's file through this second name.
    await link(secret, join(dir, 'notes.txt'));
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const refused = await settleError(amy.conn.request('worktree.merge.request', { worktreeId }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'hard-link' });
    // Nothing was published: the branch did not move, no object anywhere the clone can read holds the bytes, and the
    // private staging store is gone.
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe(head);
    const everything = async (): Promise<string> => (await s.gitCode(['cat-file', '--batch-all-objects', '--batch'], dir)).stdout;
    expect(await everything()).not.toContain('HOST-PRIVATE-KEY-MATERIAL');
    expect(await readdir(join(s.t.ctx.state.dir, 'git-staging'))).toEqual([]);
    expect((await s.git(['for-each-ref', 'refs/smurg/'])).trim()).toBe('');
    // Control: the same tree with a naive `git add` does put the host's bytes into a guest-readable object.
    await s.git(['add', '-A'], dir);
    expect(await everything()).toContain('HOST-PRIVATE-KEY-MATERIAL');
  });

  it('a nested git repository in a guest worktree is refused (never committed as a submodule)', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await mkdir(join(dir, 'vendor', 'lib'), { recursive: true });
    await s.git(['init', '-q', '-b', 'main'], join(dir, 'vendor', 'lib'));
    await writeFile(join(dir, 'vendor', 'lib', 'x.txt'), 'x\n');
    await s.git(['add', '-A'], join(dir, 'vendor', 'lib'));
    await s.git(['commit', '-q', '-m', 'nested'], join(dir, 'vendor', 'lib'));
    const head = (await s.git(['rev-parse', 'HEAD'], dir)).trim();
    expect(await settleError(amy.conn.request('worktree.merge.request', { worktreeId }))).toMatchObject({ code: 'conflict', reason: 'nested-repository' });
    expect((await s.git(['rev-parse', 'HEAD'], dir)).trim()).toBe(head);
  });

  it('merging a symlinked directory named like a tracked one (the host\'s own worktree) never writes through it', async () => {
    stack = await startWorktreeStack({ files: { 'README.md': '# demo\n', 'src/app.ts': 'export const answer = 42;\n', 'lib/util.ts': 'export {};\n' } });
    const s = stack;
    const target = join(outside, 'elsewhere');
    await mkdir(target);
    const handle = await s.manager.acquireForSession({ owner: s.principal('dev:host'), sessionId: 'ses_host' });
    const dir = s.worktreeDir(handle.worktree.id);
    await rm(join(dir, 'lib'), { recursive: true });
    await symlink(target, join(dir, 'lib'));
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    // The host's own requests may carry symlinks (policy), so this reaches the merge.
    const { request } = await s.host.conn.request('worktree.merge.request', { worktreeId: handle.worktree.id });
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
    expect((await lstat(join(s.t.root, 'lib'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(s.t.root, 'lib'))).toBe(target);
    expect(await readdir(target)).toEqual([]);
    // Nobody reaches outside through it: PathGuard refuses the link for every member, the host included.
    const denied = await s.t.ctx.paths.resolve({ root: { kind: 'main' }, path: 'lib/util.ts' }, { principal: s.principal('dev:host') }).catch((err: unknown) => err);
    expect(denied).toBeInstanceOf(PathDeniedError);
    expect((denied as PathDeniedError).reason).toBe('outside-root');
  });

  it('an untracked symlink in the main workspace is never written through by a merge', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const target = join(outside, 'landing');
    await mkdir(target);
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await mkdir(join(dir, 'vendor'));
    await writeFile(join(dir, 'vendor', 'lib.js'), 'module.exports = 1;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    // Someone with host access to the main folder puts a link where the merge would create a directory.
    await symlink(target, join(s.t.root, 'vendor'));
    const result = await s.host.conn.request('worktree.merge.approve', { requestId: request.id }).then(
      (ok) => ok.request.status,
      (err: { code?: string }) => err.code,
    );
    expect(['conflict']).toContain(result);
    expect(await readdir(target)).toEqual([]);
    expect(await lstat(join(s.t.root, '.git', 'MERGE_HEAD')).catch(() => null)).toBeNull();
  });

  it('a worktree whose .git was swapped for the main repository (or redirected) is refused: nothing is committed to main', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    const mainHead = (await s.git(['rev-parse', 'HEAD'])).trim();
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    await rm(join(dir, '.git'), { recursive: true });
    await symlink(join(s.t.root, '.git'), join(dir, '.git'));
    expect(await settleError(amy.conn.request('worktree.merge.request', { worktreeId }))).toMatchObject({ code: 'conflict', reason: 'worktree-tampered' });
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(mainHead);
    expect((await s.git(['status', '--porcelain'])).trim()).toBe('');
    // Deleting .git would make a naive `git -C <worktree>` find the MAIN repository: refused as well.
    await rm(join(dir, '.git'));
    expect(await settleError(amy.conn.request('worktree.merge.request', { worktreeId }))).toMatchObject({ code: 'conflict', reason: 'worktree-tampered' });
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(mainHead);
  });

  it('a nested repository in the main workspace (its own core.fsmonitor) is never entered by the daemon\'s git', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const sub = join(s.t.root, 'sub');
    await mkdir(sub);
    await s.git(['init', '-q', '-b', 'main'], sub);
    await writeFile(join(sub, 's.txt'), 's\n');
    await s.git(['add', '-A'], sub);
    await s.git(['commit', '-q', '-m', 'nested'], sub);
    await s.git(['add', 'sub']); // a gitlink, like a checked-out submodule
    await s.git(['commit', '-q', '-m', 'add nested repository']);
    const monitor = join(outside, 'fsmonitor.sh');
    await writeFile(monitor, `#!/bin/sh\ntouch '${outside}/ran-nested-fsmonitor'\nexit 1\n`);
    await chmod(monitor, 0o755);
    await s.git(['config', 'core.fsmonitor', monitor], sub);
    await writeFile(join(sub, 's.txt'), 's (dirty)\n');
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 43;\n');
    const { request } = await amy.conn.request('worktree.merge.request', { worktreeId });
    const { request: merged } = await s.host.conn.request('worktree.merge.approve', { requestId: request.id });
    expect(merged.status).toBe('merged');
    expect((await markers()).filter((name) => name.startsWith('ran-'))).toEqual([]);
    // Control: a plain `git status` in the main workspace does run it.
    await s.git(['status', '--porcelain', '--ignore-submodules=none']);
    expect(await markers()).toContain('ran-nested-fsmonitor');
  });

  it('a redirecting commondir file in the worktree\'s git dir is refused', async () => {
    stack = await startWorktreeStack();
    const s = stack;
    const { amy, worktreeId, dir } = await amyWorktree(s);
    await writeFile(join(dir, '.git', 'commondir'), `${join(s.t.root, '.git')}\n`);
    const refused = await settleError(amy.conn.request('worktree.merge.request', { worktreeId }));
    expect(refused).toMatchObject({ code: 'conflict', reason: 'worktree-tampered' });
    expect(refused?.detail?.['problem']).toBe('unexpected-commondir');
  });
});
