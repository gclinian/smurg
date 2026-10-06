// What the worktree module does with named files of the MAIN workspace (ARCHITECTURE §5.10; DESIGN §4.5, §4.7): the
// checkpoint commit of a Start (exactly the two files, as the member who pressed Start), the blob ids at HEAD the
// scheduler pins, the diff behind "Show the changes", and the facts the Start dialog's blockers come from.
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { MASKED } from '@smurg/protocol';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { createTempDir, isolatedGitEnv, removeTempDir } from '../../src/testing/index.ts';
import { settleError, startWorktreeStack, type WorktreeStack } from './support.ts';

const execFileAsync = promisify(execFile);

let stack: WorktreeStack | null = null;

afterEach(async () => {
  await stack?.cleanup();
  stack = null;
}, 60_000);

const SPEC = 'specs/checkout/SPEC.md';
const PLAN = 'specs/checkout/PLAN.md';
const BASE = { 'README.md': '# demo\n', 'src/app.ts': 'export const answer = 42;\n' };

async function withTopicFiles(s: WorktreeStack, spec = '# Checkout\n\nOne page.\n', plan = '# Plan\n\n1. Cart API\n'): Promise<void> {
  await mkdir(join(s.t.root, 'specs', 'checkout'), { recursive: true });
  await writeFile(join(s.t.root, SPEC), spec);
  await writeFile(join(s.t.root, PLAN), plan);
}

