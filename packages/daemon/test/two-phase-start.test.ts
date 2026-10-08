// A start of the DAEMON has two phases (ARCHITECTURE §7.1; src/daemon.ts, core/workspace-folder.ts): everything a
// start wrote, created or deleted before its last document was read (the key, the two audit files, ensureHost and
// prune, private folders, the launch files under ~/.smurg/sessions, uploads it could not validate, the left-over
// processes and sessions.json, inbox.json) now comes after phase 1 accepted the whole folder. These tests start the
// release composition on hand-made folders; the folders the published versions really wrote are in test/upgrade/.
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMaxLiveAgents } from '../src/core/config.ts';
import { STAMP_FILE, keptCopyPath, serializeDocument } from '../src/core/state-store.ts';
import type { WorkspaceState } from '../src/core/workspace-state.ts';
import { DAEMON_VERSION } from '../src/daemon.ts';
import { sessionFilesRoot } from '../src/hooks/settings-writer.ts';
import type { SuggestionsDocument } from '../src/suggest/store.ts';
import { createTempDir, createTempProject, createTempRunDir, createTestDaemon, removeTempDir, removeTempRunDir, type TestDaemon } from '../src/testing/index.ts';
import { rejectionOf, snapshotOf, suggestionsOfV040 } from './fixtures/hand-made.ts';

const WS = 'ws_test_two_phase_start_01';
const cleanups: (() => Promise<void>)[] = [];
let running: TestDaemon | null = null;

afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

interface Home {
  /** SMURG_HOME of this test (short: the sockets are below it). */
  readonly stateDir: string;
  /** `<stateDir>/workspaces/<WS>` */
  readonly dir: string;
  readonly root: string;
  start(): Promise<TestDaemon>;
  stop(): Promise<void>;
}

