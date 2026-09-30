// Subscriptions and rooms over time (ARCHITECTURE §4 Resume, §7.3 channel.discarded, §7.5 grace period): a document
// subscription belongs to the logical channel and survives a resume; a discarded channel drops it; a room outlives
// its last subscriber for a grace period (same epoch: offline edits merge) and is re-created after it (new epoch);
// closing leaves the human lock; stopping the daemon writes unsaved text.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT } from '@smurg/protocol';
import { createDocsModule } from '../../src/docs/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, FakeLockManager, destroyDocClients, fakeLocksModule, sleep } from './helpers.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  try {
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
  }
});

const FILE = { root: MAIN_ROOT, path: 'doc.md' };
const FAST_RECONNECT = { reconnectBaseMs: 20, reconnectMaxMs: 60 };

describe('document lifecycle', { timeout: 30_000 }, () => {
  it('a subscription survives a resume: edits made while disconnected, and changes made meanwhile, both arrive', async () => {
    t = await createTestDaemon({ project: { files: { 'doc.md': 'line 1\nline 2\nline 3\n' } }, timing: FAST_RECONNECT, modules: [fakeLocksModule(new FakeLockManager()), createDocsModule()] });
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const bobConn = await t.connect({ userId: 'dev:bob', role: 'editor' });
    const welcomes: boolean[] = [];
    amyConn.conn.onWelcome((_w, info) => welcomes.push(info.resumed));
    const amy = await DocClient.open(amyConn.conn, FILE);
    const bob = await DocClient.open(bobConn.conn, FILE);
    await waitFor(() => amy.synced && bob.synced, { what: 'sync' });

    t.relay.dropHost('ws');
    await waitFor(() => t!.ctx.hub.connections({ userId: 'dev:amy' }).length === 0, { what: 'disconnected' });
    amy.text.insert(0, 'offline edit\n'); // queued in the client SDK's outbox
    await writeFile(join(t.root, 'doc.md'), 'line 1\nline 2\nline 3 (changed on disk)\n');
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'doc.md', change: 'change' }] });
    await waitFor(() => welcomes.length === 1 && amyConn.conn.getState().kind === 'online', { what: 'resumed' });
    expect(welcomes).toEqual([true]);
    const expected = 'offline edit\nline 1\nline 2\nline 3 (changed on disk)\n';
    await waitFor(() => amy.text.toString() === expected && bob.text.toString() === expected, { what: 'convergence without re-opening' });
    await waitFor(async () => (await readFile(join(t!.root, 'doc.md'), 'utf8')) === expected, { what: 'saved' });
  });

  it('a discarded channel loses its subscription; a re-open on the new channel merges the replica into the same room', async () => {
    t = await createTestDaemon({ project: { files: { 'doc.md': 'base\n' } }, modules: [createDocsModule()] });
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const bobConn = await t.connect({ userId: 'dev:bob', role: 'editor' });
    const amy = await DocClient.open(amyConn.conn, FILE);
    const bob = await DocClient.open(bobConn.conn, FILE);
    await waitFor(() => amy.synced && bob.synced, { what: 'sync' });
    const docs = t.ctx.services.docs;
    expect(docs.isOpen(FILE)).toBe(true);

    // A fresh (non-resumed) connection of Amy's device: the old logical channel is discarded.
    amyConn.close();
    const again = await amyConn.reconnect();
    // Bob's edit reaches the room while Amy is not subscribed; she must not receive it on the dead channel.
    bob.text.insert(bob.text.length, 'bob\n');
    const reopened = await again.conn.request('doc.open', { file: FILE });
    expect(reopened.docId).toBe(amy.docId);
    expect(reopened.epoch).toBe(amy.opened.epoch); // her replica can merge (no duplication)
    const amy2 = await DocClient.open(again.conn, FILE);
    await waitFor(() => amy2.text.toString() === 'base\nbob\n', { what: 'resync on the new channel' });
  });

  it('keeps a room for the grace period after its last subscriber (same epoch), then re-creates it (new epoch)', async () => {
    t = await createTestDaemon({ project: { files: { 'doc.md': 'x\n' } }, modules: [createDocsModule({ graceMs: 800 })] });
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const first = await amyConn.conn.request('doc.open', { file: FILE });
    amyConn.conn.notify('doc.close', { docId: first.docId });
    await sleep(100);
    const within = await amyConn.conn.request('doc.open', { file: FILE });
    expect(within).toMatchObject({ docId: first.docId, epoch: first.epoch });
    amyConn.conn.notify('doc.close', { docId: within.docId });
    await waitFor(() => !t!.ctx.services.docs.isOpen(FILE), { timeoutMs: 5_000, what: 'room gone after the grace period' });
    const after = await amyConn.conn.request('doc.open', { file: FILE });
    expect(after.epoch).not.toBe(first.epoch);
  });

  it('closing the document saves the member’s text and leaves the human lock (lockBase dropped with it)', async () => {
    const locks = new FakeLockManager();
    t = await createTestDaemon({ project: { files: { 'doc.md': 'x\n' } }, modules: [fakeLocksModule(locks), createDocsModule({ debounceMs: 60_000, maxWaitMs: 60_000 })] });
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const amy = await DocClient.open(amyConn.conn, FILE);
    await waitFor(() => amy.synced, { what: 'sync' });
    amy.text.insert(0, 'typed ');
    await waitFor(() => locks.get(FILE)?.kind === 'human', { what: 'human lock' });
    expect(t.ctx.services.docs.lockBase(FILE)).toBe('x\n');
    amy.close();
    await waitFor(() => locks.get(FILE) === null, { what: 'lock left' });
    expect(await readFile(join(t.root, 'doc.md'), 'utf8')).toBe('typed x\n'); // saved before the lock was left
    expect(t.ctx.services.docs.lockBase(FILE)).toBeNull();
  });

  it('stopping the daemon writes unsaved text', async () => {
    t = await createTestDaemon({ project: { files: { 'doc.md': 'x\n' } }, modules: [createDocsModule({ debounceMs: 60_000, maxWaitMs: 60_000 })] });
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const amy = await DocClient.open(amyConn.conn, FILE);
    await waitFor(() => amy.synced, { what: 'sync' });
    amy.text.insert(0, 'unsaved ');
    await waitFor(() => t!.ctx.services.docs.lockBase(FILE) !== null, { what: 'edit applied in the daemon' });
    await t.daemon.stop();
    expect(await readFile(join(t.root, 'doc.md'), 'utf8')).toBe('unsaved x\n');
  });
});