describe('commitMainPaths: the checkpoint commit of a Start', { timeout: 60_000 }, () => {
  it('commits exactly the named files, as the member, with the trailers as one block; nothing else in the folder or the index goes along', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    await s.connect('dev:mei', 'agent');
    await withTopicFiles(s);
    // What else lies around: an upload in the topic's folder, a planted CLAUDE.md, a file the host staged, an edit.
    await writeFile(join(s.t.root, 'specs', 'checkout', 'mockup.png'), 'not a png\n');
    await writeFile(join(s.t.root, 'specs', 'checkout', 'CLAUDE.md'), 'planted\n');
    await writeFile(join(s.t.root, 'staged.txt'), 'the host is in the middle of something\n');
    await s.git(['add', 'staged.txt']);
    await writeFile(join(s.t.root, 'src', 'app.ts'), 'export const answer = 43;\n');
    const before = (await s.git(['rev-parse', 'HEAD'])).trim();
    expect(await s.manager.headBlobs([SPEC, PLAN])).toEqual({ [SPEC]: null, [PLAN]: null });

    const result = await s.manager.commitMainPaths({
      paths: [SPEC, PLAN],
      message: 'smurg: spec and plan of checkout',
      trailers: ['Edited-by: Amy', 'Edited-by: Ian'],
      as: s.principal('dev:mei'),
    });
    expect(result.created).toBe(true);
    expect(result.branch).toBe((await s.git(['symbolic-ref', '--short', 'HEAD'])).trim());
    expect(result.commit).toBe((await s.git(['rev-parse', 'HEAD'])).trim());
    expect((await s.git(['rev-parse', 'HEAD^'])).trim()).toBe(before);
    // Exactly the two files.
    expect((await s.git(['show', '--format=', '--name-only', 'HEAD'])).trim().split('\n').sort()).toEqual([PLAN, SPEC]);
    expect((await s.git(['log', '-1', '--format=%an|%ae|%cn|%s'])).trim()).toBe('mei|dev-mei@users.smurg.invalid|mei|smurg: spec and plan of checkout');
    expect((await s.git(['log', '-1', '--format=%(trailers:only,unfold)'])).trim().split('\n')).toEqual(['Edited-by: Amy', 'Edited-by: Ian']);
    // The blobs are what HEAD holds now: the pin.
    expect(result.blobs).toEqual({ [SPEC]: (await s.git(['rev-parse', `HEAD:${SPEC}`])).trim(), [PLAN]: (await s.git(['rev-parse', `HEAD:${PLAN}`])).trim() });
    expect(await s.manager.headBlobs([SPEC, PLAN, 'specs/checkout/missing.md'])).toEqual({ ...result.blobs, 'specs/checkout/missing.md': null });
    // Everything else is as the host left it: still staged, still modified, still untracked.
    expect((await s.git(['status', '--porcelain=v1', '--untracked-files=all'])).split('\n').filter(Boolean).sort()).toEqual([' M src/app.ts', '?? specs/checkout/CLAUDE.md', '?? specs/checkout/mockup.png', 'A  staged.txt'].sort());

    // Nothing to commit is fine: the same commit, the same blobs.
    const again = await s.manager.commitMainPaths({ paths: [SPEC, PLAN], message: 'smurg: spec and plan of checkout', trailers: [], as: s.principal('dev:mei') });
    expect(again).toEqual({ ...result, created: false });
    // One file changed: one file in the commit, no trailer block when there is none.
    await writeFile(join(s.t.root, PLAN), '# Plan\n\n1. Cart API\n2. Payment form\n');
    const next = await s.manager.commitMainPaths({ paths: [SPEC, PLAN], message: 'smurg: spec and plan of checkout', trailers: [], as: s.principal(s.host.userId) });
    expect(next.created).toBe(true);
    expect((await s.git(['show', '--format=', '--name-only', 'HEAD'])).trim()).toBe(PLAN);
    expect((await s.git(['log', '-1', '--format=%an|%B'])).trim()).toBe('Host|smurg: spec and plan of checkout');
    expect(next.blobs[SPEC]).toBe(result.blobs[SPEC]);
    expect(next.blobs[PLAN]).not.toBe(result.blobs[PLAN]);
  });

  it('is refused while git is in the middle of something in the main workspace, and when git ignores a file', async () => {
    stack = await startWorktreeStack({ files: { ...BASE, '.gitignore': 'specs/checkout/PLAN.md\n' } });
    const s = stack;
    await s.connect('dev:mei', 'agent');
    await withTopicFiles(s);
    const head = (await s.git(['rev-parse', 'HEAD'])).trim();
    const input = { paths: [SPEC, PLAN], message: 'smurg: spec and plan of checkout', trailers: [], as: s.principal('dev:mei') };

    const ignored = await settleError(s.manager.commitMainPaths(input));
    expect(ignored).toMatchObject({ code: 'conflict', reason: 'git-ignored', text: { id: 'plan.start.commit.ignored', params: { path: PLAN } }, detail: { path: PLAN } });
    await rm(join(s.t.root, '.gitignore'));
    await s.git(['commit', '-q', '-am', 'no ignore file']);
    const base = (await s.git(['rev-parse', 'HEAD'])).trim();
    expect(base).not.toBe(head);

    await writeFile(join(s.t.root, '.git', 'MERGE_HEAD'), `${head}\n`);
    expect(await s.manager.mainState()).toMatchObject({ busy: true });
    expect(await settleError(s.manager.commitMainPaths(input))).toMatchObject({ code: 'conflict', reason: 'git-busy', text: { id: 'plan.start.commit.busy' } });
    await rm(join(s.t.root, '.git', 'MERGE_HEAD'));
    expect(await s.manager.mainState()).toMatchObject({ busy: false });
    // Neither refusal committed or staged anything.
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(base);
    expect((await s.git(['diff', '--cached', '--name-only'])).trim()).toBe('');
    expect((await s.manager.commitMainPaths(input)).created).toBe(true);
  });

  it('runs no hook of the host\'s repository, names the step when git fails, and takes only a member\'s identity', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    await withTopicFiles(s);
    const marker = join(s.t.root, 'hook-ran');
    await mkdir(join(s.t.root, '.git', 'hooks'), { recursive: true });
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg']) {
      await writeFile(join(s.t.root, '.git', 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      await chmod(join(s.t.root, '.git', 'hooks', hook), 0o755);
    }
    const input = { paths: [SPEC, PLAN], message: 'smurg: spec and plan of checkout', trailers: ['Edited-by: Amy'], as: s.principal(s.host.userId) };
    expect((await s.manager.commitMainPaths(input)).created).toBe(true);
    expect(await lstat(marker).catch(() => null)).toBeNull();

    // A path that is neither there nor tracked is left out: it has no blob (as `headBlobs` says null for it).
    const first = (await s.git(['rev-parse', 'HEAD'])).trim();
    const partial = await s.manager.commitMainPaths({ ...input, paths: [SPEC, 'specs/checkout/NOPE.md'] });
    expect(partial).toMatchObject({ created: false, commit: first });
    expect(Object.keys(partial.blobs)).toEqual([SPEC]);
    expect(await s.manager.commitMainPaths({ ...input, paths: ['specs/checkout/NOPE.md'] })).toMatchObject({ created: false, commit: first, blobs: {} });
    // A file that was removed is committed as removed.
    await rm(join(s.t.root, PLAN));
    const removed = await s.manager.commitMainPaths(input);
    expect(removed.created).toBe(true);
    expect(Object.keys(removed.blobs)).toEqual([SPEC]);
    expect((await s.git(['show', '--format=', '--name-status', 'HEAD'])).trim()).toBe(`D\t${PLAN}`);
    expect(await s.manager.headBlobs([SPEC, PLAN])).toEqual({ [SPEC]: removed.blobs[SPEC], [PLAN]: null });
    // When git itself fails, the Start dialog's own sentence names the step (here: a folder git cannot write its index in).
    await chmod(join(s.t.root, '.git'), 0o500);
    await writeFile(join(s.t.root, SPEC), '# Checkout\n\nChanged.\n');
    try {
      const failed = await settleError(s.manager.commitMainPaths({ ...input, paths: [SPEC] }));
      expect(failed).toMatchObject({ code: 'conflict', reason: 'git-failed', text: { id: 'plan.start.commit.failed', params: { step: 'stage' } }, detail: { step: 'stage' } });
    } finally {
      await chmod(join(s.t.root, '.git'), 0o700);
    }
    // Paths that are not the daemon's to commit, or no paths, are a caller's mistake.
    for (const paths of [[], ['.git/config'], ['../outside.md'], ['.claude/settings.json'], ['.smurg/x']]) {
      expect(await settleError(s.manager.commitMainPaths({ ...input, paths }))).toMatchObject({ code: 'bad_request', reason: 'bad-paths' });
    }
    // The daemon itself is nobody's identity in the host's history.
    expect(await settleError(s.manager.commitMainPaths({ ...input, as: SYSTEM_PRINCIPAL }))).toMatchObject({ code: 'forbidden', reason: 'not-a-member' });
  });

  it('a file that is a link (or lies behind one) is no checkpoint: refused before git is asked, and what it points to is never read', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    await withTopicFiles(s);
    const head = (await s.git(['rev-parse', 'HEAD'])).trim();
    const secret = join(s.t.root, '..', 'host-secret.txt');
    await writeFile(secret, 'TOP SECRET\n');
    await rm(join(s.t.root, PLAN));
    await symlink(secret, join(s.t.root, PLAN));
    const input = { paths: [SPEC, PLAN], message: 'm', trailers: [], as: s.principal(s.host.userId) };
    expect(await settleError(s.manager.commitMainPaths(input))).toMatchObject({ code: 'conflict', reason: 'git-failed', text: { id: 'plan.start.commit.failed', params: { step: 'stage' } } });
    // The topic's folder itself swapped for a link.
    await rm(join(s.t.root, 'specs', 'checkout'), { recursive: true });
    await mkdir(join(s.t.root, '..', 'elsewhere'), { recursive: true });
    await writeFile(join(s.t.root, '..', 'elsewhere', 'SPEC.md'), 'TOP SECRET\n');
    await writeFile(join(s.t.root, '..', 'elsewhere', 'PLAN.md'), 'TOP SECRET\n');
    await symlink(join(s.t.root, '..', 'elsewhere'), join(s.t.root, 'specs', 'checkout'));
    expect(await settleError(s.manager.commitMainPaths(input))).toMatchObject({ code: 'conflict', reason: 'git-failed' });
    // Nothing was committed or staged, and no object of the repository holds the secret.
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await s.git(['diff', '--cached', '--name-only'])).trim()).toBe('');
    const objects = await s.git(['cat-file', '--batch-all-objects', '--batch-check']);
    for (const line of objects.split('\n').filter((entry) => entry.includes(' blob '))) {
      expect(await s.git(['cat-file', 'blob', line.split(' ')[0] as string])).not.toContain('TOP SECRET');
    }
    await rm(secret);
    await rm(join(s.t.root, '..', 'elsewhere'), { recursive: true });
  });
});

