// The guard of protected entries (sandbox/guard.ts) where timing or resources decide, made deterministic with stand-ins
// for node:fs: a stale reading reported after a newer one (review GR-5), and a daemon out of descriptors (review GR-7).
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** lstat of `path` reads now and answers only once `release` resolved (a reading that is old when it arrives). */
const stale: { path: string | null; reached: (() => void) | null; release: Promise<void> | null } = { path: null, reached: null, release: null };
/** open() of these paths fails with EMFILE; of `denied`, with EACCES; the descriptors the guard opened and has not closed. */
const failing = new Set<string>();
const denied = new Set<string>();
const opened = new Set<number>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await (actual.lstat as (...a: unknown[]) => Promise<unknown>)(...args);
      if (stale.path !== null && args[0] === stale.path && stale.release !== null) {
        stale.path = null;
        stale.reached?.();
        await stale.release;
      }
      return result;
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const open = (path: string, flags: number, callback: (err: NodeJS.ErrnoException | null, fd: number) => void): void => {
    if (failing.has(path)) {
      process.nextTick(() => callback(Object.assign(new Error(`EMFILE: too many open files, open '${path}'`), { code: 'EMFILE' }), -1));
      return;
    }
    if (denied.has(path)) {
      process.nextTick(() => callback(Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' }), -1));
      return;
    }
    actual.open(path, flags, (err, fd) => {
      if (err === null) opened.add(fd);
      callback(err, fd);
    });
  };
  const closeSync = (fd: number): void => {
    opened.delete(fd);
    actual.closeSync(fd);
  };
  return { ...actual, default: { ...actual, open, closeSync }, open, closeSync };
});

const { silentLogger } = await import('../../src/core/logger.ts');
const { GuardResourceError, ProtectedEntryGuard } = await import('../../src/sandbox/guard.ts');
const { createTempDir, removeTempDir, waitFor } = await import('../../src/testing/index.ts');
type GuardBreach = import('../../src/sandbox/guard.ts').GuardBreach;
type WrappedCommand = import('../../src/core/interfaces.ts').WrappedCommand;

const temps: string[] = [];
const guards: InstanceType<typeof ProtectedEntryGuard>[] = [];
afterEach(async () => {
  stale.path = null;
  failing.clear();
  denied.clear();
  for (const guard of guards.splice(0)) guard.dispose();
  for (const dir of temps.splice(0)) await removeTempDir(dir);
});

let n = 0;
const command = (root: string): WrappedCommand => Object.freeze({ file: '/bin/sh', args: Object.freeze(['-c', `: ${++n}`]), env: Object.freeze({}), cwd: root });

async function setup(): Promise<{ root: string; guard: InstanceType<typeof ProtectedEntryGuard>; breaches: GuardBreach[] }> {
  const root = await createTempDir('guard-races');
  temps.push(root);
  const breaches: GuardBreach[] = [];
  const guard = new ProtectedEntryGuard({ log: silentLogger, onBreach: (breach) => breaches.push(breach), pollMs: 3_600_000 });
  guards.push(guard);
  return { root, guard, breaches };
}

describe('ProtectedEntryGuard races and resources', () => {
  it('a watcher reading taken before the host\'s change and reported after the poll recorded it: one breach, and a guest started after it keeps running (review GR-5: the stale reading revoked it and wrote the old state back)', async () => {
    const { root, guard, breaches } = await setup();
    const envrc = join(root, '.envrc');
    await writeFile(envrc, 'export A=1\n');
    const ta = await guard.enter(root, []);
    const a = command(root);
    expect(guard.issue(ta, a)).toBe(true);
    const revokedA: string[] = [];
    guard.onRevoked(a, () => revokedA.push('A'));

    // The watcher names .envrc (an in-place touch); its reading is taken now and arrives late.
    let letGo: () => void = () => {};
    stale.release = new Promise<void>((resolve) => (letGo = resolve));
    const reached = new Promise<void>((resolve) => (stale.reached = resolve));
    stale.path = envrc;
    guard.changed(root, [{ path: envrc, type: 'update' }]);
    await reached;

    // The host saves .envrc atomically; the poll sees it: breach #1, A revoked (right).
    await writeFile(`${envrc}.tmp`, 'export A=2\n');
    await rename(`${envrc}.tmp`, envrc);
    await guard.poll();
    expect(breaches).toHaveLength(1);
    expect(revokedA).toEqual(['A']);

    // Guest B starts with .envrc as it is now.
    const tb = await guard.enter(root, []);
    const b = command(root);
    expect(guard.issue(tb, b)).toBe(true);
    const revokedB: string[] = [];
    guard.onRevoked(b, () => revokedB.push('B'));

    // The old reading arrives: nothing changed after B started.
    letGo();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await guard.poll();
    expect({ breaches: breaches.length, revokedB }).toEqual({ breaches: 1, revokedB: [] });

    // A real change after that is still one.
    await writeFile(`${envrc}.tmp`, 'export A=3\n');
    await rename(`${envrc}.tmp`, envrc);
    guard.changed(root, [{ path: envrc, type: 'create' }]);
    await waitFor(() => revokedB.length === 1, { what: 'the revocation of B' });
    expect(breaches).toHaveLength(2);
  });

  it('a wrap() whose protected entries cannot be held open (EMFILE) is refused, with every descriptor it opened closed again (review GR-7: it went on unpinned, and a replaced entry kept its inode number)', async () => {
    const { root, guard, breaches } = await setup();
    const nested: string[] = [];
    for (let i = 0; i < 40; i++) {
      const path = join(root, `p${i}`, '.vscode');
      await mkdir(path, { recursive: true });
      nested.push(path);
    }
    failing.add(nested[30] as string);
    const before = opened.size;
    const err = await guard.enter(root, nested).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuardResourceError);
    expect((err as Error).message).toContain('EMFILE');
    expect(opened.size).toBe(before);
    expect(guard.guardedRoots()).toEqual([]);
    expect(breaches).toEqual([]);
    // With descriptors to spare, the same wrap() goes through.
    failing.clear();
    const ticket = await guard.enter(root, nested);
    expect(guard.issue(ticket, command(root))).toBe(true);
    expect(opened.size - before).toBeGreaterThanOrEqual(nested.length);
  });

  it("an entry whose inode the guard could not hold: any difference is a change, the same inode number with another mode included (one nobody holds can come back as another file's); held, a chmod is none (review GR-11)", async () => {
    const { root, guard, breaches } = await setup();
    const envrc = join(root, '.envrc');
    await writeFile(envrc, '');
    denied.add(envrc);
    const ta = await guard.enter(root, []);
    const a = command(root);
    expect(guard.issue(ta, a)).toBe(true);
    const revokedA: string[] = [];
    guard.onRevoked(a, () => revokedA.push('A'));
    await chmod(envrc, 0o444); // the shape of srt's file, the same inode number
    await guard.poll();
    expect(revokedA).toEqual(['A']);
    expect(breaches.map((breach) => breach.paths)).toEqual([[envrc]]);
    // Held (the next wrap() can open it): the host's chmod back is no change.
    denied.clear();
    const tb = await guard.enter(root, []);
    const b = command(root);
    expect(guard.issue(tb, b)).toBe(true);
    const revokedB: string[] = [];
    guard.onRevoked(b, () => revokedB.push('B'));
    await chmod(envrc, 0o644);
    await guard.poll();
    expect(revokedB).toEqual([]);
    expect(breaches).toHaveLength(1);
  });
});
