// A start has two phases (ARCHITECTURE §7.1, core/workspace-folder.ts): phase 1 reads and checks the whole workspace
// folder and writes NOTHING; phase 2 writes, in a fixed order, only when phase 1 accepted everything. Tested here on
// the folder itself, with small hand-made files; test/two-phase-start.test.ts does the same through createDaemon.
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadOrCreateDaemonIdentity } from '@smurg/protocol/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defaultHostSettings } from '../src/core/config.ts';
import { ManualClock } from '../src/core/lifecycle.ts';
import { createMemoryLogger, silentLogger } from '../src/core/logger.ts';
import { STAMP_FILE, declareDocument, keptCopyPath, serializeDocument, writeStamp, type DocumentDeclaration } from '../src/core/state-store.ts';
import { readWorkspaceFolder, writeWorkspaceFolder, type FolderReadOptions, type FolderReading } from '../src/core/workspace-folder.ts';
import { stateDocument, workspaceStateSchema, type WorkspaceState } from '../src/core/workspace-state.ts';
import { suggestionsDocument, suggestionsDocumentSchema } from '../src/suggest/store.ts';
import { createTempDir, removeTempDir } from '../src/testing/temp.ts';
import { GiB, WS, rejectionOf, snapshotOf, stateOfV040, suggestionsOfV040 } from './fixtures/hand-made.ts';

const SMURG = '0.5.1';
const bareSchema = z.strictObject({ live: z.array(z.string()) });
/** A document without a `version` key, like sessions.json. */
const bareDocument = declareDocument({ name: 'bare', schema: bareSchema, init: () => ({ live: [] as string[] }) });
const core = stateDocument(WS, defaultHostSettings(16 * GiB));
const DOCUMENTS: readonly DocumentDeclaration[] = [core, suggestionsDocument, bareDocument];

let base: string;
let dir: string;
const clock = new ManualClock(1_727_000_000_000);

beforeEach(async () => {
  base = await createTempDir('folder');
  dir = join(base, 'workspaces', WS);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(base);
});

const options = (more: Partial<FolderReadOptions> = {}): FolderReadOptions => ({ dir, log: silentLogger, documents: DOCUMENTS, env: { memoryBytes: 16 * GiB }, smurg: SMURG, workspaceId: WS, ...more });
const put = async (name: string, value: unknown, mode = 0o600): Promise<void> => {
  await writeFile(join(dir, name), typeof value === 'string' ? value : serializeDocument(value), { mode });
  await chmod(join(dir, name), mode);
};
/** A workspace folder as smurg 0.4.0 left it: the key, state.json and suggestions.json in its shapes, the logs, no stamp. */
async function folderOfV040(): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await loadOrCreateDaemonIdentity(dir);
  await put('state.json', stateOfV040());
  await put('suggestions.json', suggestionsOfV040());
  await put('bare.json', { live: ['ses_1'] });
  await put('audit.jsonl', '{"id":"au_1"}\n');
  await put('activity.jsonl', '');
}
/** The same folder as today's smurg writes it. */
async function folderOfToday(): Promise<void> {
  await folderOfV040();
  await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock });
  await rm(keptCopyPath(dir, 'state', '0.4.0'));
  await rm(keptCopyPath(dir, 'suggestions', '0.4.0'));
}

