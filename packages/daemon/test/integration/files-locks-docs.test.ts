// SPEC R7 / R8 (D14) with the REAL files, locks, docs and hooks modules composed as in production: while a file has
// any lock (a person typing in the editor, or an agent between PreToolUse and PostToolUse), file.write, rename,
// delete and an upload's begin and COMMIT are refused with `locked`, under every spelling that reaches the file; once
// it is free they go through, and what they write reaches the open editors through the watcher.
import { createHash } from 'node:crypto';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, isSmurgError, type FileRef } from '@smurg/protocol';
import { uploadRootHash } from '@smurg/protocol/client';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, destroyDocClients } from '../docs/helpers.ts';
import { bytesSource, upload } from '../files/helpers.ts';
import { denyReason, hookInput, runHook } from './support.ts';

const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const APP = main('src/app.ts');
const OTHER = main('src/other.ts');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

let t: TestDaemon | null = null;

afterEach(async () => {
  destroyDocClients();
  await t?.cleanup();
  t = null;
});

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return isSmurgError(err) ? err.code : 'not-a-smurg-error';
  }
}

describe('files + locks + docs (real modules)', { timeout: 120_000 }, () => {
  it('file.write and an upload commit are refused on a locked file (human or agent lock, any spelling); both go through once it is free', async () => {
    t = await createTestDaemon({
      project: { files: { 'src/app.ts': 'export const a = 1;\n', 'src/other.ts': 'export const b = 1;\n' } },
      // The upload's disk check against this machine's real disk: no reserve, so only the lock can refuse it.
      settings: { diskReserveBytes: 0, diskReservePercent: 0 },
    });
    const d = t;
    // Another spelling of src/: a link inside the share (PathGuard lets in-share links resolve).
    await symlink('src', join(d.root, 'alias'));
    const host = await d.connectHost();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const bob = await d.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const xfer = await bob.transfer();
    const absApp = join(d.root, 'src', 'app.ts');

    // Bob's upload of a new src/app.ts: every chunk is on the host before anyone locks the file, not committed yet.
    const uploaded = encode('export const a = "uploaded by Bob";\n'.repeat(4));
    const CHUNK = 1024 * 1024; // the smallest chunk size the protocol accepts: one chunk
    const run = await upload(xfer, { path: 'src/app.ts', size: uploaded.byteLength, chunkSize: CHUNK, source: bytesSource(uploaded), onConflict: 'overwrite', stopAfter: Number.MAX_SAFE_INTEGER });
    expect(run.entry).toBeNull();
    expect(run.sent.length).toBe(run.begin.chunkCount);
    const chunkHashes = Array.from({ length: run.begin.chunkCount }, (_, i) => createHash('sha256').update(uploaded.subarray(i * CHUNK, (i + 1) * CHUNK)).digest());
    const commit = () => xfer.request('file.upload.commit', { uploadId: run.begin.uploadId, rootHash: uploadRootHash(uploaded.byteLength, CHUNK, chunkHashes) });

    // 1. Amy types in the editor: the human lock.
    const amyDoc = await DocClient.open(amy.conn, APP);
    const hostDoc = await DocClient.open(host.conn, APP);
    await waitFor(() => amyDoc.synced && hostDoc.synced, { what: 'the editors' });
    amyDoc.text.insert(0, '// amy\n');
    await waitFor(() => d.ctx.services.locks.get(APP)?.kind === 'human', { what: 'Amy\'s lock' });
    await waitFor(async () => (await readFile(absApp, 'utf8')).startsWith('// amy\n'), { what: 'the autosave' });

    const write = (path: string, text: string) => bob.conn.request('file.write', { file: main(path), content: encode(text) });
    const refusedWrite = await write('src/app.ts', 'overwritten by Bob\n').catch((e: unknown) => e);
    expect(isSmurgError(refusedWrite) && refusedWrite.code).toBe('locked');
    expect((refusedWrite as Error).message).toContain('Amy');
    // The same file through another spelling: the in-share link (first use of that spelling) and another case.
    expect(await codeOf(write('alias/app.ts', 'through the link\n'))).toBe('locked');
    if (process.platform === 'darwin') expect(await codeOf(write('SRC/App.ts', 'other case\n'))).toBe('locked');
    expect(await codeOf(bob.conn.request('file.rename', { root: MAIN_ROOT, from: 'src/app.ts', to: 'src/moved.ts' }))).toBe('locked');
    expect(await codeOf(bob.conn.request('file.delete', { file: APP }))).toBe('locked');
    expect(await codeOf(bob.conn.request('file.rename', { root: MAIN_ROOT, from: 'src', to: 'source' }))).toBe('locked');
    // The upload: its commit is refused while the lock is held (the chunks stay, nothing replaces the file)…
    expect(await codeOf(commit())).toBe('locked');
    // …and so is a new upload of the same file.
    expect(await codeOf(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'src/app.ts', size: 3, chunkSize: CHUNK, lastModified: 1, onConflict: 'overwrite' }))).toBe('locked');
    expect(await readFile(absApp, 'utf8')).toBe('// amy\nexport const a = 1;\n');

    // 2. An agent's lock on another file (the real hook entry against the real hook socket).
    const agent = d.ctx.services.hooks.registerSession({ sessionId: 'ses_integration_files', ownerUserId: 'dev:ian', agentName: 'Claude（Ian）', root: MAIN_ROOT, sandboxed: true });
    const absOther = join(d.root, 'src', 'other.ts');
    expect(denyReason(await runHook(agent.env, hookInput('PreToolUse', absOther, d.root), d.root))).toBeNull();
    const agentRefusal = await write('src/other.ts', 'Bob was here\n').catch((e: unknown) => e);
    expect(isSmurgError(agentRefusal) && agentRefusal.code).toBe('locked');
    expect((agentRefusal as Error).message).toContain('Claude（Ian）');
    expect(await codeOf(write('alias/other.ts', 'Bob was here\n'))).toBe('locked');
    await runHook(agent.env, hookInput('PostToolUse', absOther, d.root), d.root);
    await waitFor(() => d.ctx.services.locks.get(OTHER) === null, { what: 'the agent lock released' });
    // Free again: the write goes through (and an editor that opens it sees it).
    await write('src/other.ts', 'export const b = 2;\n');
    const otherDoc = await DocClient.open(amy.conn, OTHER);
    await waitFor(() => otherDoc.synced && otherDoc.text.toString() === 'export const b = 2;\n', { what: 'the written file in the editor' });

    // 3. Amy closes the file: her lock ends, and Bob's upload can be committed now; the editor still open on the file
    // (the host's) gets the new content from the watcher.
    amyDoc.close();
    await waitFor(() => d.ctx.services.locks.get(APP) === null, { timeoutMs: 15_000, what: 'Amy\'s lock to end on close' });
    const committed = await commit();
    expect(committed.entry).toMatchObject({ path: 'src/app.ts', size: uploaded.byteLength });
    expect(await readFile(absApp)).toEqual(Buffer.from(uploaded));
    await waitFor(() => hostDoc.text.toString() === new TextDecoder().decode(uploaded), { timeoutMs: 15_000, what: 'the upload in the open editor' });
    d.ctx.services.hooks.unregisterSession('ses_integration_files');
  });
});
