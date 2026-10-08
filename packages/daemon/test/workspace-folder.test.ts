// A start has two phases (ARCHITECTURE §7.1, core/workspace-folder.ts): phase 1 reads and checks the whole workspace
// folder and writes NOTHING; phase 2 writes, in a fixed order, only when phase 1 accepted everything. Tested here on
// the folder itself, with small hand-made files; test/two-phase-start.test.ts does the same through createDaemon.
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadOrCreateDaemonIdentity } from '@smurg/protocol/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defaultHostSettings } from '../src/core/config.ts';
import { ManualClock } from '../src/core/lifecycle.ts';
import { createMemoryLogger, silentLogger } from '../src/core/logger.ts';
import { STAMP_FILE, declareDocument, keptCopyPath, serializeDocument, writeStamp, type DocumentDeclaration } from '../src/core/state-store.ts';
import { readWorkspaceFolder, writeWorkspaceFolder, type FolderReadOptions } from '../src/core/workspace-folder.ts';
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
    'the stamp': [STAMP_FILE],
  })) {
    it(`state.json absent while only ${what} is there is the same refusal: that folder is not a new workspace`, async () => {
      await folderOfToday();
      for (const name of await readdir(dir)) if (!leave.includes(name)) await rm(join(dir, name), { recursive: true });
      const before = await snapshotOf(dir);
      expect(await rejectionOf(readWorkspaceFolder(options()))).toMatchObject({ kind: 'unreadable', reason: 'missing', path: join(dir, 'state.json') });
      expect(await snapshotOf(dir)).toEqual(before);
    });
  }

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

  it('something that is no kept copy under a LATER name of the step refuses the start too, and the document is not written', async () => {
    await folderOfV040();
    await put('state.json.before-upgrade-from-0.4.0', 'an earlier copy, other bytes');
    await writeFile(join(base, 'target'), 'not a copy', { mode: 0o600 });
    await symlink(join(base, 'target'), keptCopyPath(dir, 'state', '0.4.0', 2));
    const oldState = await readFile(join(dir, 'state.json'));
    const reading = await readWorkspaceFolder(options());
    expect(await rejectionOf(writeWorkspaceFolder(reading, { log: silentLogger, clock }))).toMatchObject({ kind: 'insecure', cause: 'symlink', path: keptCopyPath(dir, 'state', '0.4.0', 2) });
    expect((await readFile(join(dir, 'state.json'))).equals(oldState)).toBe(true);
    expect(await readFile(keptCopyPath(dir, 'state', '0.4.0'), 'utf8')).toBe('an earlier copy, other bytes');
    expect(await readFile(join(base, 'target'), 'utf8')).toBe('not a copy');
  });

  it('a copy that cannot be created refuses the start: the stamp is written, the document is NOT', async () => {
    await folderOfV040();
    const oldState = await readFile(join(dir, 'state.json'));
    await writeFile(join(base, 'target'), 'not a copy', { mode: 0o600 });
    await symlink(join(base, 'target'), keptCopyPath(dir, 'state', '0.4.0')); // something else carries the copy's name
    const reading = await readWorkspaceFolder(options());
    expect(await rejectionOf(writeWorkspaceFolder(reading, { log: silentLogger, clock }))).toMatchObject({ kind: 'insecure', cause: 'symlink', path: keptCopyPath(dir, 'state', '0.4.0') });
    expect((await readFile(join(dir, 'state.json'))).equals(oldState)).toBe(true);
    expect(await readFile(join(base, 'target'), 'utf8')).toBe('not a copy');
    expect(JSON.parse(await readFile(join(dir, STAMP_FILE), 'utf8'))).toMatchObject({ smurg: SMURG }); // written FIRST
    await expect(lstat(keptCopyPath(dir, 'suggestions', '0.4.0'))).rejects.toMatchObject({ code: 'ENOENT' });
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
