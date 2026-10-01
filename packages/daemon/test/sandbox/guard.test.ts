// The guard of protected entries while guest processes run (sandbox/guard.ts; reviews RV-1, RV-2, RV-3,
// ARCHITECTURE §7.6 "Linux, protected entries while a guest runs"): what counts as a change, who is revoked, a wrap()
// in flight, srt's mount-point files, a directory that appears, the poll and the last look at release. Real files in a
// temp dir, no sandbox (placeholders.real.test.ts runs it with bubblewrap on Linux).
import { existsSync, fstatSync, lstatSync } from 'node:fs';
import { appendFile, chmod, mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxRevocation, WrappedCommand } from '../../src/core/interfaces.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { GUARD_BREACH_PATHS_MAX, GUARD_REPIN_MAX, ProtectedEntryGuard, isProtectedPath, protectedEntriesBelow, type GuardBreach } from '../../src/sandbox/guard.ts';
import { guardWalk } from '../../src/sandbox/service.ts';
import { createTempDir, removeTempDir, waitFor } from '../../src/testing/index.ts';

const temps: string[] = [];
const guards: ProtectedEntryGuard[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) guard.dispose();
  for (const dir of temps.splice(0)) await removeTempDir(dir);
});

async function setup(files: Readonly<Record<string, string>> = {}, options: { readonly walkMs?: number } = {}): Promise<{ root: string; guard: ProtectedEntryGuard; breaches: GuardBreach[] }> {
  const root = await createTempDir('guard');
  temps.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    if (rel.endsWith('/')) await mkdir(path, { recursive: true });
    else await writeFile(path, content);
  }
  const breaches: GuardBreach[] = [];
  // No timer in these tests: poll() is called where a test wants it. With `walkMs`, the service's own walk.
  const guard = new ProtectedEntryGuard({
    log: silentLogger,
    onBreach: (breach) => breaches.push(breach),
    pollMs: 3_600_000,
    ...(options.walkMs === undefined ? {} : { walk: guardWalk, walkMs: options.walkMs }),
  });
  guards.push(guard);
  return { root, guard, breaches };
}

/** How many descriptors the guard holds for `root` (its pins). */
function pinsOf(guard: ProtectedEntryGuard, root: string): number {
  return (guard as unknown as { roots: Map<string, { pins: Map<string, number> }> }).roots.get(root)?.pins.size ?? 0;
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

/** The inode number the guard's descriptor for the recorded entry at `path` holds (null: none held). */
function heldIno(guard: ProtectedEntryGuard, root: string, path: string): bigint | null {
  const fd = (guard as unknown as { roots: Map<string, { pins: Map<string, number> }> }).roots.get(root)?.pins.get(path);
  return fd === undefined ? null : fstatSync(fd, { bigint: true }).ino;
}

const inoOf = (path: string): bigint => lstatSync(path, { bigint: true }).ino;

/**
 * Keeps this thread busy for `ms`: an lstat / open the guard started is done by then (the thread pool), its result not
 * yet seen here. Whatever runs next on this thread happens between the guard's look and its comparison.
 */
function busy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // the guard's look completes on the thread pool meanwhile
  }
}

