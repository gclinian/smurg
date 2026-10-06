// The file watcher (ARCHITECTURE §7.3 file.changed, §7.5 watcher; yjs-monaco.md Q7): @parcel/watcher per root,
// batched and de-duplicated events, one bus event + one message to readers per batch, attribution of the daemon's own
// changes, ignored paths, and roots that come and go (worktrees, with their shared read-only directories).
import { mkdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, rootRefKey, type PayloadOf } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import type { DaemonEvents, SessionManager } from '../../src/core/interfaces.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { ROOT_GONE_TIMEOUT_MS } from '../../src/files/watcher.ts';
import { waitFor, type TestClient } from '../../src/testing/index.ts';
import { startFilesDaemon, type FilesTest } from './helpers.ts';

let ft: FilesTest | null = null;

afterEach(async () => {
  await ft?.t.cleanup();
  ft = null;
});

type Changed = PayloadOf<'file.changed'>;

interface Recorder {
  readonly wire: Changed[];
  readonly bus: DaemonEvents['file.changed'][];
  changes(root?: string): Changed['changes'];
}

async function setup(): Promise<{ ft: FilesTest; amy: TestClient; vera: TestClient; rec: Recorder }> {
  ft = await startFilesDaemon({ project: { files: { 'README.md': '# hi\n', 'src/app.ts': 'x\n', 'data/table.csv': 'a,b\n' } } });
  const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  const vera = await ft.t.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
  const wire: Changed[] = [];
  const bus: DaemonEvents['file.changed'][] = [];
  vera.conn.on('file.changed', (payload) => wire.push(payload));
  ft.t.ctx.bus.on('file.changed', (event) => bus.push(event));
  // FSEvents starts delivering a moment after subscribe(): make sure the stream is live before a test writes.
  await writeFile(join(ft.t.root, 'warmup.txt'), 'w');
  await waitFor(() => wire.some((m) => m.changes.some((c) => c.path === 'warmup.txt')), { timeoutMs: 10_000, what: 'the watcher to deliver a first event' });
  wire.length = 0;
  bus.length = 0;
  const rec: Recorder = {
    wire,
    bus,
    changes: (root = 'main') => wire.filter((m) => rootRefKey(m.root) === root).flatMap((m) => m.changes),
  };
  return { ft, amy, vera, rec };
}

const settleWatcher = () => new Promise((resolve) => setTimeout(resolve, 600));

/**
 * How long a root that came back may stay unwatched. The dead subscription is released first, and only once
 * the native module reported the root deleted (+ a 500 ms grace) — or, when it never does, after ROOT_GONE_TIMEOUT_MS
 * (files/watcher.ts). It never does when the folder is back before FSEvents delivered the move: @parcel/watcher then
 * finds the root present and reports no deletion. That happens under load (a full gate run, 2026-09-29: FSEvents
 * delivery slower than the 100 ms root check, the root moved back at once), so the bound is the timeout plus the
 * periodic check and the new subscribe, with room for a busy machine; the fast path takes ~0.5 s.
 */
const REWATCH_DEADLINE_MS = ROOT_GONE_TIMEOUT_MS + 5_000;

/** Waits until the main root is watched again; a timeout names the watcher's path (its log) instead of just "timed out". */
async function rewatched(f: FilesTest, log: ReturnType<typeof createMemoryLogger>, what: string): Promise<void> {
  try {
    await waitFor(() => f.instance().watcher?.watchedRoots().includes('main') === true, { timeoutMs: REWATCH_DEADLINE_MS, what });
  } catch (err) {
    const lines = log.lines.filter((line) => /root|watch/.test(line.message)).map((line) => `${line.level} ${line.message}`);
    throw new Error(`${(err as Error).message}; watcher log: ${lines.join(' | ') || '(nothing)'}`);
  }
}