describe('phase 1 only reads', () => {
  it('a folder that is not there is a new workspace, and reading it creates nothing', async () => {
    const reading = await readWorkspaceFolder(options());
    expect(reading).toMatchObject({ isNew: true, stamp: null, keyPair: null, putBack: false });
    expect(reading.loaded.size).toBe(0);
    await expect(lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(base, 'workspaces'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('an empty folder, or one that only holds private sub-folders, is a new workspace too', async () => {
    await mkdir(join(dir, 'uploads'), { recursive: true, mode: 0o700 });
    const before = await snapshotOf(dir);
    expect(await readWorkspaceFolder(options())).toMatchObject({ isNew: true, keyPair: null });
    expect(await snapshotOf(dir)).toEqual(before);
  });

  it('what 0.4.0 wrote is read, upgraded in memory, and NOTHING is written: names, modes and bytes are as they were', async () => {
    await folderOfV040();
    const before = await snapshotOf(dir);
    const reading = await readWorkspaceFolder(options());
    expect(await snapshotOf(dir)).toEqual(before);
    expect(reading).toMatchObject({ isNew: false, stamp: null, putBack: false });
    expect(reading.keyPair?.publicKey).toHaveLength(32);
    expect([...reading.loaded.keys()]).toEqual(['state', 'suggestions', 'bare']);
    expect(reading.loaded.get('state')).toMatchObject({ upgradedFrom: '0.4.0' });
    expect(reading.loaded.get('suggestions')).toMatchObject({ upgradedFrom: '0.4.0' });
    expect(reading.loaded.get('bare')).toMatchObject({ upgradedFrom: null, value: { live: ['ses_1'] } });
    expect(workspaceStateSchema.safeParse(reading.loaded.get('state')?.value).success).toBe(true);
    expect((reading.loaded.get('state')?.value as WorkspaceState).members.map((member) => `${member.userId}:${member.status}`)).toEqual(['dev:host:active', 'dev:amy:active', 'dev:carl:kicked']);
    expect(reading.loaded.get('state')?.bytes.equals(await readFile(join(dir, 'state.json')))).toBe(true);
  });

  it('a stamp with a higher `shapes` refuses the WHOLE folder as `newer` before any document is read, and names the writer', async () => {
    await folderOfV040();
    await put('state.json', '{ this is not JSON'); // would be `unreadable` if it were read
    await put(STAMP_FILE, { smurg: '0.9.0', shapes: 2, at: 5 });
    const before = await snapshotOf(dir);
    const refusal = await rejectionOf(readWorkspaceFolder(options()));
    expect(refusal).toMatchObject({ kind: 'newer', path: dir, paths: [dir], writtenBy: '0.9.0' });
    expect(await snapshotOf(dir)).toEqual(before);
    // The same folder for a smurg that knows those shapes: now the damaged file is what stops it.
    expect(await rejectionOf(readWorkspaceFolder(options({ shapes: 2 })))).toMatchObject({ kind: 'unreadable', reason: 'not-json', writtenBy: '0.9.0' });
  });

  it('a file that is not JSON is never `newer`, whatever the stamp says; an unusable stamp is never a refusal of its own', async () => {
    await folderOfToday();
    await put(STAMP_FILE, { smurg: '9.9.9', shapes: 1, at: 5 });
    await put('suggestions.json', '{"version": 3, "suggestions": [');
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'unreadable', reason: 'not-json', path: join(dir, 'suggestions.json'), writtenBy: '9.9.9' });
    await put('suggestions.json', { version: 3, suggestions: [], somethingNew: true });
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'newer', path: join(dir, 'suggestions.json'), writtenBy: '9.9.9' });
    // A stamp that cannot be used (group-readable): the writer is unknown, the document still decides for itself.
    await chmod(join(dir, STAMP_FILE), 0o644);
    const log = createMemoryLogger();
    const refusal = await rejectionOf(readWorkspaceFolder(options({ log })));
    expect(refusal).toMatchObject({ kind: 'newer', path: join(dir, 'suggestions.json') });
    expect(refusal.writtenBy).toBeUndefined();
    expect(log.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    await put('suggestions.json', { version: 1, suggestions: [] });
    expect(await readWorkspaceFolder(options())).toMatchObject({ isNew: false, stamp: null });
  });

  it('a document without a `version` key that carries one is `newer` (five documents have none today)', async () => {
    await folderOfToday();
    await put('bare.json', { version: 2, live: [], more: {} });
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'newer', path: join(dir, 'bare.json') });
  });

  it('`insecure` names EVERY such path of the folder, one cause at a time (the one a chmod cannot cure first), and changes nothing', async () => {
    await folderOfToday();
    await chmod(join(dir, 'state.json'), 0o644);
    await chmod(join(dir, 'identity.key'), 0o640);
    await chmod(join(dir, 'audit.jsonl'), 0o604);
    await writeFile(join(base, 'elsewhere.json'), serializeDocument({ live: [] }), { mode: 0o600 });
    await rm(join(dir, 'bare.json'));
    await symlink(join(base, 'elsewhere.json'), join(dir, 'bare.json'));
    const before = await snapshotOf(dir);
    const link = await rejectionOf(readWorkspaceFolder(options()));
    expect(link).toMatchObject({ kind: 'insecure', cause: 'symlink', path: join(dir, 'bare.json'), paths: [join(dir, 'bare.json')] });
    expect(link.mode).toBeUndefined();
    await rm(join(dir, 'bare.json'));
    await mkdir(join(dir, 'bare.json'));
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'insecure', cause: 'not-a-file', paths: [join(dir, 'bare.json')] });
    await rm(join(dir, 'bare.json'), { recursive: true });
    const modes = await rejectionOf(readWorkspaceFolder(options()));
    expect(modes).toMatchObject({ kind: 'insecure', cause: 'mode', mode: 0o640, path: join(dir, 'identity.key') });
    expect(modes.paths).toEqual([join(dir, 'identity.key'), join(dir, 'audit.jsonl'), join(dir, 'state.json')]);
    await symlink(join(base, 'elsewhere.json'), join(dir, 'bare.json'));
    expect(await snapshotOf(dir)).toEqual(before); // never chmod-ed, never "repaired"
  });

  it('a file of another user is `insecure` with cause `owner` (no chmod cures it)', async () => {
    await folderOfToday();
    const uid = process.getuid?.() ?? 0;
    // The folder itself is ours (the first look); every file in it belongs to somebody else.
    vi.spyOn(process, 'getuid').mockReturnValueOnce(uid).mockReturnValue(uid + 1);
    let refusal;
    try {
      refusal = await rejectionOf(readWorkspaceFolder(options()));
    } finally {
      vi.restoreAllMocks();
    }
    expect(refusal).toMatchObject({ kind: 'insecure', cause: 'owner', path: join(dir, 'identity.key') });
    expect(refusal.paths).toEqual(['identity.key', 'audit.jsonl', 'activity.jsonl', 'state.json', 'suggestions.json', 'bare.json'].map((name) => join(dir, name)));
  });

  it.skipIf(process.getuid?.() === 0)('a file that is there and cannot be opened is `cannot-open` with the errno, never a new workspace', async () => {
    await folderOfToday();
    await chmod(join(dir, 'state.json'), 0o000);
    try {
      const before = await snapshotOf(dir);
      expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'cannot-open', errno: 'EACCES', path: join(dir, 'state.json'), paths: [join(dir, 'state.json')] });
      expect(await snapshotOf(dir)).toEqual(before);
    } finally {
      await chmod(join(dir, 'state.json'), 0o600);
    }
  });

  it('state.json missing beside a key is a refusal (`unreadable`, `missing`) that names the kept copies; nothing is created', async () => {
    await folderOfToday();
    await rm(join(dir, 'state.json'));
    await put('state.json.before-upgrade-from-0.4.0', stateOfV040());
    const before = await snapshotOf(dir);
    const refusal = await rejectionOf(readWorkspaceFolder(options()));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'missing', path: join(dir, 'state.json'), writtenBy: SMURG });
    expect(refusal.copies).toEqual([{ path: keptCopyPath(dir, 'state', '0.4.0'), from: '0.4.0', at: expect.any(Number) }]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  for (const [what, leave] of Object.entries({
    'the key': ['identity.key'],
    'another document': ['suggestions.json'],
    'a log': ['audit.jsonl'],
    'the key and the stamp': ['identity.key', STAMP_FILE],
  })) {
    it(`state.json absent while only ${what} is there is the same refusal: that folder is not a new workspace`, async () => {
      await folderOfToday();
      for (const name of await readdir(dir)) if (!leave.includes(name)) await rm(join(dir, name), { recursive: true });
      const before = await snapshotOf(dir);
      expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'unreadable', reason: 'missing', path: join(dir, 'state.json') });
      expect(await snapshotOf(dir)).toEqual(before);
    });
  }

  it('a folder that holds nothing but the stamp is a NEW workspace (a first start that died right after it wrote the stamp left nothing to lose)', async () => {
    // V1-6. What phase 2 of a brand-new folder leaves when the start dies before the key and the first state.json.
    (await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock })).store.close();
    expect(await readdir(dir)).toEqual([STAMP_FILE]);
    const before = await snapshotOf(dir);
    const reading = await readWorkspaceFolder(options());
    expect(reading).toMatchObject({ isNew: true, keyPair: null, putBack: false, stamp: { smurg: SMURG, shapes: 1 } });
    expect(reading.loaded.size).toBe(0);
    expect(await snapshotOf(dir)).toEqual(before);
    // The same with the private sub-folders a start makes, and with a kept copy alone (as before: a copy does not
    // make a folder a workspace); and a stamp of a smurg with newer shapes still refuses.
    await mkdir(join(dir, 'uploads'), { mode: 0o700 });
    await put('state.json.before-upgrade-from-0.4.0', stateOfV040());
    expect(await readWorkspaceFolder(options())).toMatchObject({ isNew: true });
    await put(STAMP_FILE, { smurg: '0.9.0', shapes: 2, at: 5 });
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'newer', path: dir });
  });

  it('the key missing beside state.json is a refusal (`unreadable`, `missing`); no new key is created', async () => {
    await folderOfToday();
    await rm(join(dir, 'identity.key'));
    const before = await snapshotOf(dir);
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'unreadable', reason: 'missing', path: join(dir, 'identity.key'), copies: [] });
    expect(await snapshotOf(dir)).toEqual(before);
  });

  it('a key that is not 32 bytes is `unreadable` (never replaced)', async () => {
    await folderOfToday();
    await put('identity.key', 'short');
    const before = await snapshotOf(dir);
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', path: join(dir, 'identity.key') });
    expect(await snapshotOf(dir)).toEqual(before);
  });

  it('a state.json of another workspace is `other-workspace`', async () => {
    await folderOfToday();
    expect(await rejectionOf(readWorkspaceFolder(options({ workspaceId: 'ws_test_another_one_0123' })))).toMatchObject({ kind: 'other-workspace', path: join(dir, 'state.json') });
  });

  it('a LATER document that fails, after an earlier one would have been upgraded, leaves the folder byte for byte', async () => {
    await folderOfV040();
    await put('bare.json', { live: 'not-a-list' }); // the last declared document
    const before = await snapshotOf(dir);
    const refusal = await rejectionOf(readWorkspaceFolder(options()));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', path: join(dir, 'bare.json') });
    expect(refusal.problems).toEqual([expect.stringMatching(/^live: /)]);
    expect(await snapshotOf(dir)).toEqual(before);
    expect((await readdir(dir)).some((name) => name.includes('before-upgrade') || name === STAMP_FILE)).toBe(false);
  });

  it('a folder that others can read is refused as before (it is never chmod-ed)', async () => {
    await folderOfToday();
    await chmod(dir, 0o755);
    await expect(readWorkspaceFolder(options())).rejects.toMatchObject({ name: 'KeyFileError', code: 'insecure-directory', path: dir });
    expect(((await lstat(dir)).mode & 0o777).toString(8)).toBe('755');
  });

  it('refuses two modules that declare the same document', async () => {
    await expect(readWorkspaceFolder(options({ documents: [core, bareDocument, bareDocument] }))).rejects.toThrow(/declared twice/);
  });
});