describe('headBlobs and mainState', { timeout: 60_000 }, () => {
  it('a folder that is no git repository: nothing is at HEAD, nothing can start, and the facts say why', async () => {
    stack = await startWorktreeStack({ git: false, files: { ...BASE, [SPEC]: '# Checkout\n' } });
    const s = stack;
    expect(await s.manager.mainState()).toEqual({ isRepo: false, hasCommit: false, gitOk: true, branch: null, busy: false, free: 64 });
    expect(await s.manager.headBlobs([SPEC, PLAN])).toEqual({ [SPEC]: null, [PLAN]: null });
    expect(await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 1024 })).toEqual([]);
    expect(await settleError(s.manager.commitMainPaths({ paths: [SPEC], message: 'm', trailers: [], as: s.principal(s.host.userId) }))).toMatchObject({ code: 'conflict', reason: 'not-a-git-repo' });
    expect(s.manager.unmerged('tp_checkout')).toEqual([]);
  });

  it('a repository without a commit yet: no HEAD to pin, and the checkpoint does not make the first commit', async () => {
    const root = await createTempDir('empty-repo');
    try {
      await mkdir(join(root, 'specs', 'checkout'), { recursive: true });
      await writeFile(join(root, SPEC), '# Checkout\n');
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: isolatedGitEnv(join(root, '.home')) });
      stack = await startWorktreeStack({ root });
      const s = stack;
      expect(await s.manager.mainState()).toMatchObject({ isRepo: true, hasCommit: false, gitOk: true, branch: 'main', busy: false });
      expect(await s.manager.headBlobs([SPEC])).toEqual({ [SPEC]: null });
      expect(await settleError(s.manager.commitMainPaths({ paths: [SPEC], message: 'm', trailers: [], as: s.principal(s.host.userId) }))).toMatchObject({ code: 'conflict', reason: 'no-commits' });
      // Against HEAD there is nothing: the file as it is now is all of the change.
      const diffs = await s.manager.diffMainPaths({ paths: [SPEC], against: 'head', maxBytes: 4096 });
      expect(diffs.map((entry) => entry.path)).toEqual([SPEC]);
      expect(diffs[0]?.diff).toContain('+# Checkout');
    } finally {
      await stack?.cleanup();
      stack = null;
      await removeTempDir(root);
    }
  });

  it('a detached HEAD has no branch; the checkpoint still lands on it', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    await withTopicFiles(s);
    await s.git(['checkout', '-q', '--detach']);
    expect(await s.manager.mainState()).toMatchObject({ isRepo: true, hasCommit: true, branch: null });
    const result = await s.manager.commitMainPaths({ paths: [SPEC, PLAN], message: 'm', trailers: [], as: s.principal(s.host.userId) });
    expect(result).toMatchObject({ created: true, branch: 'HEAD' });
    expect((await s.git(['rev-parse', 'HEAD'])).trim()).toBe(result.commit);
  });
});