async function home(): Promise<Home> {
  const stateDir = await createTempRunDir();
  cleanups.push(() => removeTempRunDir(stateDir));
  const base = await createTempDir('two-phase');
  cleanups.push(() => removeTempDir(base));
  const root = await createTempProject(base, 'project', { files: { 'README.md': 'hello\n' } });
  return {
    stateDir,
    dir: join(stateDir, 'workspaces', WS),
    root,
    start: async () => (running = await createTestDaemon({ stateDir, root, workspaceId: WS })),
    stop: async () => {
      await running?.cleanup();
      running = null;
    },
  };
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

/**
 * Turns the folder today's smurg wrote into what 0.4.0 left: state.json without the three settings 0.5.0 added,
 * suggestions.json with entries that have no `origin`, no stamp. Returns the state as 0.4.0 held it.
 */
async function asV040Left(h: Home): Promise<Record<string, unknown>> {
  const state = await readJson<WorkspaceState>(join(h.dir, 'state.json'));
  const { maxLiveAgents: _a, escalateAfterMs: _b, agentMcp: _c, ...six } = state.settings;
  const old = { ...state, settings: { ...six, humanLockIdleMs: 45_000, sharedDirs: [] } };
  await writeFile(join(h.dir, 'state.json'), serializeDocument(old), { mode: 0o600 });
  await writeFile(join(h.dir, 'suggestions.json'), serializeDocument(suggestionsOfV040()), { mode: 0o600 });
  await rm(join(h.dir, STAMP_FILE), { force: true });
  return old;
}

/** What a hard death leaves and a start would clear away: each of these is something a start changes or removes. */
async function leaveWhatAStartClears(h: Home): Promise<void> {
  // A session's launch files (the hook server removes the workspace's folder under ~/.smurg/sessions at its start).
  const launch = join(sessionFilesRoot(h.stateDir, WS), '7365735f31');
  await mkdir(launch, { recursive: true, mode: 0o700 });
  await writeFile(join(launch, 'settings.json'), '{}\n', { mode: 0o600 });
  // A partial upload whose manifest this smurg cannot validate (the upload store deletes such an upload at its start).
  await mkdir(join(h.dir, 'uploads'), { recursive: true, mode: 0o700 });
  for (const ext of ['json', 'log', 'part']) await writeFile(join(h.dir, 'uploads', `up_${'a'.repeat(22)}.${ext}`), ext === 'json' ? '{"v": 2}\n' : 'data', { mode: 0o600 });
  // The sessions of a run that died (the sessions module ends their processes and empties the file at its start).
  await writeFile(join(h.dir, 'sessions.json'), serializeDocument({ live: [`ses_${'0'.repeat(32)}`] }), { mode: 0o600 });
  // A torn last line of the audit log (opening the log terminates it), and no audit-text.jsonl (opening creates it).
  await appendFile(join(h.dir, 'audit.jsonl'), '{"id":"au_torn","at":');
  await rm(join(h.dir, 'audit-text.jsonl'), { force: true });
  // inbox.json is created when the inbox module is created.
  await rm(join(h.dir, 'inbox.json'), { force: true });
}

/** The workspace folder, ~/.smurg/sessions and both upload folders: names, modes, bytes. */
async function everything(h: Home): Promise<{ readonly workspace: Record<string, string>; readonly sessions: Record<string, string>; readonly shareUploads: Record<string, string> }> {
  return { workspace: await snapshotOf(h.dir), sessions: await snapshotOf(join(h.stateDir, 'sessions')), shareUploads: await snapshotOf(join(h.root, '.smurg', 'uploads')) };
}

describe('a start has two phases', { timeout: 60_000 }, () => {
  it('a new workspace: the stamp, the key and the first state.json; nothing was upgraded', async () => {
    const h = await home();
    const t = await h.start();
    expect(t.daemon.upgraded).toEqual([]);
    expect(t.daemon.putBack).toBe(false);
    expect(t.daemon.internals.folder).toMatchObject({ isNew: true, stamp: null, keyPair: null });
    expect(await readJson(join(h.dir, STAMP_FILE))).toEqual({ smurg: DAEMON_VERSION, shapes: 1, at: expect.any(Number) });
    const names = await readdir(h.dir);
    expect(names).toEqual(expect.arrayContaining(['identity.key', 'state.json', 'audit.jsonl', 'audit-text.jsonl', 'inbox.json', 'suggestions.json', STAMP_FILE]));
    expect(names.some((name) => name.includes('before-upgrade'))).toBe(false);
    await h.stop();
    // The next start reads what this one wrote: an existing folder, nothing to upgrade.
    const again = await h.start();
    expect(again.daemon.internals.folder).toMatchObject({ isNew: false, stamp: { smurg: DAEMON_VERSION, shapes: 1 }, putBack: false });
    expect(again.daemon.upgraded).toEqual([]);
    expect(Buffer.from(again.daemon.daemonPublicKey).equals(Buffer.from(t.daemon.daemonPublicKey))).toBe(true);
  });

  it('what 0.4.0 left is upgraded in the start that reads it: kept copies, today\'s shapes on disk, Daemon.upgraded; the next start upgrades nothing', async () => {
    const h = await home();
    const first = await h.start();
    const amy = await first.connect({ userId: 'dev:amy', role: 'editor' });
    amy.close();
    const key = Buffer.from(first.daemon.daemonPublicKey);
    await h.stop();
    const old = await asV040Left(h);
    const oldStateBytes = await readFile(join(h.dir, 'state.json'));
    const oldSuggestionBytes = await readFile(join(h.dir, 'suggestions.json'));

    const t = await h.start();
    expect(t.daemon.upgraded).toEqual([
      { document: 'state', from: '0.4.0', copy: keptCopyPath(h.dir, 'state', '0.4.0') },
      { document: 'suggestions', from: '0.4.0', copy: keptCopyPath(h.dir, 'suggestions', '0.4.0') },
    ]);
    expect(t.daemon.putBack).toBe(false);
    expect(Buffer.from(t.daemon.daemonPublicKey).equals(key)).toBe(true); // the same key: every pin stays true
    expect((await readFile(keptCopyPath(h.dir, 'state', '0.4.0'))).equals(oldStateBytes)).toBe(true);
    expect((await readFile(keptCopyPath(h.dir, 'suggestions', '0.4.0'))).equals(oldSuggestionBytes)).toBe(true);
    // The documents as loaded and upgraded, before the composition changed anything.
    const loaded = t.daemon.internals.folder.loaded.get('state');
    expect(loaded).toMatchObject({ upgradedFrom: '0.4.0' });
    const { settings, ...rest } = loaded?.value as WorkspaceState;
    const { settings: oldSettings, ...oldRest } = old;
    expect(rest).toEqual(oldRest);
    expect(settings).toMatchObject({ ...(oldSettings as object), escalateAfterMs: 300_000, agentMcp: false });
    expect(settings.maxLiveAgents).toBe(defaultMaxLiveAgents(totalmem()));
    // What the members see: carried settings, the member who joined under "0.4.0".
    expect(t.ctx.settings.get()).toMatchObject({ humanLockIdleMs: 45_000, agentMcp: false, escalateAfterMs: 300_000 });
    expect(t.ctx.members.get('dev:amy')).toMatchObject({ status: 'active', role: 'editor' });
    // The suggestions are carried; the one that was still pending is closed by the suggest module (its session is gone).
    const suggestions = await readJson<SuggestionsDocument>(join(h.dir, 'suggestions.json'));
    expect(suggestions.suggestions.map((entry) => `${entry.id}:${entry.origin}:${entry.status}`)).toEqual(['sg_1:selection:accepted', 'sg_2:composer:rejected', 'sg_3:composer:rejected', 'sg_4:composer:rejected']);
    expect(suggestions.suggestions[3]).toMatchObject({ closedReason: 'session-ended', text: 'still waiting' });
    await h.stop();

    const names = (await readdir(h.dir)).sort();
    const again = await h.start();
    expect(again.daemon.upgraded).toEqual([]);
    expect(again.daemon.putBack).toBe(false);
    expect([...again.daemon.internals.folder.loaded.values()].filter((document) => document.upgradedFrom !== null)).toEqual([]);
    expect((await readdir(h.dir)).sort()).toEqual(names);
    expect((await readFile(keptCopyPath(h.dir, 'state', '0.4.0'))).equals(oldStateBytes)).toBe(true);
  });

  it('a refusal leaves the workspace folder, ~/.smurg/sessions and the uploads byte for byte: a LATER document fails after state.json would have been upgraded', async () => {
    const h = await home();
    await h.start();
    await h.stop();
    await asV040Left(h);
    await leaveWhatAStartClears(h);
    // topics.json belongs to one of the last modules: every earlier module has created and started by then.
    await writeFile(join(h.dir, 'topics.json'), serializeDocument({ version: 1, topics: [{ id: 'damaged' }] }), { mode: 0o600 });
    const before = await everything(h);
    expect(Object.keys(before.sessions).length).toBeGreaterThan(1);

    const refusal = await rejectionOf(h.start());
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', path: join(h.dir, 'topics.json') });
    expect(refusal.problems.length).toBeGreaterThan(0);
    expect(await everything(h)).toEqual(before);
    const names = await readdir(h.dir);
    expect(names).not.toContain(STAMP_FILE);
    expect(names).not.toContain('audit-text.jsonl');
    expect(names).not.toContain('inbox.json');
    expect(names.some((name) => name.includes('before-upgrade'))).toBe(false);

    // With the damage gone the same folder starts, and only now is all of that done.
    await rm(join(h.dir, 'topics.json'));
    const t = await h.start();
    expect(t.daemon.upgraded.map((entry) => entry.document)).toEqual(['state', 'suggestions']);
    expect(await readJson(join(h.dir, 'sessions.json'))).toEqual({ live: [] });
    expect(await snapshotOf(sessionFilesRoot(h.stateDir, WS))).toEqual({});
    expect((await readdir(join(h.dir, 'uploads'))).filter((name) => name.startsWith('up_'))).toEqual([]);
    expect((await readFile(join(h.dir, 'audit.jsonl'), 'utf8')).endsWith('\n')).toBe(true);
  });

  it('state.json missing beside the key is refused and nothing is created (no empty workspace under the old key)', async () => {
    const h = await home();
    await h.start();
    await h.stop();
    await rm(join(h.dir, 'state.json'));
    await leaveWhatAStartClears(h);
    const before = await everything(h);
    expect(await rejectionOf(h.start())).toMatchObject({ kind: 'unreadable', reason: 'missing', path: join(h.dir, 'state.json'), writtenBy: DAEMON_VERSION });
    expect(await everything(h)).toEqual(before);
  });

  it('the key missing beside state.json is refused and no new key is created (teammates would see "the host computer\'s key has changed")', async () => {
    const h = await home();
    await h.start();
    await h.stop();
    await rm(join(h.dir, 'identity.key'));
    const before = await everything(h);
    expect(await rejectionOf(h.start())).toMatchObject({ kind: 'unreadable', reason: 'missing', path: join(h.dir, 'identity.key') });
    expect(await everything(h)).toEqual(before);
  });

  it('a folder last written by a smurg with newer shapes is refused as `newer`, untouched, naming the writer', async () => {
    const h = await home();
    await h.start();
    await h.stop();
    await writeFile(join(h.dir, STAMP_FILE), serializeDocument({ smurg: '9.0.0', shapes: 7, at: 1 }), { mode: 0o600 });
    await leaveWhatAStartClears(h);
    const before = await everything(h);
    expect(await rejectionOf(h.start())).toMatchObject({ kind: 'newer', path: h.dir, writtenBy: '9.0.0' });
    expect(await everything(h)).toEqual(before);
  });

  it('a kept copy put back after a later kick is said to be put back, and undoes the kick (documented, not prevented)', async () => {
    const h = await home();
    const first = await h.start();
    (await first.connect({ userId: 'dev:amy', role: 'editor' })).close();
    await h.stop();
    await asV040Left(h);
    const upgraded = await h.start();
    expect(upgraded.daemon.putBack).toBe(false);
    const host = await upgraded.connectHost();
    await host.conn.request('admin.member.kick', { userId: 'dev:amy' });
    expect(upgraded.ctx.members.get('dev:amy')).toMatchObject({ status: 'kicked' });
    await h.stop();
    expect((await readJson<WorkspaceState>(join(h.dir, 'state.json'))).members.find((member) => member.userId === 'dev:amy')?.status).toBe('kicked');

    await copyFile(keptCopyPath(h.dir, 'state', '0.4.0'), join(h.dir, 'state.json'));
    const t = await h.start();
    expect(t.daemon.putBack).toBe(true);
    expect(t.daemon.upgraded).toEqual([{ document: 'state', from: '0.4.0', copy: keptCopyPath(h.dir, 'state', '0.4.0') }]);
    // What it undoes: the kick, the revocation of her device, and the use of every link since.
    expect(t.ctx.members.get('dev:amy')).toMatchObject({ status: 'active', role: 'editor' });
    expect(t.daemon.internals.members.devicesOf('dev:amy').every((device) => !device.revoked)).toBe(true);
  });
});