describe('phase 2 writes, in order', () => {
  it('a new workspace: the folder (0700) and the stamp; the store creates a declared document from its init when it is opened', async () => {
    const reading = await readWorkspaceFolder(options());
    const { store, upgraded } = await writeWorkspaceFolder(reading, { log: silentLogger, clock });
    expect(upgraded).toEqual([]);
    expect(((await lstat(dir)).mode & 0o777).toString(8)).toBe('700');
    expect(await readdir(dir)).toEqual([STAMP_FILE]);
    expect(JSON.parse(await readFile(join(dir, STAMP_FILE), 'utf8'))).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
    const bare = await store.document('bare', bareSchema, () => ({ live: [] }));
    expect(bare.get()).toEqual({ live: [] });
    expect((await readdir(dir)).sort()).toEqual(['bare.json', STAMP_FILE]);
    await expect(store.document('undeclared', bareSchema, () => ({ live: [] }))).rejects.toThrow(/was not declared/);
    await expect(store.document('bare', z.strictObject({ live: z.array(z.string()) }), () => ({ live: [] }))).rejects.toThrow(/another schema/);
    store.close();
  });

  it('what 0.4.0 wrote: the stamp, then for each upgraded document its kept copy (byte for byte, 0600) and the document in today\'s shape, in THIS start', async () => {
    await folderOfV040();
    const oldState = await readFile(join(dir, 'state.json'));
    const oldSuggestions = await readFile(join(dir, 'suggestions.json'));
    const bareBefore = await lstat(join(dir, 'bare.json'));
    const reading = await readWorkspaceFolder(options());
    const { store, upgraded } = await writeWorkspaceFolder(reading, { log: silentLogger, clock });
    expect(upgraded).toEqual([
      { document: 'state', from: '0.4.0', copy: keptCopyPath(dir, 'state', '0.4.0') },
      { document: 'suggestions', from: '0.4.0', copy: keptCopyPath(dir, 'suggestions', '0.4.0') },
    ]);
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0'))).equals(oldState)).toBe(true);
    expect((await readFile(keptCopyPath(dir, 'suggestions', '0.4.0'))).equals(oldSuggestions)).toBe(true);
    for (const name of ['state.json', 'suggestions.json', 'state.json.before-upgrade-from-0.4.0', 'suggestions.json.before-upgrade-from-0.4.0', STAMP_FILE]) {
      expect(`${name} ${((await lstat(join(dir, name))).mode & 0o777).toString(8)}`).toBe(`${name} 600`);
    }
    // On disk now: exactly what this smurg writes (its strict schema, its serialization).
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as unknown;
    expect(workspaceStateSchema.safeParse(state).success).toBe(true);
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(serializeDocument(reading.loaded.get('state')?.value));
    expect(suggestionsDocumentSchema.safeParse(JSON.parse(await readFile(join(dir, 'suggestions.json'), 'utf8'))).success).toBe(true);
    // A document that needed no step is not rewritten.
    expect((await lstat(join(dir, 'bare.json'))).mtimeMs).toBe(bareBefore.mtimeMs);
    // The store hands out what phase 1 read; opening reads and writes nothing more.
    const snapshot = await snapshotOf(dir);
    const opened = await store.coreDocument('state', core.schema, core.init);
    expect(opened.get()).toEqual(reading.loaded.get('state')?.value);
    expect(await snapshotOf(dir)).toEqual(snapshot);
    store.close();
  });

  it('a second start runs no step, rewrites no document because of an upgrade and makes no second copy', async () => {
    await folderOfV040();
    await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock });
    const stateAfterFirst = await lstat(join(dir, 'state.json'));
    const copyAfterFirst = await lstat(keptCopyPath(dir, 'state', '0.4.0'));
    const names = (await readdir(dir)).sort();
    clock.advance(60_000);
    const again = await readWorkspaceFolder(options());
    expect(again).toMatchObject({ stamp: { smurg: SMURG, shapes: 1 }, putBack: false });
    expect([...again.loaded.values()].map((document) => document.upgradedFrom)).toEqual([null, null, null]);
    expect((await writeWorkspaceFolder(again, { log: silentLogger, clock })).upgraded).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(names);
    expect((await lstat(join(dir, 'state.json'))).mtimeMs).toBe(stateAfterFirst.mtimeMs);
    expect((await lstat(keptCopyPath(dir, 'state', '0.4.0'))).mtimeMs).toBe(copyAfterFirst.mtimeMs);
    // The stamp is written at every start (its `at` moves).
    expect(JSON.parse(await readFile(join(dir, STAMP_FILE), 'utf8'))).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
  });

  it('an OLDER file put back is upgraded again and said to be put back; the kept copy is never overwritten', async () => {
    await folderOfV040();
    const first = await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock });
    first.store.close();
    // Later the host kicks somebody ... and then puts the kept copy back.
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkspaceState;
    await put('state.json', { ...state, members: state.members.map((member) => (member.userId === 'dev:amy' ? { ...member, status: 'kicked', kickedAt: 5_000 } : member)) });
    await copyFile(keptCopyPath(dir, 'state', '0.4.0'), join(dir, 'state.json'));
    const copyBefore = await lstat(keptCopyPath(dir, 'state', '0.4.0'));
    const log = createMemoryLogger();
    const reading = await readWorkspaceFolder(options({ log }));
    expect(reading).toMatchObject({ putBack: true, stamp: { smurg: SMURG } });
    expect(reading.loaded.get('state')).toMatchObject({ upgradedFrom: '0.4.0' });
    const { upgraded } = await writeWorkspaceFolder(reading, { log, clock });
    expect(upgraded).toEqual([{ document: 'state', from: '0.4.0', copy: keptCopyPath(dir, 'state', '0.4.0') }]);
    expect((await lstat(keptCopyPath(dir, 'state', '0.4.0'))).mtimeMs).toBe(copyBefore.mtimeMs);
    // What it undoes (documented, not prevented): Amy is an active member again.
    expect((JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkspaceState).members.find((member) => member.userId === 'dev:amy')?.status).toBe('active');
    expect(log.lines.some((line) => line.level === 'warn' && /already beside the state file, with the same bytes/.test(line.message))).toBe(true);
  });

  it('a step that runs in a folder without a usable stamp is an upgrade, not a put back', async () => {
    await folderOfV040();
    expect(await readWorkspaceFolder(options())).toMatchObject({ putBack: false });
    await put(STAMP_FILE, { smurg: '0.5.1', shapes: 1, at: 1 }, 0o644); // unusable: the writer is unknown
    expect(await readWorkspaceFolder(options())).toMatchObject({ putBack: false, stamp: null });
    await chmod(join(dir, STAMP_FILE), 0o600);
    expect(await readWorkspaceFolder(options())).toMatchObject({ putBack: true });
  });

  it('a copy of this step that holds OTHER bytes stays as it is, and the file as it is now is kept too, under the next free name (-2, -3, …); the same bytes make nothing new', async () => {
    // A host who went back to 0.4.0 with the kept copy, worked there, and updated again: the copy of the first
    // upgrade is beside a 0.4.0 state.json that is not the one it was made from.
    await folderOfV040();
    const first = await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock });
    first.store.close();
    const copy1 = await readFile(keptCopyPath(dir, 'state', '0.4.0'));
    const sharing = (...sharedDirs: string[]): Record<string, unknown> => ({ ...stateOfV040(), settings: { ...(stateOfV040()['settings'] as Record<string, unknown>), sharedDirs } });
    await put('state.json', sharing('data', 'changed-while-back-on-0.4.0'));
    const laterBytes = await readFile(join(dir, 'state.json'));
    expect(laterBytes.equals(copy1)).toBe(false);
    const log = createMemoryLogger();
    const reading = await readWorkspaceFolder(options({ log }));
    expect(reading).toMatchObject({ putBack: true });
    const second = await writeWorkspaceFolder(reading, { log, clock });
    second.store.close();
    // The first copy is never overwritten; the file as it was just before THIS upgrade is the second one.
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0'))).equals(copy1)).toBe(true);
    expect(keptCopyPath(dir, 'state', '0.4.0', 2)).toBe(join(dir, 'state.json.before-upgrade-from-0.4.0-2'));
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0', 2))).equals(laterBytes)).toBe(true);
    expect(((await lstat(keptCopyPath(dir, 'state', '0.4.0', 2))).mode & 0o777).toString(8)).toBe('600');
    expect(second.upgraded).toEqual([{ document: 'state', from: '0.4.0', copy: keptCopyPath(dir, 'state', '0.4.0', 2) }]);
    expect((JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkspaceState).settings.sharedDirs).toEqual(['data', 'changed-while-back-on-0.4.0']);
    expect(log.lines.some((line) => line.level === 'warn' && /holds other bytes/.test(line.message) && line.fields?.['copy'] === keptCopyPath(dir, 'state', '0.4.0', 2))).toBe(true);

    // The SAME file put back once more (from either copy): nothing new is made, and the copy that holds it is named.
    for (const nth of [2, 1]) {
      await copyFile(keptCopyPath(dir, 'state', '0.4.0', nth), join(dir, 'state.json'));
      const names = (await readdir(dir)).sort();
      const mtimes = await Promise.all([1, 2].map(async (n) => (await lstat(keptCopyPath(dir, 'state', '0.4.0', n))).mtimeMs));
      const again = await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock });
      again.store.close();
      expect(again.upgraded).toEqual([{ document: 'state', from: '0.4.0', copy: keptCopyPath(dir, 'state', '0.4.0', nth) }]);
      expect((await readdir(dir)).sort()).toEqual(names);
      expect(await Promise.all([1, 2].map(async (n) => (await lstat(keptCopyPath(dir, 'state', '0.4.0', n))).mtimeMs))).toEqual(mtimes);
    }

    // Yet another 0.4.0 file: the third name. A refusal names all of them, newest first.
    await put('state.json', sharing('data', 'a-third-one'));
    const thirdBytes = await readFile(join(dir, 'state.json'));
    (await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock })).store.close();
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0', 3))).equals(thirdBytes)).toBe(true);
    await utimes(keptCopyPath(dir, 'state', '0.4.0'), 1_000, 1_000);
    await utimes(keptCopyPath(dir, 'state', '0.4.0', 2), 2_000, 2_000);
    await utimes(keptCopyPath(dir, 'state', '0.4.0', 3), 3_000, 3_000);
    await put('state.json', '{ not json');
    const refusal = await rejectionOf(readWorkspaceFolder(options()));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'not-json' });
    expect(refusal.copies).toEqual([
      { path: keptCopyPath(dir, 'state', '0.4.0', 3), from: '0.4.0', at: 3_000_000 },
      { path: keptCopyPath(dir, 'state', '0.4.0', 2), from: '0.4.0', at: 2_000_000 },
      { path: keptCopyPath(dir, 'state', '0.4.0'), from: '0.4.0', at: 1_000_000 },
    ]);
  });

  it('something that is no kept copy under a LATER name of the step refuses the start too, in phase 1: nothing is written', async () => {
    await folderOfV040();
    await put('state.json.before-upgrade-from-0.4.0', 'an earlier copy, other bytes');
    await writeFile(join(base, 'target'), 'not a copy', { mode: 0o600 });
    await symlink(join(base, 'target'), keptCopyPath(dir, 'state', '0.4.0', 2));
    const before = await snapshotOf(dir);
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'insecure', cause: 'symlink', phase: 1, path: keptCopyPath(dir, 'state', '0.4.0', 2), paths: [keptCopyPath(dir, 'state', '0.4.0', 2)] });
    expect(await snapshotOf(dir)).toEqual(before);
    expect(await readFile(join(base, 'target'), 'utf8')).toBe('not a copy');
  });

  it('a copy that cannot be created refuses the start: the stamp is written, the document is NOT (its name was taken between the two phases: the refusal says phase 2, and the next start is the upgrade)', async () => {
    const COPY = 'state.json.before-upgrade-from-0.4.0';
    await folderOfV040();
    const oldState = await readFile(join(dir, 'state.json'));
    const reading: FolderReading = await readWorkspaceFolder(options());
    await mkdir(join(dir, COPY), { mode: 0o700 });
    expect(await rejectionOf(writeWorkspaceFolder(reading, { log: silentLogger, clock }))).toMatchObject({ kind: 'insecure', cause: 'not-a-file', phase: 2, path: join(dir, COPY) });
    expect((await readFile(join(dir, 'state.json'))).equals(oldState)).toBe(true);
    expect(await stampOnDisk()).toMatchObject({ smurg: SMURG, pending: PENDING_BOTH });
    // With the folder taken away, the next start is the upgrade (never a put back).
    await rm(join(dir, COPY), { recursive: true });
    const next = await readWorkspaceFolder(options());
    expect(next.putBack).toBe(false);
    expect((await writeWorkspaceFolder(next, { log: silentLogger, clock })).upgraded).toEqual(UPGRADED_BOTH());
  });
  it('a stamp that cannot be written refuses the start (`cannot-open`) before any copy or document is written', async () => {
    await folderOfV040();
    await mkdir(join(dir, STAMP_FILE));
    await writeFile(join(dir, STAMP_FILE, 'x'), 'x');
    const reading = await readWorkspaceFolder(options()); // an unusable stamp is not a refusal of phase 1
    expect(reading.stamp).toBeNull();
    const before = await snapshotOf(dir);
    expect(await rejectionOf(writeWorkspaceFolder(reading, { log: silentLogger, clock }))).toMatchObject({ kind: 'cannot-open', path: join(dir, STAMP_FILE) });
    expect(await snapshotOf(dir)).toEqual(before);
  });

  it('the stamp is never lowered: an older smurg that opens a folder of the same shapes keeps the newer writer\'s name', async () => {
    await folderOfToday();
    await writeStamp(dir, { smurg: '0.9.0', shapes: 1, at: 5 });
    const reading = await readWorkspaceFolder(options());
    expect(reading.stamp).toEqual({ smurg: '0.9.0', shapes: 1, at: 5 });
    (await writeWorkspaceFolder(reading, { log: silentLogger, clock })).store.close();
    expect(JSON.parse(await readFile(join(dir, STAMP_FILE), 'utf8'))).toEqual({ smurg: '0.9.0', shapes: 1, at: clock.now() });
    await writeStamp(dir, { smurg: '0.5.0', shapes: 1, at: 5 });
    (await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock })).store.close();
    expect(JSON.parse(await readFile(join(dir, STAMP_FILE), 'utf8'))).toMatchObject({ smurg: SMURG });
  });
});