describe('diffMainPaths: "Show the changes"', { timeout: 60_000 }, () => {
  it('diffs the files as they are now against HEAD or against the blobs a Start pinned: only what differs, with the file\'s own name', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    await withTopicFiles(s, '# Checkout\n\nOne page.\n', '# Plan\n\n1. Cart API\n');
    // Before the first Start: against HEAD, where neither file exists yet.
    const fresh = await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 64 * 1024 });
    expect(fresh.map((entry) => [entry.path, entry.truncated])).toEqual([[SPEC, false], [PLAN, false]]);
    expect(fresh[0]?.diff).toContain(`diff --git a/${SPEC} b/${SPEC}`);
    expect(fresh[0]?.diff).toContain('new file mode 100644');
    expect(fresh[0]?.diff).toContain('+One page.');
    expect(fresh[1]?.diff).toContain('+1. Cart API');

    const pinned = await s.manager.commitMainPaths({ paths: [SPEC, PLAN], message: 'smurg: spec and plan of checkout', trailers: [], as: s.principal(s.host.userId) });
    expect(await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 64 * 1024 })).toEqual([]);
    expect(await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: pinned.blobs, maxBytes: 64 * 1024 })).toEqual([]);

    // Amy fixes a typo in the spec (not committed): one entry, an ordinary diff of that file.
    await writeFile(join(s.t.root, SPEC), '# Checkout\n\nOne page, two columns.\n');
    for (const against of ['head', pinned.blobs] as const) {
      const changed = await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against, maxBytes: 64 * 1024 });
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ path: SPEC, truncated: false });
      expect(changed[0]?.diff).toContain(`--- a/${SPEC}`);
      expect(changed[0]?.diff).toContain(`+++ b/${SPEC}`);
      expect(changed[0]?.diff).toContain('-One page.');
      expect(changed[0]?.diff).toContain('+One page, two columns.');
      expect(changed[0]?.diff).not.toContain('Cart API');
    }
    // A later commit (another Start) moves HEAD; the pin of the first Start still answers against what IT confirmed.
    const later = await s.manager.commitMainPaths({ paths: [SPEC, PLAN], message: 'smurg: spec and plan of checkout', trailers: [], as: s.principal(s.host.userId) });
    expect(await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 64 * 1024 })).toEqual([]);
    expect((await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: pinned.blobs, maxBytes: 64 * 1024 })).map((entry) => entry.path)).toEqual([SPEC]);
    // "The file did not exist then" (null), and a file that is gone now.
    const sinceNothing = await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: { [SPEC]: later.blobs[SPEC] as string, [PLAN]: null }, maxBytes: 64 * 1024 });
    expect(sinceNothing.map((entry) => entry.path)).toEqual([PLAN]);
    expect(sinceNothing[0]?.diff).toContain('new file mode');
    await rm(join(s.t.root, PLAN));
    await writeFile(join(s.t.root, SPEC), '# Checkout\n\nA third wording nobody committed.\n');
    const objectsBefore = await s.git(['count-objects', '-v']);
    expect((await s.manager.diffMainPaths({ paths: [SPEC], against: 'head', maxBytes: 64 * 1024 }))[0]?.diff).toContain('+A third wording nobody committed.');
    await writeFile(join(s.t.root, SPEC), '# Checkout\n\nOne page, two columns.\n');
    const gone = await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 64 * 1024 });
    expect(gone.map((entry) => entry.path)).toEqual([PLAN]);
    expect(gone[0]?.diff).toContain('deleted file mode 100644');
    expect(gone[0]?.diff).toContain('-1. Cart API');
    // None of it wrote into the host's repository (the working tree's side is hashed into the daemon's own store) or
    // touched its index, and nothing is left in the daemon's staging folder.
    expect(await s.git(['count-objects', '-v'])).toBe(objectsBefore);
    expect(await s.git(['status', '--porcelain'])).toBe(` D ${PLAN}\n`);
    expect(await readdir(join(s.t.ctx.state.dir, 'git-staging'))).toEqual([]);
  });

  it('cuts each diff at its own limit, masks what looks like a credential, and never reads through a link', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    const key = `ghp_${'A1b2C3d4'.repeat(5)}`;
    await withTopicFiles(s, `# Checkout\n\nDeploy with token=${key}\n`, `# Plan\n${'1. A long line of the plan that repeats itself\n'.repeat(400)}`);
    const diffs = await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 2048 });
    const spec = diffs.find((entry) => entry.path === SPEC);
    const plan = diffs.find((entry) => entry.path === PLAN);
    expect(spec?.truncated).toBe(false);
    expect(spec?.diff).not.toContain(key);
    expect(spec?.diff).toContain(`token=${MASKED}`);
    expect(plan?.truncated).toBe(true);
    expect(Buffer.byteLength(plan?.diff ?? '')).toBeLessThanOrEqual(2048);
    expect(plan?.diff).toContain('+1. A long line of the plan');

    // The spec swapped for a link to a file outside the share: the daemon does not follow it. To the diff the file
    // is simply not there (against a pinned blob: a deletion; against nothing: no entry at all).
    const pinned = await s.manager.commitMainPaths({ paths: [SPEC, PLAN], message: 'm', trailers: [], as: s.principal(s.host.userId) });
    const secret = join(s.t.root, '..', 'host-secret.txt');
    await writeFile(secret, 'TOP SECRET\n');
    await rm(join(s.t.root, SPEC));
    await symlink(secret, join(s.t.root, SPEC));
    const linked = await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: pinned.blobs, maxBytes: 64 * 1024 });
    expect(linked.map((entry) => entry.path)).toEqual([SPEC]);
    expect(linked[0]?.diff).toContain('deleted file mode');
    expect(linked[0]?.diff).not.toContain('TOP SECRET');
    expect(await s.manager.diffMainPaths({ paths: [SPEC], against: { [SPEC]: null }, maxBytes: 64 * 1024 })).toEqual([]);
    // The same for a folder on the way that became a link.
    await rm(join(s.t.root, SPEC));
    await mkdir(join(s.t.root, '..', 'elsewhere'), { recursive: true });
    await writeFile(join(s.t.root, '..', 'elsewhere', 'SPEC.md'), 'TOP SECRET\n');
    await rm(join(s.t.root, 'specs', 'checkout'), { recursive: true });
    await symlink(join(s.t.root, '..', 'elsewhere'), join(s.t.root, 'specs', 'checkout'));
    const viaFolder = await s.manager.diffMainPaths({ paths: [SPEC], against: { [SPEC]: null }, maxBytes: 64 * 1024 });
    expect(viaFolder).toEqual([]);
    await rm(secret);
    await rm(join(s.t.root, '..', 'elsewhere'), { recursive: true });
    expect(await readFile(join(s.t.root, 'README.md'), 'utf8')).toBe('# demo\n');
  });

  it('a file that was just committed does not differ, whatever line endings the host\'s git converts (the pin check after a Start)', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    // The host's own repository setting: CRLF in the working tree, LF in the repository.
    await s.git(['config', 'core.autocrlf', 'true']);
    await withTopicFiles(s, '# Checkout\r\n\r\nOne page.\r\n', '# Plan\r\n\r\n1. Cart API\r\n');
    expect((await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 1 })).map((entry) => [entry.path, entry.truncated])).toEqual([[SPEC, true], [PLAN, true]]);
    const pinned = await s.manager.commitMainPaths({ paths: [SPEC, PLAN], message: 'smurg: spec and plan of checkout', trailers: [], as: s.principal(s.host.userId) });
    expect(pinned.created).toBe(true);
    expect(await s.manager.headBlobs([SPEC, PLAN])).toEqual(pinned.blobs);
    expect(await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: pinned.blobs, maxBytes: 1 })).toEqual([]);
    expect(await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: 'head', maxBytes: 1 })).toEqual([]);
    // A real change still shows, as the lines that changed.
    await writeFile(join(s.t.root, SPEC), '# Checkout\r\n\r\nTwo pages.\r\n');
    const changed = await s.manager.diffMainPaths({ paths: [SPEC, PLAN], against: pinned.blobs, maxBytes: 64 * 1024 });
    expect(changed.map((entry) => entry.path)).toEqual([SPEC]);
    expect(changed[0]?.diff).toContain('-One page.');
    expect(changed[0]?.diff).toContain('+Two pages.');
    expect(changed[0]?.diff).not.toContain('-# Checkout');
  });

  it('refuses a blob id that is not one, a path that is not the daemon\'s to show, and a blob the repository does not have', async () => {
    stack = await startWorktreeStack({ files: BASE });
    const s = stack;
    await withTopicFiles(s);
    expect(await settleError(s.manager.diffMainPaths({ paths: [SPEC], against: { [SPEC]: 'HEAD' }, maxBytes: 1024 }))).toMatchObject({ code: 'bad_request', reason: 'bad-blob' });
    expect(await settleError(s.manager.diffMainPaths({ paths: ['.git/config'], against: 'head', maxBytes: 1024 }))).toMatchObject({ code: 'bad_request', reason: 'bad-paths' });
    expect(await settleError(s.manager.diffMainPaths({ paths: ['.envrc'], against: 'head', maxBytes: 1024 }))).toMatchObject({ code: 'bad_request', reason: 'bad-paths' });
    expect(await settleError(s.manager.diffMainPaths({ paths: [SPEC], against: { [SPEC]: 'f'.repeat(40) }, maxBytes: 1024 }))).toMatchObject({ code: 'internal' });
    // Nothing is left behind in the daemon's staging folder.
    expect(await readdir(join(s.t.ctx.state.dir, 'git-staging'))).toEqual([]);
  });
});