const SRT_NAMES = ['.mcp.json', '.envrc'];
/** srt's mount point as bubblewrap makes it: an empty 0444 regular file. */
const srtFile = (path: string): boolean => {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return st !== undefined && st.isFile() && st.size === 0 && (st.mode & 0o777) === 0o444;
};

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

  it("CI run 36810877157: the canary's own mount points, recorded by a look while the wrap() ran and removed by srt when the canary ended, are made again when the command is handed out; srt's late removal event and the poll then change nothing", async () => {
    const { root, guard, breaches } = await setup();
    const ticket = await guard.enter(root, []);
    // The wrap()'s canary: bubblewrap makes srt's mount points, a look (watcher batch, poll) records them as srt's...
    for (const name of SRT_NAMES) await writeFile(join(root, name), '', { mode: 0o444 });
    await guard.poll();
    // ...and srt removes them when the canary is done (its count of running wraps is zero then); nobody looked since.
    for (const name of SRT_NAMES) await unlink(join(root, name));
    const wrapped = command(root);
    expect(guard.issue(ticket, wrapped)).toBe(true);
    const revocations: SandboxRevocation[] = [];
    guard.onRevoked(wrapped, (revocation) => revocations.push(revocation));
    // Handed out: the names are there, as bubblewrap would make them, before the process starts.
    for (const name of SRT_NAMES) expect(srtFile(join(root, name)), name).toBe(true);
    // The watcher's batch for srt's removal arrives now, before bubblewrap started; the poll runs too.
    guard.changed(root, SRT_NAMES.map((name) => ({ path: join(root, name), type: 'delete' as const })));
    await settle();
    await guard.poll();
    expect([revocations, breaches]).toEqual([[], []]);
    // The host's removal of one while the command runs is still a change.
    await unlink(join(root, '.envrc'));
    await guard.poll();
    expect(revocations).toEqual([{ root, paths: [join(root, '.envrc')] }]);
  });

  it('CI run 36810877157: a look under way when the command was handed out is not trusted for what the hand-out made (the poll, or a watcher batch, read .mcp.json / .envrc as absent just before issue() made them)', async () => {
    const { root, guard, breaches } = await setup();
    const ticket = await guard.enter(root, []);
    const polling = guard.poll(); // its lstat calls are on their way
    busy(100); // and done: they saw no .mcp.json / .envrc
    const wrapped = command(root);
    expect(guard.issue(ticket, wrapped)).toBe(true); // makes them, and the command runs from now on
    const revocations: SandboxRevocation[] = [];
    guard.onRevoked(wrapped, (revocation) => revocations.push(revocation));
    await polling;
    expect([revocations, breaches]).toEqual([[], []]);
    for (const name of SRT_NAMES) expect(srtFile(join(root, name)), name).toBe(true);
    // The same for a watcher batch under way.
    const other = await setup();
    const otherTicket = await other.guard.enter(other.root, []);
    other.guard.changed(other.root, SRT_NAMES.map((name) => ({ path: join(other.root, name), type: 'delete' as const })));
    busy(100);
    const otherWrapped = command(other.root);
    expect(other.guard.issue(otherTicket, otherWrapped)).toBe(true);
    const otherRevocations: SandboxRevocation[] = [];
    other.guard.onRevoked(otherWrapped, (revocation) => otherRevocations.push(revocation));
    await settle();
    expect([otherRevocations, other.breaches]).toEqual([[], []]);
  });

  it("a wrap()'s view taken while another wrap() of the root handed its command out keeps what the hand-out made; srt's file the host removed while a command runs is not made again by the next command (that removal is reported, both revoked)", async () => {
    const { root, guard, breaches } = await setup();
    const firstTicket = await guard.enter(root, []);
    const entering = guard.enter(root, []); // the second wrap()'s descriptors are being opened
    busy(100); // and opened: no .mcp.json / .envrc yet
    const first = command(root);
    expect(guard.issue(firstTicket, first)).toBe(true); // makes them
    const firstRevocations: SandboxRevocation[] = [];
    guard.onRevoked(first, (revocation) => firstRevocations.push(revocation));
    const secondTicket = await entering;
    expect([firstRevocations, breaches]).toEqual([[], []]);
    // The host's `git clean -fdx` takes srt's .envrc while the first runs, before anyone looked; the second is handed
    // out. srt removes nothing while the first runs, so the file gone is the host's doing: it lifted the first's deny.
    await unlink(join(root, '.envrc'));
    const second = command(root);
    expect(guard.issue(secondTicket, second)).toBe(true);
    expect(existsSync(join(root, '.envrc'))).toBe(false);
    const secondRevocations: SandboxRevocation[] = [];
    guard.onRevoked(second, (revocation) => secondRevocations.push(revocation));
    await guard.poll();
    const expected = { root, paths: [join(root, '.envrc')] };
    expect([firstRevocations, secondRevocations]).toEqual([[expected], [expected]]);
    expect(breaches).toEqual([{ ...expected, revoked: 2 }]);
  });

  it("srt's file already there at the hand-out (a process in another root kept a canary's mount point) is held from then on: the host's removal of it and a file the guest makes in its place is a change, and cannot get its inode number (ext4 hands a freed one straight back)", async () => {
    const { root, guard } = await setup();
    const mcp = join(root, '.mcp.json');
    const ticket = await guard.enter(root, []);
    await writeFile(mcp, '', { mode: 0o444 });
    guard.changed(root, [{ path: mcp, type: 'create' }]);
    await settle();
    expect(heldIno(guard, root, mcp)).toBe(inoOf(mcp)); // recorded from the watcher's batch, and held
    // srt removes it and another canary's bubblewrap makes it again; nobody looked since.
    await unlink(mcp);
    await writeFile(mcp, '', { mode: 0o444 });
    const ino = inoOf(mcp);
    const wrapped = command(root);
    expect(guard.issue(ticket, wrapped)).toBe(true);
    expect(heldIno(guard, root, mcp)).toBe(ino);
    const revocations: SandboxRevocation[] = [];
    guard.onRevoked(wrapped, (revocation) => revocations.push(revocation));
    // The host's `git clean -fdx` takes it; the guest, its deny gone, writes its own .mcp.json there.
    await unlink(mcp);
    await writeFile(mcp, '{"mcpServers":{"x":{"command":"sh"}}}\n');
    expect(inoOf(mcp)).not.toBe(ino);
    guard.changed(root, [
      { path: mcp, type: 'delete' },
      { path: mcp, type: 'create' },
    ]);
    await waitFor(() => revocations.length === 1, { what: 'the revocation' });
    expect(revocations[0]?.paths).toEqual([mcp]);
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

// The guard-review round of 2026-10-01 (findings GR-1, GR-2, GR-6, GR-10, GR-11).
describe('ProtectedEntryGuard: what the watcher never reports, floods, odd records', () => {
  it('a protected name nothing reported (made in a directory the watcher never watched) is found by the walk and revokes what runs there; the host\'s new secret in such a directory is named too; a new nested .git is not (a guest\'s git clone, the documented residual) (review GR-1)', async () => {
    const { root, guard, breaches } = await setup({ 'deep/': '', 'svc/api/config/': '' }, { walkMs: 3_600_000 });
    const { revocations } = await issued(guard, root);
    // A guest's `mkdir -p deep/a/b`, later the name: no watcher event at all (inotify never watched deep/a/b).
    await mkdir(join(root, 'deep', 'a', 'b', '.claude'), { recursive: true });
    await writeFile(join(root, 'deep', 'a', 'b', '.claude', 'settings.json'), '{"hooks":{}}\n');
    await mkdir(join(root, 'vendor', 'lib', '.git', 'hooks'), { recursive: true });
    // The walk keeps to its interval: an ordinary poll does not walk yet.
    await guard.poll();
    expect(revocations).toEqual([]);
    await guard.rescan(root);
    expect(revocations).toEqual([{ root, paths: [join(root, 'deep', 'a', 'b', '.claude')] }]);
    // The host's own secret in a directory made with `mkdir -p` before the guest started: named (nothing left to revoke).
    await writeFile(join(root, 'svc', 'api', 'config', '.envrc'), 'export TOKEN=secret\n');
    await guard.rescan(root);
    expect(breaches).toEqual([
      { root, paths: [join(root, 'deep', 'a', 'b', '.claude')], revoked: 1 },
      { root, paths: [join(root, 'svc', 'api', 'config', '.envrc')], revoked: 0 },
    ]);
    // Recorded now: the next walk names nothing again, and the new .git never.
    await guard.rescan(root);
    expect(breaches).toHaveLength(2);
  });

  it('due walks run from the poll, spaced by their interval (review GR-1)', async () => {
    const { root, guard } = await setup({ 'deep/': '' }, { walkMs: 0 });
    const { revocations } = await issued(guard, root);
    await mkdir(join(root, 'deep', 'n', '.idea'), { recursive: true });
    await waitFor(
      async () => {
        await guard.poll();
        return revocations.length > 0;
      },
      { what: 'a walk from the poll' },
    );
    expect(revocations).toEqual([{ root, paths: [join(root, 'deep', 'n', '.idea')] }]);
  });

  it('a name planted below the top just before the root\'s last process ended is still named to the host after the release (nothing left to revoke) (review GR-1)', async () => {
    const { root, guard, breaches } = await setup({ 'deep/': '', 'kept/.vscode/': '' }, { walkMs: 3_600_000 });
    const { wrapped } = await issued(guard, root, [join(root, 'kept', '.vscode')]);
    await mkdir(join(root, 'deep', 'x', '.claude'), { recursive: true });
    await rmdir(join(root, 'kept', '.vscode'));
    guard.release(wrapped);
    expect(guard.guardedRoots()).toEqual([]);
    await waitFor(() => breaches.length === 1, { what: 'the last look' });
    expect(breaches).toEqual([{ root, paths: [join(root, 'deep', 'x', '.claude'), join(root, 'kept', '.vscode')], revoked: 0 }]);
    // A root where nothing was ever handed out gets no last look (nothing of a guest ran there).
    const ticket = await guard.enter(root, []);
    guard.leave(ticket);
    await settle();
    expect(breaches).toHaveLength(1);
  });

  it('one watcher batch that brings tens of thousands of protected entries: one breach that names 100 and counts the rest, a bounded number of entries re-pinned, no long stall of the event loop (review GR-2: 5.6 s for 60,000 paths)', async () => {
    const { root, guard, breaches } = await setup();
    const dirs = 4_000;
    const x = join(root, 'x');
    for (let i = 0; i < dirs; i += 250) {
      await Promise.all(
        Array.from({ length: 250 }, async (_, k) => {
          const d = join(x, `d${i + k}`);
          await mkdir(join(d, '.vscode'), { recursive: true });
          await Promise.all([mkdir(join(d, '.idea')), mkdir(join(d, '.smurg')), writeFile(join(d, '.mcp.json'), '{}'), writeFile(join(d, '.envrc'), 'x'), writeFile(join(d, 'CLAUDE.local.md'), 'x')]);
        }),
      );
    }
    const { revocations } = await issued(guard, root);
    const pinnedBefore = pinsOf(guard, root);
    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 5);
      last = now;
    }, 5);
    try {
      guard.changed(root, [{ path: x, type: 'create' }]);
      await waitFor(() => breaches.length === 1, { timeoutMs: 120_000, what: 'the breach' });
      await settle();
    } finally {
      clearInterval(timer);
    }
    const total = dirs * 6;
    expect(breaches[0]?.paths).toHaveLength(GUARD_BREACH_PATHS_MAX);
    expect(breaches[0]?.more).toBe(total - GUARD_BREACH_PATHS_MAX);
    expect(breaches[0]?.revoked).toBe(1);
    expect(revocations[0]?.paths).toEqual(breaches[0]?.paths);
    expect(revocations[0]?.more).toBe(total - GUARD_BREACH_PATHS_MAX);
    expect(pinsOf(guard, root) - pinnedBefore).toBeLessThanOrEqual(GUARD_REPIN_MAX);
    expect(maxLag).toBeLessThan(400);
  }, 180_000);

  it('an entry the record has and a later wrap()\'s walk did not name is looked at, never assumed gone (review GR-6: a capped walk named different subsets and every wrap revoked the guests)', async () => {
    const { root, guard, breaches } = await setup({ 'a/CLAUDE.local.md': 'a\n', 'b/CLAUDE.local.md': 'b\n' });
    const both = [join(root, 'a', 'CLAUDE.local.md'), join(root, 'b', 'CLAUDE.local.md')];
    const running = await issued(guard, root, both);
    await guard.enter(root, [both[0] as string]);
    await guard.enter(root, [both[1] as string]);
    expect(breaches).toEqual([]);
    expect(running.revocations).toEqual([]);
    // Gone for real: that is a change, whichever walk names what.
    await unlink(both[1] as string);
    await guard.enter(root, [both[0] as string]);
    expect(running.revocations).toEqual([{ root, paths: [both[1]] }]);
  });

  it("the same file with another mode is no change (the host's chmod of its own empty .envrc); srt's mount point replaced by another empty read-only file while a process runs is a change; srt making its file again while nothing runs is not (review GR-11)", async () => {
    const { root, guard, breaches } = await setup({ '.envrc': '' });
    // srt's own churn while only a wrap() is in flight: its file made, removed, made again.
    const first = await guard.enter(root, []);
    for (let i = 0; i < 2; i++) {
      await writeFile(join(root, '.mcp.json'), '', { mode: 0o444 });
      await guard.poll();
      await unlink(join(root, '.mcp.json'));
      await guard.poll();
    }
    const wrapped = command(root);
    expect(guard.issue(first, wrapped)).toBe(true);
    const revocations: SandboxRevocation[] = [];
    guard.onRevoked(wrapped, (revocation) => revocations.push(revocation));
    await chmod(join(root, '.envrc'), 0o444); // `chmod a-w .envrc`: the shape of srt's file, but the host's own
    await guard.poll();
    await chmod(join(root, '.envrc'), 0o644);
    await guard.poll();
    expect(breaches).toEqual([]);
    // The guard made srt's mount point for the absent .mcp.json; the host puts its own empty read-only file there.
    await unlink(join(root, '.mcp.json'));
    await writeFile(join(root, '.mcp.json'), '', { mode: 0o444 });
    await guard.poll();
    expect(revocations).toEqual([{ root, paths: [join(root, '.mcp.json')] }]);
  });

  it('a disposed guard says so: the service refuses a wrap() in flight as stopping, not as a change (review GR-10)', async () => {
    const { root, guard } = await setup();
    const ticket = await guard.enter(root, []);
    expect(guard.isDisposed()).toBe(false);
    guard.dispose();
    expect(guard.isDisposed()).toBe(true);
    expect(guard.issue(ticket, command(root))).toBe(false);
  });
});
