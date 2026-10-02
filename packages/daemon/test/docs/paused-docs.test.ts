// An open document whose file stops being writable (review findings REL-01): moved away or deleted on disk by
// an agent's Bash (`mv`, `git mv`, `rm`: the human lock cannot stop Bash, R8's fallback), or unreadable for a while
// (chmod). Nothing a human typed may disappear silently: text that is not on disk is kept as a recoverable version in
// the conflict panel, the editors are told (doc.rejected) and later keystrokes are refused, never swallowed; a file
// that is only briefly gone (git checkout) resumes without any of that; a permission problem is retried until the
// text is written.
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type ConflictRecord } from '@smurg/protocol';
import { createDocsModule } from '../../src/docs/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, destroyDocClients, sleep } from './helpers.ts';

let t: TestDaemon | null = null;
const restore: (() => Promise<void>)[] = [];

afterEach(async () => {
  try {
    for (const fn of restore.splice(0)) await fn().catch(() => {});
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
  }
});

const NOTES = { root: MAIN_ROOT, path: 'notes.md' };

describe('a document whose file cannot be saved any more', { timeout: 30_000 }, () => {
  it('moved away by Bash within the autosave debounce: the unsaved text is kept in the conflict panel, the editor is told, later typing is refused', async () => {
    t = await createTestDaemon({ project: { files: { 'notes.md': 'line one\nline two\n' } }, modules: [createDocsModule({ pauseConfirmMs: 300 })] });
    const amyClient = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const conflicts: ConflictRecord[] = [];
    amyClient.conn.on('doc.conflict', (p) => conflicts.push(p.conflict));
    const doc = await DocClient.open(amyClient.conn, NOTES);
    await waitFor(() => doc.synced, { what: 'sync' });

    doc.text.insert(doc.text.length, 'saved by amy\n');
    await waitFor(() => doc.saved.length >= 1, { what: 'first autosave' });

    // Typed, and before the 300 ms debounce ends an agent runs `mv notes.md renamed.md`.
    doc.text.insert(doc.text.length, 'UNSAVED-BEFORE-MV\n');
    await rename(join(t.root, 'notes.md'), join(t.root, 'renamed.md'));
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes.md', change: 'unlink' }, { path: 'renamed.md', change: 'add' }] });

    // The editor is told that its text can no longer be saved here.
    await waitFor(() => doc.rejected.length >= 1, { what: 'doc.rejected after the file went away' });
    expect(doc.rejected[0]).toMatchObject({ docId: doc.docId, reason: 'file-unavailable' });
    // The unsaved text is a recoverable version, announced to the editor.
    await waitFor(() => conflicts.length === 1, { what: 'recovery record announced' });
    const record = conflicts[0] as ConflictRecord;
    expect(record).toMatchObject({ file: NOTES, status: 'open', humans: [{ userId: 'dev:amy', displayName: 'Amy' }] });
    expect(record.hunks[0]?.humanText).toContain('UNSAVED-BEFORE-MV');
    const got = await amyClient.conn.request('doc.conflict.get', { conflictId: record.id });
    expect(new TextDecoder().decode(got.agentVersion)).toBe('line one\nline two\nsaved by amy\nUNSAVED-BEFORE-MV\n');

    // Typing after that is refused (and reverted), never accepted into a document that cannot be saved.
    const rejectedBefore = doc.rejected.length;
    doc.text.insert(doc.text.length, 'TYPED-AFTER-MV\n');
    await waitFor(() => doc.rejected.length > rejectedBefore, { what: 'later keystroke refused' });
    await waitFor(() => !doc.text.toString().includes('TYPED-AFTER-MV'), { what: 'refused keystroke reverted in the replica' });
    await sleep(400);
    expect(conflicts).toHaveLength(1); // nothing new to keep
    expect(await readFile(join(t.root, 'renamed.md'), 'utf8')).toBe('line one\nline two\nsaved by amy\n');

    // The recovery record restores the text at the old path (a plain write: the file is gone).
    await amyClient.conn.request('doc.conflict.resolve', { conflictId: record.id, action: 'apply-agent-version' });
    expect(await readFile(join(t.root, 'notes.md'), 'utf8')).toBe('line one\nline two\nsaved by amy\nUNSAVED-BEFORE-MV\n');
  });

  it('deleted while nobody has it open any more: the unsaved text is kept before the room is dropped', async () => {
    t = await createTestDaemon({ project: { files: { 'notes.md': 'alpha\n' } }, modules: [createDocsModule({ pauseConfirmMs: 60_000, graceMs: 200, debounceMs: 5_000, maxWaitMs: 10_000 })] });
    const amyClient = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const doc = await DocClient.open(amyClient.conn, NOTES);
    await waitFor(() => doc.synced, { what: 'sync' });
    doc.text.insert(doc.text.length, 'NOT-YET-SAVED\n');
    await sleep(200); // the update reaches the daemon (autosave is 5 s away)
    await rm(join(t.root, 'notes.md'));
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes.md', change: 'unlink' }] });
    await sleep(100);
    doc.close(); // the close tries to save: the file is gone
    await waitFor(() => t?.ctx.services.docs.isOpen(NOTES) === false, { what: 'room dropped after its grace period' });
    const host = await t.connectHost();
    const listed = (await host.conn.request('doc.conflict.list', {})).conflicts;
    expect(listed).toHaveLength(1);
    const got = await host.conn.request('doc.conflict.get', { conflictId: (listed[0] as ConflictRecord).id });
    expect(new TextDecoder().decode(got.agentVersion)).toBe('alpha\nNOT-YET-SAVED\n');
  });

  it('briefly gone (git checkout deletes and re-creates it): no rejection, no recovery record, the edit is saved', async () => {
    t = await createTestDaemon({ project: { files: { 'notes.md': 'one\ntwo\n' } }, modules: [createDocsModule({ pauseConfirmMs: 2_000 })] });
    const amyClient = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const conflicts: ConflictRecord[] = [];
    amyClient.conn.on('doc.conflict', (p) => conflicts.push(p.conflict));
    const doc = await DocClient.open(amyClient.conn, NOTES);
    await waitFor(() => doc.synced, { what: 'sync' });
    const path = join(t.root, 'notes.md');
    await rm(path);
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes.md', change: 'unlink' }] });
    doc.text.insert(0, 'edited ');
    await sleep(400); // the save found no file: paused
    await writeFile(path, 'one\ntwo\n');
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'notes.md', change: 'add' }] });
    await waitFor(async () => (await readFile(path, 'utf8')) === 'edited one\ntwo\n', { what: 'edit saved after the file came back' });
    await sleep(2_200); // past the confirmation delay
    expect(doc.rejected).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('unreadable for a while (chmod 000): the text typed meanwhile is written once it can be, without another keystroke', async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    // All modules (the file watcher reports the chmod too, and every report re-checks the file).
    t = await createTestDaemon({ project: { files: { 'notes.md': 'alpha\n' } } });
    const amyClient = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const doc = await DocClient.open(amyClient.conn, NOTES);
    await waitFor(() => doc.synced, { what: 'sync' });
    const path = join(t.root, 'notes.md');
    await chmod(path, 0o000);
    restore.push(() => chmod(path, 0o644));
    doc.text.insert(doc.text.length, 'beta\n');
    await sleep(1_500);
    expect(doc.saved).toEqual([]);
    await chmod(path, 0o644);
    // Within a few seconds (retries back off, but not beyond 2 s), and without another keystroke.
    await waitFor(async () => (await readFile(path, 'utf8')) === 'alpha\nbeta\n', { what: 'saved after the permission came back', timeoutMs: 3_500 });
    await waitFor(() => doc.saved.length >= 1, { what: 'doc.saved' });
  });
});