// =====================================================================================================================
// The last fixes of 0.5.1 (what five sceptics found by running the real thing)
// =====================================================================================================================

/** A start that DIES right after one of its writes: nothing after that write happens, nothing is cleaned up. */
class Died extends Error {}
const dyingAfter = (write: string) => (written: string): void => {
  if (written === write) throw new Died(`died after ${write}`);
};
const stampOnDisk = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(dir, STAMP_FILE), 'utf8')) as Record<string, unknown>;
const PENDING_BOTH = [
  { document: 'state', from: '0.4.0', copy: 'state.json.before-upgrade-from-0.4.0' },
  { document: 'suggestions', from: '0.4.0', copy: 'suggestions.json.before-upgrade-from-0.4.0' },
];
const UPGRADED_BOTH = (): unknown[] => [
  { document: 'state', from: '0.4.0', copy: keptCopyPath(dir, 'state', '0.4.0') },
  { document: 'suggestions', from: '0.4.0', copy: keptCopyPath(dir, 'suggestions', '0.4.0') },
];

describe('an upgrade that did not finish is not a put back (V1-1, V2-2)', () => {
  it('the stamp says what is under way: written first WITH `pending`, and again without it when the last document is on disk', async () => {
    await folderOfV040();
    const seen: Record<string, unknown>[] = [];
    const writes: string[] = [];
    const reading = await readWorkspaceFolder(options());
    const { upgraded, store } = await writeWorkspaceFolder(reading, {
      log: silentLogger,
      clock,
      interrupt: async (written) => {
        writes.push(written);
        seen.push(await stampOnDisk());
      },
    });
    store.close();
    expect(writes).toEqual(['stamp', 'copy:state', 'document:state', 'copy:suggestions', 'document:suggestions', 'stamp']);
    // While the documents were being upgraded the stamp named them, with the copy each gets; at the end it does not.
    for (const during of seen.slice(0, 5)) expect(during).toEqual({ smurg: SMURG, shapes: 1, at: clock.now(), pending: PENDING_BOTH });
    expect(seen[5]).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
    expect(upgraded).toEqual(UPGRADED_BOTH());
  });

  it('a start with nothing to upgrade writes the stamp once, without `pending`', async () => {
    await folderOfToday();
    const writes: string[] = [];
    (await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock, interrupt: (written) => void writes.push(written) })).store.close();
    expect(writes).toEqual(['stamp']);
    expect(await stampOnDisk()).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
  });

  it('killed between the stamp and the first document: the next start finishes the job and reports an UPGRADE', async () => {
    await folderOfV040();
    const oldState = await readFile(join(dir, 'state.json'));
    await expect(writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock, interrupt: dyingAfter('stamp') })).rejects.toBeInstanceOf(Died);
    // What the death left: the stamp, and nothing else of the upgrade.
    expect(await stampOnDisk()).toMatchObject({ smurg: SMURG, pending: PENDING_BOTH });
    expect((await readFile(join(dir, 'state.json'))).equals(oldState)).toBe(true);
    expect((await readdir(dir)).filter((name) => name.includes('before-upgrade'))).toEqual([]);

    const next = await readWorkspaceFolder(options());
    expect(next).toMatchObject({ putBack: false, stamp: { smurg: SMURG, shapes: 1 } });
    const { upgraded, store } = await writeWorkspaceFolder(next, { log: silentLogger, clock });
    store.close();
    expect(upgraded).toEqual(UPGRADED_BOTH());
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0'))).equals(oldState)).toBe(true);
    expect(await stampOnDisk()).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
    // And from then on it is an ordinary folder of today: a later start upgrades nothing and says nothing.
    const later = await readWorkspaceFolder(options());
    expect(later).toMatchObject({ putBack: false });
    expect((await writeWorkspaceFolder(later, { log: silentLogger, clock })).upgraded).toEqual([]);
  });

  it.each(['copy:state', 'document:state', 'copy:suggestions'])('killed after %s (between two documents): the next start upgrades the rest and reports the WHOLE upgrade, never a put back', async (write) => {
    await folderOfV040();
    const old = { state: await readFile(join(dir, 'state.json')), suggestions: await readFile(join(dir, 'suggestions.json')) };
    await expect(writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock, interrupt: dyingAfter(write) })).rejects.toBeInstanceOf(Died);
    const stateWasWritten = write !== 'copy:state';
    expect(workspaceStateSchema.safeParse(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).success).toBe(stateWasWritten);

    const log = createMemoryLogger();
    const next = await readWorkspaceFolder(options({ log }));
    expect(next.putBack).toBe(false);
    expect(next.loaded.get('state')?.upgradedFrom).toBe(stateWasWritten ? null : '0.4.0');
    expect(next.loaded.get('suggestions')?.upgradedFrom).toBe('0.4.0');
    const stateBefore = await lstat(join(dir, 'state.json'));
    const { upgraded, store } = await writeWorkspaceFolder(next, { log, clock });
    store.close();
    // state.json too, although THIS start found it upgraded already: the host never read that it was.
    expect(upgraded).toEqual(UPGRADED_BOTH());
    if (stateWasWritten) expect((await lstat(join(dir, 'state.json'))).mtimeMs).toBe(stateBefore.mtimeMs); // not written a second time
    // One copy of each, the file as 0.4.0 left it (a copy the dead start had made is the one that is named).
    expect((await readdir(dir)).filter((name) => name.includes('before-upgrade')).sort()).toEqual(['state.json.before-upgrade-from-0.4.0', 'suggestions.json.before-upgrade-from-0.4.0']);
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0'))).equals(old.state)).toBe(true);
    expect((await readFile(keptCopyPath(dir, 'suggestions', '0.4.0'))).equals(old.suggestions)).toBe(true);
    expect(await stampOnDisk()).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
    expect(log.lines.some((line) => /put back/.test(line.message))).toBe(false);
  });

  it('killed after the last document, before the stamp was written again: the next start has nothing to upgrade and still reports the upgrade, once', async () => {
    await folderOfV040();
    await expect(writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock, interrupt: dyingAfter('document:suggestions') })).rejects.toBeInstanceOf(Died);
    expect(await stampOnDisk()).toMatchObject({ pending: PENDING_BOTH });
    const mtimes = await Promise.all(['state.json', 'suggestions.json'].map(async (name) => (await lstat(join(dir, name))).mtimeMs));
    const next = await readWorkspaceFolder(options());
    expect(next.putBack).toBe(false);
    expect([...next.loaded.values()].map((document) => document.upgradedFrom)).toEqual([null, null, null]);
    const { upgraded, store } = await writeWorkspaceFolder(next, { log: silentLogger, clock });
    store.close();
    expect(upgraded).toEqual(UPGRADED_BOTH());
    expect(await Promise.all(['state.json', 'suggestions.json'].map(async (name) => (await lstat(join(dir, name))).mtimeMs))).toEqual(mtimes);
    expect(await stampOnDisk()).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
    expect((await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock })).upgraded).toEqual([]);
  });

  it('a REAL put back is still said: a usable stamp WITHOUT `pending` and a file in an older shape', async () => {
    await folderOfV040();
    (await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock })).store.close();
    await copyFile(keptCopyPath(dir, 'state', '0.4.0'), join(dir, 'state.json'));
    expect(await readWorkspaceFolder(options())).toMatchObject({ putBack: true });
    // The same file while an upgrade is under way is that upgrade, whatever of it is already done.
    await put(STAMP_FILE, { smurg: SMURG, shapes: 1, at: 5, pending: PENDING_BOTH });
    expect(await readWorkspaceFolder(options())).toMatchObject({ putBack: false });
  });

  it('a `pending` that is not what this smurg writes makes the whole stamp unusable (the writer is unknown; never a put back, never a refusal)', async () => {
    await folderOfV040();
    for (const pending of [[], 'state', [{ document: 'state', from: '0.4.0' }], [{ document: 'state', from: '0.4.0', copy: '../../elsewhere' }], [{ document: 'state', from: '0.4.0', copy: 'suggestions.json.before-upgrade-from-0.4.0' }], [{ document: 'state', from: '0.4.0', copy: 'state.json.before-upgrade-from-0.3.0' }]]) {
      await put(STAMP_FILE, { smurg: SMURG, shapes: 1, at: 5, pending });
      expect(await readWorkspaceFolder(options()), JSON.stringify(pending)).toMatchObject({ stamp: null, putBack: false });
    }
  });
});

