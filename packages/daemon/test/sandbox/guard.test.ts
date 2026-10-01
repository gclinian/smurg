// The guard of protected entries while guest processes run (sandbox/guard.ts; reviews RV-1, RV-2, RV-3,
// ARCHITECTURE §7.6 "Linux, protected entries while a guest runs"): what counts as a change, who is revoked, a wrap()
// in flight, srt's mount-point files, a directory that appears, the poll and the last look at release. Real files in a
// temp dir, no sandbox (placeholders.real.test.ts runs it with bubblewrap on Linux).
import { existsSync, lstatSync } from 'node:fs';
import { appendFile, mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxRevocation, WrappedCommand } from '../../src/core/interfaces.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { ProtectedEntryGuard, isProtectedPath, protectedEntriesBelow, type GuardBreach } from '../../src/sandbox/guard.ts';
import { createTempDir, removeTempDir, waitFor } from '../../src/testing/index.ts';

const temps: string[] = [];
const guards: ProtectedEntryGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) guard.dispose();
  for (const dir of temps.splice(0)) await removeTempDir(dir);
});

async function setup(files: Readonly<Record<string, string>> = {}): Promise<{ root: string; guard: ProtectedEntryGuard; breaches: GuardBreach[] }> {
  const root = await createTempDir('guard');
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    if (rel.endsWith('/')) await mkdir(path, { recursive: true });
    else await writeFile(path, content);
  }
  const breaches: GuardBreach[] = [];
  // No timer in these tests: poll() is called where a test wants it.
  const guard = new ProtectedEntryGuard({ log: silentLogger, onBreach: (breach) => breaches.push(breach), pollMs: 3_600_000 });
  guards.push(guard);
  return { root, guard, breaches };
}

let commands = 0;
function command(root: string): WrappedCommand {
  commands++;
  return Object.freeze({ file: '/bin/sh', args: Object.freeze(['-c', `: ${commands}`]), env: Object.freeze({}), cwd: root });
}