describe('file watcher', { timeout: 60_000 }, () => {
  it('an external change reaches the bus and every reader as file.changed, unattributed', async () => {
    const { ft: f, rec } = await setup();
    await writeFile(join(f.t.root, 'external.txt'), 'made outside smurg\n');
    await waitFor(() => rec.changes().some((c) => c.path === 'external.txt'), { timeoutMs: 10_000, what: 'file.changed for external.txt' });
    const change = rec.changes().find((c) => c.path === 'external.txt');
    expect(change).toEqual({ path: 'external.txt', change: 'add' });
    expect(rec.bus.flatMap((e) => e.changes).find((c) => c.path === 'external.txt')).toEqual({ path: 'external.txt', change: 'add' });
    await writeFile(join(f.t.root, 'external.txt'), 'changed again\n');
    await waitFor(() => rec.changes().filter((c) => c.path === 'external.txt').length >= 2, { timeoutMs: 10_000, what: 'the second change' });
    await unlink(join(f.t.root, 'external.txt'));
    await waitFor(() => rec.changes().some((c) => c.path === 'external.txt' && c.change === 'unlink'), { timeoutMs: 10_000, what: 'the unlink' });
  });

  it('changes made through the daemon are attributed to whoever made them', async () => {
    const { amy, rec } = await setup();
    await amy.conn.request('file.write', { file: { root: MAIN_ROOT, path: 'README.md' }, content: new TextEncoder().encode('# by Amy\n') });
    await amy.conn.request('file.create', { file: { root: MAIN_ROOT, path: 'newdir' }, kind: 'dir' });
    await waitFor(() => rec.changes().some((c) => c.path === 'README.md') && rec.changes().some((c) => c.path === 'newdir'), { timeoutMs: 10_000, what: 'both changes' });
    const amyActor = { kind: 'user', userId: 'dev:amy', displayName: 'Amy' };
    expect(rec.changes().find((c) => c.path === 'README.md')?.by).toEqual(amyActor);
    expect(rec.changes().find((c) => c.path === 'newdir')).toEqual({ path: 'newdir', change: 'addDir', by: amyActor });
    await amy.conn.request('file.delete', { file: { root: MAIN_ROOT, path: 'newdir' } });
    await waitFor(() => rec.changes().some((c) => c.path === 'newdir' && c.change === 'unlinkDir'), { timeoutMs: 10_000, what: 'unlinkDir' });
    expect(rec.changes().find((c) => c.change === 'unlinkDir')?.by).toEqual(amyActor);
  });

  it('a granted agent lock announces the agent: its write is attributed to `Claude (owner)`', async () => {
    const { ft: f, rec } = await setup();
    f.t.ctx.bus.emit('agent.tool.pre', { sessionId: 'sess_watch', ownerUserId: 'dev:amy', tool: 'Edit', file: { root: MAIN_ROOT, path: 'src/app.ts' }, outcome: 'granted' });
    // Claude Code writes a temp file and renames it over the target (yjs-monaco.md V9).
    await writeFile(join(f.t.root, 'src/app.ts.tmp.9999.0123456789ab'), 'agent edit\n');
    const { rename } = await import('node:fs/promises');
    await rename(join(f.t.root, 'src/app.ts.tmp.9999.0123456789ab'), join(f.t.root, 'src/app.ts'));
    await waitFor(() => rec.changes().some((c) => c.path === 'src/app.ts'), { timeoutMs: 10_000, what: 'the agent edit' });
    expect(rec.changes().find((c) => c.path === 'src/app.ts')?.by).toEqual({ kind: 'agent', sessionId: 'sess_watch', ownerUserId: 'dev:amy', displayName: 'Claude (Amy)' });
    // The temp file itself never shows up.
    expect(rec.changes().some((c) => c.path.includes('.tmp.'))).toBe(false);
    f.t.ctx.bus.emit('agent.tool.post', { sessionId: 'sess_watch', ownerUserId: 'dev:amy', tool: 'Edit', file: { root: MAIN_ROOT, path: 'src/app.ts' }, ok: true });
    expect(f.t.ctx.services.files.lastModifiedBy({ root: MAIN_ROOT, path: 'src/app.ts' })).toMatchObject({ kind: 'agent', displayName: 'Claude (Amy)' });
  });

  it("an agent the session registry names is attributed under that name (a topic's agent is `Claude (<topic>)`, as its lock says), never under its owner's", async () => {
    // What the sessions module's registry answers for a discussion session of the topic "Checkout" that Amy opened.
    const named: FeatureModule = {
      name: 'named-sessions',
      create: () => ({ sessions: { agentActor: (sessionId: string) => (sessionId === 'sess_topic' ? { kind: 'agent', sessionId, ownerUserId: 'dev:amy', displayName: 'Claude (Checkout)' } : null) } as unknown as SessionManager }),
      register: () => ({ dispose: () => {} }),
    };
    ft = await startFilesDaemon({ project: { files: { 'src/app.ts': 'x\n', 'src/other.ts': 'y\n' } }, extraModules: [named], files: { watch: false } });
    const amy = await ft.t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    void amy;
    const files = ft.t.ctx.services.files;
    ft.t.ctx.bus.emit('agent.tool.post', { sessionId: 'sess_topic', ownerUserId: 'dev:amy', tool: 'Edit', file: { root: MAIN_ROOT, path: 'src/app.ts' }, ok: true });
    expect(files.lastModifiedBy({ root: MAIN_ROOT, path: 'src/app.ts' })).toEqual({ kind: 'agent', sessionId: 'sess_topic', ownerUserId: 'dev:amy', displayName: 'Claude (Checkout)' });
    // A session the registry does not know keeps the default name after its owner.
    ft.t.ctx.bus.emit('agent.tool.post', { sessionId: 'sess_unknown', ownerUserId: 'dev:amy', tool: 'Edit', file: { root: MAIN_ROOT, path: 'src/other.ts' }, ok: true });
    expect(files.lastModifiedBy({ root: MAIN_ROOT, path: 'src/other.ts' })).toEqual({ kind: 'agent', sessionId: 'sess_unknown', ownerUserId: 'dev:amy', displayName: 'Claude (Amy)' });
    // A name gives no right and needs a member: the agent of somebody who is not one is nobody.
    ft.t.ctx.bus.emit('agent.tool.post', { sessionId: 'sess_topic', ownerUserId: 'dev:gone', tool: 'Edit', file: { root: MAIN_ROOT, path: 'src/other.ts' }, ok: true });
    expect(files.lastModifiedBy({ root: MAIN_ROOT, path: 'src/other.ts' })).toMatchObject({ displayName: 'Claude (Amy)' });
  });

  it('a burst is batched and de-duplicated: few messages, each path at most once per message', async () => {
    const { ft: f, rec } = await setup();
    for (let i = 0; i < 60; i++) await writeFile(join(f.t.root, `burst-${i}.txt`), `${i}`);
    for (let i = 0; i < 5; i++) await writeFile(join(f.t.root, 'burst-0.txt'), `again ${i}`);
    await waitFor(() => new Set(rec.changes().map((c) => c.path).filter((p) => p.startsWith('burst-'))).size === 60, { timeoutMs: 10_000, what: 'all 60 paths' });
    await settleWatcher();
    const messages = rec.wire.filter((m) => m.changes.some((c) => c.path.startsWith('burst-')));
    expect(messages.length).toBeLessThan(20);
    for (const message of messages) expect(new Set(message.changes.map((c) => c.path)).size).toBe(message.changes.length);
    expect(rec.bus.length).toBe(rec.wire.length); // one bus event per message
  });

  it('ignores .git, node_modules (at any depth), .smurg and editor/agent temp files', async () => {
    const { ft: f, rec } = await setup();
    await mkdir(join(f.t.root, '.git/objects'), { recursive: true });
    await writeFile(join(f.t.root, '.git/objects/ab'), 'x');
    await mkdir(join(f.t.root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(f.t.root, 'node_modules/pkg/index.js'), 'x');
    await mkdir(join(f.t.root, 'src/node_modules/dep'), { recursive: true });
    await writeFile(join(f.t.root, 'src/node_modules/dep/a.js'), 'x');
    await writeFile(join(f.t.root, '.smurg/scratch.txt'), 'x');
    await writeFile(join(f.t.root, '.README.md.smurg-0123456789ab.tmp'), 'x');
    await writeFile(join(f.t.root, 'README.md.tmp.123.0123456789ab'), 'x');
    await writeFile(join(f.t.root, '.!30367!README.md'), 'x'); // BSD sed -i
    await writeFile(join(f.t.root, 'src/sedAb12Cd'), 'x'); // GNU sed -i
    await writeFile(join(f.t.root, 'marker.txt'), 'last');
    await waitFor(() => rec.changes().some((c) => c.path === 'marker.txt'), { timeoutMs: 10_000, what: 'the marker' });
    await settleWatcher();
    const paths = rec.changes().map((c) => c.path);
    expect(paths.filter((p) => /(^|\/)(\.git|node_modules|\.smurg)(\/|$)|\.tmp/.test(p))).toEqual([]);
    expect(paths.filter((p) => p.includes('.!30367!') || p.endsWith('sedAb12Cd'))).toEqual([]);
  });

  it('follows roots as they come and go: a worktree gets its own subscription, and sees changes of its shared read-only directory', async () => {
    const { ft: f, rec } = await setup();
    const id = 'wt_watch_test';
    const dir = join(f.t.root, '.smurg/worktrees', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'inside.txt'), 'x');
    await symlink(join(f.t.root, 'data'), join(dir, 'data'));
    await f.t.ctx.roots.registerWorktree({ worktreeId: id, dir, ownerUserId: 'dev:amy', sharedLinks: [{ path: 'data', mainPath: 'data' }] });
    const key = `wt:${id}`;
    await waitFor(() => f.instance().watcher?.watchedRoots().includes(key) === true, { timeoutMs: 5_000, what: 'the worktree subscription' });
    await new Promise((resolve) => setTimeout(resolve, 300)); // FSEvents stream start-up
    await writeFile(join(dir, 'made-in-worktree.txt'), 'x');
    await waitFor(() => rec.changes(key).some((c) => c.path === 'made-in-worktree.txt'), { timeoutMs: 10_000, what: 'the worktree change' });
    // Nothing of the worktree leaks into the main root's events (the main subscription ignores .smurg).
    expect(rec.changes('main').some((c) => c.path.includes('made-in-worktree'))).toBe(false);
    await writeFile(join(f.t.root, 'data/new.csv'), '1,2\n');
    await waitFor(() => rec.changes(key).some((c) => c.path === 'data/new.csv'), { timeoutMs: 10_000, what: 'the shared-dir change mirrored into the worktree' });
    expect(rec.changes('main').some((c) => c.path === 'data/new.csv')).toBe(true);
    await f.t.ctx.roots.unregisterWorktree(id);
    await waitFor(() => f.instance().watcher?.watchedRoots().includes(key) === false, { timeoutMs: 5_000, what: 'the subscription to end' });
    const before = rec.changes(key).length;
    await writeFile(join(dir, 'after-removal.txt'), 'x');
    await writeFile(join(f.t.root, 'marker-2.txt'), 'x');
    await waitFor(() => rec.changes('main').some((c) => c.path === 'marker-2.txt'), { timeoutMs: 10_000, what: 'the marker' });
    await settleWatcher();
    expect(rec.changes(key).length).toBe(before);
    await rm(dir, { recursive: true, force: true });
  });

  it('the shared folder moved away and back (Finder rename + undo) is watched again', async () => {
    const log = createMemoryLogger();
    ft = await startFilesDaemon({ project: { files: { 'README.md': '# hi\n' } }, files: { watcher: { rootCheckMs: 100 } }, log });
    const f = ft;
    const vera = await f.t.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
    const wire: Changed[] = [];
    vera.conn.on('file.changed', (payload) => wire.push(payload));
    const paths = (): string[] => wire.flatMap((m) => m.changes.map((c) => c.path));
    await writeFile(join(f.t.root, 'warmup.txt'), 'w');
    await waitFor(() => paths().includes('warmup.txt'), { timeoutMs: 10_000, what: 'a first event' });
    const away = `${f.t.root}-away`;
    await rename(f.t.root, away);
    await waitFor(() => f.instance().watcher?.watchedRoots().includes('main') === false, { timeoutMs: 5_000, what: 'the dead subscription to be dropped' });
    await rename(away, f.t.root);
    await rewatched(f, log, 'the root to be watched again');
    await new Promise((resolve) => setTimeout(resolve, 300)); // FSEvents stream start-up
    await writeFile(join(f.t.root, 'new-after-return.md'), 'x');
    await waitFor(() => paths().includes('new-after-return.md'), { timeoutMs: 10_000, what: 'file.changed after the root came back' });
  });

  it('another directory put at the shared folder\'s path is not watched (it is not the shared folder)', async () => {
    const log = createMemoryLogger();
    ft = await startFilesDaemon({ project: { files: { 'README.md': '# hi\n' } }, files: { watcher: { rootCheckMs: 100 } }, log });
    const f = ft;
    const away = `${f.t.root}-away`;
    await rename(f.t.root, away);
    await waitFor(() => f.instance().watcher?.watchedRoots().includes('main') === false, { timeoutMs: 5_000, what: 'the dead subscription to be dropped' });
    await mkdir(f.t.root);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(f.instance().watcher?.watchedRoots().includes('main')).toBe(false);
    await rm(f.t.root, { recursive: true });
    await rename(away, f.t.root);
    await rewatched(f, log, 'the real root to be watched again');
  });
});