describe('the names of the kept copies are looked at in phase 1 (V1-1a, V2-2, V1-5)', () => {
  const COPY = 'state.json.before-upgrade-from-0.4.0';
  const taken: Readonly<Record<string, { make(): Promise<void>; refusal: Record<string, unknown>; cure(): Promise<void> }>> = {
    'a symlink to a file of the host': {
      make: async () => {
        await writeFile(join(base, 'victim.txt'), 'the host\'s own file\n', { mode: 0o600 });
        await symlink(join(base, 'victim.txt'), join(dir, COPY));
      },
      refusal: { kind: 'insecure', cause: 'symlink' },
      cure: () => rm(join(dir, COPY)),
    },
    'a symlink to nothing': { make: () => symlink(join(base, 'nowhere'), join(dir, COPY)), refusal: { kind: 'insecure', cause: 'symlink' }, cure: () => rm(join(dir, COPY)) },
    'a folder': { make: () => mkdir(join(dir, COPY), { mode: 0o700 }), refusal: { kind: 'insecure', cause: 'not-a-file' }, cure: () => rm(join(dir, COPY), { recursive: true }) },
    'a FIFO (must not hang)': { make: async () => void execFileSync('/usr/bin/mkfifo', ['-m', '600', join(dir, COPY)]), refusal: { kind: 'insecure', cause: 'not-a-file' }, cure: () => rm(join(dir, COPY)) },
    'a file others can read': { make: () => put(COPY, '{"other": true}\n', 0o644), refusal: { kind: 'insecure', cause: 'mode', mode: 0o644 }, cure: () => chmod(join(dir, COPY), 0o600) },
    'no free name: 99 copies with other bytes': {
      make: async () => {
        await put(COPY, 'x1\n');
        for (let n = 2; n <= 99; n++) await put(`${COPY}-${n}`, `x${n}\n`);
      },
      refusal: { kind: 'cannot-open', errno: 'EEXIST' },
      cure: () => rm(join(dir, `${COPY}-50`)),
    },
  };

  it.each(Object.keys(taken))('the name of the copy a step WILL make is taken by %s: refused before anything is written, the folder byte for byte; put right, the next start is the upgrade', async (how) => {
    const one = taken[how] as (typeof taken)[string];
    await folderOfV040();
    await one.make();
    const before = await snapshotOf(dir);
    const refusal = await rejectionOf(readWorkspaceFolder(options()));
    expect(refusal).toMatchObject({ ...one.refusal, phase: 1 });
    expect(refusal.path.startsWith(join(dir, COPY))).toBe(true);
    expect(await snapshotOf(dir)).toEqual(before);
    expect((await readdir(dir)).includes(STAMP_FILE)).toBe(false);
    if (how.startsWith('a symlink to a file')) expect(await readFile(join(base, 'victim.txt'), 'utf8')).toBe('the host\'s own file\n');

    await one.cure();
    const next = await readWorkspaceFolder(options());
    expect(next.putBack).toBe(false);
    const { upgraded, store } = await writeWorkspaceFolder(next, { log: silentLogger, clock });
    store.close();
    expect(upgraded.map((entry) => entry.document)).toEqual(['state', 'suggestions']);
  });

  it('the copy of the SECOND document that will be upgraded is looked at too: nothing of the first is written', async () => {
    await folderOfV040();
    await symlink(join(base, 'nowhere'), keptCopyPath(dir, 'suggestions', '0.4.0'));
    const before = await snapshotOf(dir);
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'insecure', cause: 'symlink', phase: 1, path: keptCopyPath(dir, 'suggestions', '0.4.0') });
    expect(await snapshotOf(dir)).toEqual(before);
  });

  it('a hard link to the file itself, or a copy with the same bytes, is a kept copy: nothing is refused and nothing new is made', async () => {
    await folderOfV040();
    await link(join(dir, 'state.json'), join(dir, COPY));
    const old = await readFile(join(dir, 'state.json'));
    const { upgraded, store } = await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock });
    store.close();
    expect(upgraded[0]).toEqual({ document: 'state', from: '0.4.0', copy: join(dir, COPY) });
    expect((await readFile(join(dir, COPY))).equals(old)).toBe(true); // the copy still holds what 0.4.0 wrote
    expect(workspaceStateSchema.safeParse(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).success).toBe(true);
  });

  it('kept copies are among the files whose owner, mode and kind are checked, also when no step runs: every one is in `paths`, after the documents (V1-5)', async () => {
    await folderOfV040();
    (await writeWorkspaceFolder(await readWorkspaceFolder(options()), { log: silentLogger, clock })).store.close();
    await put('state.json.before-upgrade-from-0.4.0-2', 'a second copy');
    // A restore without modes: every file 0644.
    for (const name of await readdir(dir)) await chmod(join(dir, name), 0o644);
    const before = await snapshotOf(dir);
    const refusal = await rejectionOf(readWorkspaceFolder(options()));
    expect(refusal).toMatchObject({ kind: 'insecure', cause: 'mode', mode: 0o644, phase: 1, path: join(dir, 'identity.key') });
    // (The stamp is not in the list: one that cannot be used is written anew, 0600, by the start itself.)
    expect(refusal.paths).toEqual(
      ['identity.key', 'audit.jsonl', 'activity.jsonl', 'state.json', 'suggestions.json', 'bare.json', 'state.json.before-upgrade-from-0.4.0', 'state.json.before-upgrade-from-0.4.0-2', 'suggestions.json.before-upgrade-from-0.4.0'].map((name) => join(dir, name)),
    );
    expect(await snapshotOf(dir)).toEqual(before);
    // The ONE chmod the command prints from `paths` cures the folder.
    for (const path of refusal.paths) await chmod(path, 0o600);
    expect(await readWorkspaceFolder(options())).toMatchObject({ isNew: false, putBack: false, stamp: null });
    // A link under a copy's name is refused although nothing will be upgraded; a name that is no copy's is not looked at.
    await rm(keptCopyPath(dir, 'suggestions', '0.4.0'));
    await symlink(join(base, 'nowhere'), keptCopyPath(dir, 'suggestions', '0.4.0'));
    await symlink(join(base, 'nowhere'), join(dir, 'state.json.before-upgrade-from-0.4.0.bak'));
    expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'insecure', cause: 'symlink', paths: [keptCopyPath(dir, 'suggestions', '0.4.0')] });
  });

});