async function issued(guard: ProtectedEntryGuard, root: string, nested: readonly string[] = []): Promise<{ wrapped: WrappedCommand; revocations: SandboxRevocation[] }> {
  const ticket = await guard.enter(root, nested);
  const wrapped = command(root);
  expect(guard.issue(ticket, wrapped)).toBe(true);
  const revocations: SandboxRevocation[] = [];
  guard.onRevoked(wrapped, (revocation) => revocations.push(revocation));
  return { wrapped, revocations };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

describe('ProtectedEntryGuard', () => {
  it('names: host-only and host-private names at any depth, settings.local.json only inside .claude', () => {
    for (const path of ['/r/.claude', '/r/a/.git', '/r/.vscode', '/r/x/.idea', '/r/.smurg', '/r/.mcp.json', '/r/b/.envrc', '/r/CLAUDE.local.md', '/r/c/.claude/settings.local.json']) expect(isProtectedPath(path), path).toBe(true);
    for (const path of ['/r/settings.local.json', '/r/.claude/settings.json', '/r/CLAUDE.md', '/r/src/index.ts', '/r/.envrc.tmp']) expect(isProtectedPath(path), path).toBe(false);
  });

  it('an atomic save, a creation or a removal of a protected entry revokes every command issued in that root, once; a listener added later is told at once; an in-place edit or an ordinary file is no change', async () => {
    const { root, guard, breaches } = await setup({ '.envrc': 'export A=1\n', '.claude/': '', 'src/a.ts': 'a\n' });
    const one = await issued(guard, root);
    const two = await issued(guard, root);
    await appendFile(join(root, '.envrc'), 'export B=2\n');
    await writeFile(join(root, 'src', 'a.ts'), 'b\n');
    guard.changed(root, [
      { path: join(root, '.envrc'), type: 'update' },
      { path: join(root, 'src', 'a.ts'), type: 'update' },
    ]);
    await settle();
    await guard.poll();
    expect([one.revocations, two.revocations, breaches]).toEqual([[], [], []]);
    await writeFile(join(root, '.envrc.tmp'), 'export A=3\n');
    await rename(join(root, '.envrc.tmp'), join(root, '.envrc'));
    guard.changed(root, [{ path: join(root, '.envrc'), type: 'create' }]);
    await waitFor(() => breaches.length === 1, { what: 'the breach' });
    const expected = { root, paths: [join(root, '.envrc')] };
    expect(one.revocations).toEqual([expected]);
    expect(two.revocations).toEqual([expected]);
    expect(breaches).toEqual([{ ...expected, revoked: 2 }]);
    const late: SandboxRevocation[] = [];
    guard.onRevoked(one.wrapped, (revocation) => late.push(revocation));
    expect(late).toEqual([expected]);
    // The same change is not reported twice (the record follows it); the next one is, and revokes nobody new.
    await guard.poll();
    expect(breaches).toHaveLength(1);
    await writeFile(join(root, '.claude', 'settings.local.json'), '{"env":{"T":"x"}}\n');
    guard.changed(root, [{ path: join(root, '.claude', 'settings.local.json'), type: 'create' }]);
    await waitFor(() => breaches.length === 2, { what: 'the second breach' });
    expect(breaches[1]).toEqual({ root, paths: [join(root, '.claude', 'settings.local.json')], revoked: 0 });
    expect(one.revocations).toHaveLength(1);
    // Another root is not this one's business.
    const other = await setup({ '.envrc': 'x\n' });
    const there = await issued(other.guard, other.root);
    guard.changed(other.root, [{ path: join(other.root, '.envrc'), type: 'create' }]);
    await settle();
    expect(there.revocations).toEqual([]);
  });

  it('a recorded entry replaced by one of the same kind is a change even where the file system hands its inode number straight back (the record holds the inode; review RV-3 / diff-review E3)', async () => {
    const { root, guard, breaches } = await setup({ '.vscode/': '' });
    const { revocations } = await issued(guard, root);
    await rmdir(join(root, '.vscode'));
    await mkdir(join(root, '.vscode'));
    await guard.poll();
    expect(revocations).toEqual([{ root, paths: [join(root, '.vscode')] }]);
    expect(breaches).toHaveLength(1);
  });

  it("srt's mount-point files: made for an absent .mcp.json / .envrc when a command is handed out; srt making or removing one while nothing is handed out is no change; the host removing one while a command runs is", async () => {
    const { root, guard, breaches } = await setup();
    // A wrap() in flight only (its self-tests come and go): srt's file appears and goes.
    const first = await guard.enter(root, []);
    await writeFile(join(root, '.mcp.json'), '', { mode: 0o444 });
    await guard.poll();
    await unlink(join(root, '.mcp.json'));
    await guard.poll();
    expect(breaches).toEqual([]);
    // Handed out: the service makes the mount points bubblewrap would make (empty, 0444).
    const wrapped = command(root);
    expect(guard.issue(first, wrapped)).toBe(true);
    for (const name of ['.mcp.json', '.envrc']) {
      const st = lstatSync(join(root, name));
      expect([st.isFile(), st.size, (st.mode & 0o777).toString(8)], name).toEqual([true, 0, '444']);
    }
    const revocations: SandboxRevocation[] = [];
    guard.onRevoked(wrapped, (revocation) => revocations.push(revocation));
    await guard.poll();
    expect(breaches).toEqual([]);
    // The host's `git clean -fdx` takes one while the command runs: the deny it carried is gone.
    await unlink(join(root, '.envrc'));
    guard.changed(root, [{ path: join(root, '.envrc'), type: 'delete' }]);
    await waitFor(() => revocations.length === 1, { what: 'the revocation' });
    expect(revocations[0]?.paths).toEqual([join(root, '.envrc')]);
  });

  it('a wrap() in flight: a change after it entered makes its command not handed out; a later wrap() that sees the root differently revokes what runs', async () => {
    const { root, guard, breaches } = await setup({ '.claude/': '' });
    const running = await issued(guard, root);
    const inFlight = await guard.enter(root, []);
    await rmdir(join(root, '.claude')); // the host's `git clean -fd`
    await guard.poll();
    expect(running.revocations).toHaveLength(1);
    expect(guard.issue(inFlight, command(root))).toBe(false);
    guard.release(running.wrapped);
    expect(guard.guardedRoots()).toEqual([]);
    // No event and no poll: the next wrap()'s own view shows the change.
    const again = await issued(guard, root);
    await writeFile(join(root, 'CLAUDE.local.md'), 'the host notes\n');
    await guard.enter(root, []);
    expect(again.revocations).toEqual([{ root, paths: [join(root, 'CLAUDE.local.md')] }]);
    expect(breaches.at(-1)).toEqual({ root, paths: [join(root, 'CLAUDE.local.md')], revoked: 1 });
  });

  it('a directory that appears (made, moved in) is looked through for protected names; node_modules and .git are not; nested entries recorded at the start are no change', async () => {
    const { root, guard, breaches } = await setup({ 'pkg/.envrc': 'recorded\n', 'pkg/.claude/settings.local.json': '{}\n', 'pkg/CLAUDE.local.md': 'n\n' });
    const { revocations } = await issued(guard, root, [join(root, 'pkg', '.envrc'), join(root, 'pkg', '.claude'), join(root, 'pkg', 'CLAUDE.local.md')]);
    // `pkg` touched: its recorded contents are the same.
    guard.changed(root, [{ path: join(root, 'pkg'), type: 'update' }]);
    await settle();
    await guard.poll();
    expect(breaches).toEqual([]);
    // A folder moved in from elsewhere: the watcher reports the folder only.
    const outside = await createTempDir('guard-outside');
    temps.push(outside);
    const made = join(outside, 'proj');
    for (const dir of ['deep/er/.vscode', 'node_modules/x', '.git/hooks', 'plain']) await mkdir(join(made, dir), { recursive: true });
    await writeFile(join(made, 'deep', '.envrc'), 'export SECRET=moved-in\n');
    await writeFile(join(made, 'node_modules', 'x', '.envrc'), 'skipped\n');
    await rename(made, join(root, 'proj'));
    guard.changed(root, [
      { path: join(root, 'proj'), type: 'create' },
      { path: join(root, 'proj', 'plain'), type: 'create' },
    ]);
    await waitFor(() => revocations.length === 1, { what: 'the revocation' });
    expect(revocations[0]?.paths).toEqual([join(root, 'proj', 'deep', '.envrc'), join(root, 'proj', 'deep', 'er', '.vscode')]);
    // A scan stops at its limit and says so.
    expect(await protectedEntriesBelow(join(root, 'proj'), 1)).toEqual({ found: [], complete: false });
  });

  it('the last command released: a top-level change of its last moments is reported (nothing left to revoke), and the record goes; a root with nothing running is not looked at', async () => {
    const { root, guard, breaches } = await setup();
    const { wrapped } = await issued(guard, root);
    await mkdir(join(root, '.git')); // the watcher never reports .git
    guard.release(wrapped);
    expect(breaches).toEqual([{ root, paths: [join(root, '.git')], revoked: 0 }]);
    expect(guard.guardedRoots()).toEqual([]);
    // srt's mount points made for the command were part of the record: not reported. With nothing running, nothing is.
    expect(existsSync(join(root, '.mcp.json'))).toBe(true);
    await writeFile(join(root, 'CLAUDE.local.md'), 'later\n');
    guard.changed(root, [{ path: join(root, 'CLAUDE.local.md'), type: 'create' }]);
    await settle();
    await guard.poll();
    expect(breaches).toHaveLength(1);
  });
});
