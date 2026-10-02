// What the docs module refuses, end to end: content from members without file.write, malformed awareness, a symlink
// swapped in after the document was opened (the daemon is not sandboxed; yjs-monaco.md V2), host-only paths.
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, isSmurgError, type AuditEntry } from '@smurg/protocol';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { hiddenForGuests } from '../../src/docs/conflict-panel.ts';
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

function awarenessBytes(entries: readonly { clientId: number; clock: number; state: unknown }[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}

describe('doc.* refusals', { timeout: 30_000 }, () => {
  it('drops (and audits) content from a viewer: nobody else sees it and the disk is unchanged', async () => {
    t = await createTestDaemon({ project: { files: { 'a.txt': 'original\n' } }, modules: [fakeLocksModule(new FakeLockManager()), createDocsModule()] });
    const audit: AuditEntry[] = [];
    t.ctx.audit.subscribe((e) => audit.push(e));
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const veraConn = await t.connect({ userId: 'dev:vera', role: 'viewer' });
    const errors: string[] = [];
    veraConn.conn.on('error', (p) => errors.push(p.code));
    const file = { root: MAIN_ROOT, path: 'a.txt' };
    const amy = await DocClient.open(amyConn.conn, file);
    const vera = await DocClient.open(veraConn.conn, file);
    await waitFor(() => amy.synced && vera.synced, { what: 'sync' });
    expect(vera.opened.canEdit).toBe(false);
    expect(amy.opened.canEdit).toBe(true);
    // A viewer's normal step-2 answer (nothing new) is not an edit: no refusal so far.
    expect(audit.filter((e) => e.action === 'authz.denied')).toHaveLength(0);

    vera.text.insert(0, 'FORGED BY A VIEWER ');
    await waitFor(() => vera.rejected.length === 1, { what: 'doc.rejected to the viewer' });
    expect(vera.rejected[0]).toMatchObject({ docId: vera.docId, reason: 'forbidden' });
    await waitFor(() => errors.includes('forbidden'), { what: 'the one-way message answered with error' });
    expect(audit.filter((e) => e.action === 'authz.denied')).toMatchObject([
      { actor: { kind: 'user', userId: 'dev:vera' }, outcome: 'denied', target: 'main:a.txt', detail: { type: 'doc.sync', reason: 'doc-content-needs-file.write', refusal: 'forbidden' } },
    ]);
    await sleep(500);
    expect(amy.text.toString()).toBe('original\n');
    expect(await readFile(join(t.root, 'a.txt'), 'utf8')).toBe('original\n');
    // Editing still works for Amy (the room was not disturbed).
    amy.text.insert(0, 'ok ');
    await waitFor(async () => (await readFile(join(t!.root, 'a.txt'), 'utf8')) === 'ok original\n', { what: 'autosave' });
  });

  it('refuses doc.sync / doc.awareness for a document the channel did not open', async () => {
    t = await createTestDaemon({ project: { files: { 'a.txt': 'x' } }, modules: [createDocsModule()] });
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const mallory = await t.connect({ userId: 'dev:mallory', role: 'editor' });
    const opened = await amy.conn.request('doc.open', { file: { root: MAIN_ROOT, path: 'a.txt' } });
    const errors: string[] = [];
    mallory.conn.on('error', (p) => errors.push(`${p.code}:${String(p.detail?.['reason'])}`));
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'injected');
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
    mallory.conn.notify('doc.sync', { docId: opened.docId, data: encoding.toUint8Array(encoder) });
    mallory.conn.notify('doc.awareness', { docId: opened.docId, data: awarenessBytes([{ clientId: 5, clock: 1, state: {} }]) });
    await waitFor(() => errors.length === 2, { what: 'two refusals' });
    expect(errors).toEqual(['not_found:doc-not-open', 'not_found:doc-not-open']);
  });

  it('malformed awareness never reaches peers; names are the daemon’s, client ids cannot be spoofed', async () => {
    t = await createTestDaemon({ project: { files: { 'a.txt': 'hello world\n' } }, modules: [createDocsModule()] });
    const amyConn = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const malConn = await t.connect({ userId: 'dev:mallory', displayName: 'Mallory', role: 'viewer' });
    const file = { root: MAIN_ROOT, path: 'a.txt' };
    const amy = await DocClient.open(amyConn.conn, file);
    const mallory = await DocClient.open(malConn.conn, file, { awareness: false });
    await waitFor(() => amy.synced && mallory.synced, { what: 'sync' });
    amy.setCursor(3);
    await waitFor(() => mallory.remoteStates().has(amy.doc.clientID), { what: "Amy's presence at Mallory" });

    // Everything Amy's editor receives must be renderable: y-monaco resolves every selection without try/catch.
    const received: Uint8Array[] = [];
    amyConn.conn.on('doc.awareness', (p) => received.push(p.data));
    const bad = [{ item: { client: 1, clock: -5 } }, { item: {} }, { item: null, tname: null }, { item: { client: 1, clock: 'x' } }, { tname: 'other' }];
    let clock = 1;
    for (const position of bad) {
      malConn.conn.notify('doc.awareness', { docId: mallory.docId, data: awarenessBytes([{ clientId: 424242, clock: clock++, state: { selection: { anchor: position, head: position } } }]) });
    }
    // Spoofing Amy's client id, and claiming to be the host.
    malConn.conn.notify('doc.awareness', { docId: mallory.docId, data: awarenessBytes([{ clientId: amy.doc.clientID, clock: 999, state: { user: { name: 'Host' }, selection: null } }]) });
    const valid = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(mallory.text, 6));
    malConn.conn.notify('doc.awareness', {
      docId: mallory.docId,
      data: awarenessBytes([{ clientId: 424242, clock: clock++, state: { user: { name: 'Host', color: '#000000', kind: 'agent' }, selection: { anchor: valid, head: valid } } }]),
    });
    await waitFor(() => amy.remoteStates().has(424242), { what: "Mallory's valid state" });
    await sleep(100);
    // Only the valid entry arrived, with Mallory's real identity.
    const state = amy.remoteStates().get(424242) as { user: { name: string; kind: string; userId: string }; selection: { anchor: Record<string, unknown> } };
    expect(state.user).toMatchObject({ name: 'Mallory', kind: 'human', userId: 'dev:mallory' });
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.selection.anchor), amy.doc);
    expect(position?.index).toBe(6);
    // Amy's own state was not overwritten by the spoof.
    expect(amy.awareness.getStates().get(amy.doc.clientID)?.['user']).toBeUndefined();
    for (const data of received) {
      const decoderStates = new Map<number, unknown>();
      const peer = new Y.Doc();
      const { Awareness, applyAwarenessUpdate } = await import('y-protocols/awareness');
      const aw = new Awareness(peer);
      applyAwarenessUpdate(aw, data, 'test');
      for (const [id, st] of aw.getStates()) if (id !== peer.clientID) decoderStates.set(id, st);
      aw.destroy();
      for (const st of decoderStates.values()) {
        const selection = (st as { selection?: { anchor: Record<string, unknown>; head: Record<string, unknown> } | null }).selection;
        if (!selection) continue;
        expect(() => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.anchor), amy.doc)).not.toThrow();
      }
    }
  });

  it('a symlink swapped in after open does not make the daemon read or write outside the share', async () => {
    t = await createTestDaemon({ project: { files: { 'k/notes.txt': 'harmless notes\n', 'j/todo.txt': 'todo\n' } }, modules: [fakeLocksModule(new FakeLockManager()), createDocsModule()] });
    const audit: AuditEntry[] = [];
    t.ctx.audit.subscribe((e) => audit.push(e));
    // A fake "home" outside the shared folder, with a fake secret (never a real file).
    const outside = join(dirname(t.root), 'outside-home');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'notes.txt'), 'FAKE-PRIVATE-KEY-FOR-TEST\n');
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const notes = await DocClient.open(amyConn.conn, { root: MAIN_ROOT, path: 'k/notes.txt' });
    const todo = await DocClient.open(amyConn.conn, { root: MAIN_ROOT, path: 'j/todo.txt' });
    await waitFor(() => notes.synced && todo.synced, { what: 'sync' });

    // READ: an agent session's shell swaps `k` for a link to the outside; the watcher reports it.
    await rm(join(t.root, 'k'), { recursive: true });
    await symlink(outside, join(t.root, 'k'));
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'k', change: 'unlinkDir' }, { path: 'k', change: 'add' }] });
    await waitFor(() => audit.some((e) => e.action === 'path.denied' && e.target === 'main:k/notes.txt'), { what: 'path.denied audited' });
    await sleep(200);
    expect(notes.text.toString()).toBe('harmless notes\n');
    // WRITE: the next autosave must not create or overwrite anything outside.
    notes.text.insert(0, 'echo pwned # ');
    await rm(join(t.root, 'j'), { recursive: true });
    await symlink(outside, join(t.root, 'j'));
    todo.text.insert(0, 'echo pwned # ');
    await sleep(1_000);
    expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('FAKE-PRIVATE-KEY-FOR-TEST\n');
    expect((await readdir(outside)).sort()).toEqual(['notes.txt']);
    const denied = audit.filter((e) => e.action === 'path.denied');
    expect(denied.map((e) => e.target).sort()).toEqual(['main:j/todo.txt', 'main:k/notes.txt']);
    expect(denied.every((e) => e.actor.kind === 'system' && e.outcome === 'denied')).toBe(true);
    // Opening the swapped path now is refused outright.
    const refused = await amyConn.conn.request('doc.open', { file: { root: MAIN_ROOT, path: 'k/notes.txt' } }).catch((e: unknown) => e);
    expect(isSmurgError(refused) && refused.code).toBe('path_denied');
  });

  it('a guest may read but not edit a host-only file; the host may edit it', async () => {
    t = await createTestDaemon({ project: { files: { '.claude/settings.json': '{}\n' } }, modules: [createDocsModule()] });
    const file = { root: MAIN_ROOT, path: '.claude/settings.json' };
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const hostConn = await t.connectHost();
    const amy = await DocClient.open(amyConn.conn, file);
    const host = await DocClient.open(hostConn.conn, file);
    await waitFor(() => amy.synced && host.synced, { what: 'sync' });
    expect(amy.opened.canEdit).toBe(false);
    expect(host.opened.canEdit).toBe(true);
    amy.text.insert(0, '{"disableAllHooks": true}');
    await waitFor(() => amy.rejected.length === 1, { what: 'doc.rejected' });
    expect(amy.rejected[0]?.reason).toBe('read-only');
    expect(host.text.toString()).toBe('{}\n');
    host.text.insert(0, ' ');
    await waitFor(async () => (await readFile(join(t!.root, '.claude/settings.json'), 'utf8')) === ' {}\n', { what: "host's autosave" });
  });
});

describe('conflict records of files non-hosts may not read', () => {
  it('are hidden from non-hosts like .smurg: .git, .envrc and the host\'s personal Claude Code files, at any depth and spelling', () => {
    const worktree = { kind: 'worktree' as const, worktreeId: 'wt_1' };
    for (const path of ['.git/config', 'sub/.git/HEAD', '.envrc', 'app/.ENVRC', 'CLAUDE.local.md', 'x/.claude/settings.local.json', '.smurg/notes.md']) {
      expect(hiddenForGuests({ root: MAIN_ROOT, path }), path).toBe(true);
    }
    expect(hiddenForGuests({ root: worktree, path: '.envrc' })).toBe(true);
    for (const path of ['README.md', '.claude/settings.json', 'src/git.ts', 'envrc.md']) expect(hiddenForGuests({ root: MAIN_ROOT, path }), path).toBe(false);
  });
});