describe('the stamp\'s `shapes` decides alone (V1-3)', () => {
  const NEWER: Readonly<Record<string, { stamp: unknown; mode?: number; writtenBy?: string }>> = {
    'a version name this smurg does not write': { stamp: { smurg: '0.6.0-rc.1', shapes: 2, at: 5 } },
    'one more key': { stamp: { smurg: '0.6.0', shapes: 2, at: 5, relay: 'x' }, writtenBy: '0.6.0' },
    'a number above 1,000,000': { stamp: { smurg: '9.0.0', shapes: 1_000_001, at: 5 }, writtenBy: '9.0.0' },
    'a file others can read (a restore without modes)': { stamp: { smurg: '0.6.0', shapes: 2, at: 5 }, mode: 0o644, writtenBy: '0.6.0' },
    'nothing but the number': { stamp: { shapes: 2 } },
    'a number that is no integer': { stamp: { smurg: '0.6.0', shapes: 1.5, at: 5 }, writtenBy: '0.6.0' },
    'a name with control characters': { stamp: { smurg: `0.6.0${String.fromCharCode(27)}[2J`, shapes: 3, at: 5 } },
  };

  it.each(Object.keys(NEWER))('a stamp with %s and a higher `shapes` refuses the whole folder as `newer`; nothing is read further, nothing is written, the stamp is not lowered', async (how) => {
    const one = NEWER[how] as (typeof NEWER)[string];
    await folderOfToday();
    await put('state.json', '{ this is not JSON'); // would be `unreadable` if a document were read
    await put(STAMP_FILE, one.stamp, one.mode ?? 0o600);
    const before = await snapshotOf(dir);
    const refusal = await rejectionOf(readWorkspaceFolder(options()));
    expect(refusal).toMatchObject({ kind: 'newer', phase: 1, path: dir, paths: [dir] });
    expect(refusal.writtenBy).toBe(one.writtenBy);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(refusal.message)).toBe(false);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  it('what is not a number in a JSON object in a file is no stamp at all: the writer is unknown, as before (never `newer`, never a refusal)', async () => {
    await folderOfToday();
    const cases: [string, () => Promise<void>][] = [
      ['not JSON', () => put(STAMP_FILE, '{"smurg": "0.6.0", "shapes": 2')],
      ['a list', () => put(STAMP_FILE, [{ shapes: 2 }])],
      ['a number as text', () => put(STAMP_FILE, { smurg: '0.6.0', shapes: '2', at: 5 })],
      ['too large', () => put(STAMP_FILE, `{"smurg":"0.6.0","shapes":2,"at":5,"pad":"${'x'.repeat(5000)}"}`)],
      ['a link', async () => {
        await writeFile(join(base, 'elsewhere.json'), serializeDocument({ smurg: '0.6.0', shapes: 2, at: 5 }), { mode: 0o600 });
        await rm(join(dir, STAMP_FILE), { force: true });
        await symlink(join(base, 'elsewhere.json'), join(dir, STAMP_FILE));
      }],
    ];
    for (const [what, make] of cases) {
      await make();
      expect(await readWorkspaceFolder(options()), what).toMatchObject({ isNew: false, stamp: null, putBack: false });
    }
  });

  it('the other fields are "unknown" when they do not fit: such a stamp of the SAME shapes starts, as a folder whose writer is unknown, and the stamp written over it keeps the number', async () => {
    await folderOfV040();
    await put(STAMP_FILE, { smurg: '0.6.0', shapes: 1, at: 5, relay: 'x' });
    const reading = await readWorkspaceFolder(options());
    expect(reading).toMatchObject({ stamp: null, putBack: false });
    (await writeWorkspaceFolder(reading, { log: silentLogger, clock })).store.close();
    expect(await stampOnDisk()).toEqual({ smurg: SMURG, shapes: 1, at: clock.now() });
  });

  it('phase 2 never lowers `shapes`: a smurg that reads shapes 2 keeps a 2 it found', async () => {
    await folderOfToday();
    await put(STAMP_FILE, { smurg: '0.9.0', shapes: 2, at: 5 });
    const reading = await readWorkspaceFolder(options({ shapes: 2 }));
    (await writeWorkspaceFolder({ ...reading, shapes: 1 }, { log: silentLogger, clock })).store.close();
    expect(await stampOnDisk()).toEqual({ smurg: '0.9.0', shapes: 2, at: clock.now() });
  });
});
