// 0.5.0 and this smurg open each other's folders (DESIGN "What 0.5.1 must NOT change": every document is written
// exactly as 0.5.0 writes it; files 0.5.0 does not know, the stamp and the kept copies, are ignored by it).
//
// The other side here is THE CODE OF TAG v0.5.0 itself, not a description of it: `git archive v0.5.0` of the daemon
// and the protocol package into a scratch folder, run with node (test/upgrade/published-runner.ts starts that tree's
// daemon on a folder). The scratch tree gets its dependencies from this checkout's node_modules: the versions are the
// same as long as the lockfile entries of the two packages are (they are for 0.5.1); when a dependency is raised,
// the old code runs with the new one here, and the opt-in test with the published executables
// (packages/cli/test/sea-upgrade.test.ts) is the one that runs the old code exactly as it shipped.
//
// The tag must be at hand: this repository's git with the tag (`GIT_DIR` works), or a folder
// `$SMURG_PUBLISHED_TREES/v0.5.0/` that holds `packages/daemon` and `packages/protocol` of the tag. A checkout
// without tags (a shallow clone) SKIPS these tests and says so; for the release (SMURG_RELEASE_GATE=1) the tag must
// be there and a missing one fails.
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DAEMON_VERSION } from '../../src/daemon.ts';
import { createTempDir, removeTempDir, type TestDaemon } from '../../src/testing/index.ts';
import { startOn } from './daemon-on.ts';
import { STAMP_NAME, copyOf, keptCopyName, readJson, snapshotOf, type FixtureCopy, type StoredState } from './fixture.ts';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = join(HERE, '..', '..');
const REPO = join(DAEMON_DIR, '..', '..');
const TAG = 'v0.5.0';
const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';
const MIB = 1024 * 1024;

/** The tag's `packages/daemon` and `packages/protocol` in a scratch folder, or why they cannot be had. */
async function publishedTree(into: string): Promise<{ readonly daemon: string } | { readonly missing: string }> {
  const given = process.env['SMURG_PUBLISHED_TREES'];
  if (given !== undefined && given !== '') {
    try {
      for (const name of ['daemon', 'protocol']) await cp(join(given, TAG, 'packages', name), join(into, 'packages', name), { recursive: true, filter: (source) => !source.split('/').includes('node_modules') });
    } catch (err) {
      return { missing: `SMURG_PUBLISHED_TREES is set and ${join(given, TAG)} does not hold packages/daemon and packages/protocol (${err instanceof Error ? err.message : 'unknown'})` };
    }
  } else {
    try {
      // `git archive <tag> <paths> | tar -x`, without a shell.
      const archive = join(into, 'tag.tar');
      await run('git', ['-C', REPO, 'archive', '--format=tar', '-o', archive, TAG, 'packages/daemon', 'packages/protocol'], { maxBuffer: 64 * MIB });
      await run('tar', ['-xf', archive, '-C', into]);
    } catch (err) {
      return { missing: `git archive ${TAG} failed in ${REPO} (no git, no tag: a shallow checkout?): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}` };
    }
  }
  // Its dependencies: this checkout's, but its OWN protocol package.
  for (const name of ['daemon', 'protocol']) {
    const from = join(REPO, 'packages', name, 'node_modules');
    const to = join(into, 'packages', name, 'node_modules');
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from)) {
      if (entry === '.bin' || entry === '.vite' || entry === '@smurg') continue;
      await symlink(join(from, entry), join(to, entry));
    }
  }
  await mkdir(join(into, 'packages', 'daemon', 'node_modules', '@smurg'), { recursive: true });
  await symlink(join(into, 'packages', 'protocol'), join(into, 'packages', 'daemon', 'node_modules', '@smurg', 'protocol'));
  // The runner, at the place it has in this tree (its imports are relative to it).
  await mkdir(join(into, 'packages', 'daemon', 'test', 'upgrade'), { recursive: true });
  await cp(join(HERE, 'published-runner.ts'), join(into, 'packages', 'daemon', 'test', 'upgrade', 'published-runner.ts'));
  const version = (JSON.parse(await readFile(join(into, 'packages', 'daemon', 'package.json'), 'utf8')) as { version: string }).version;
  if (`v${version}` !== TAG) return { missing: `the tree for ${TAG} says it is ${version}` };
  return { daemon: join(into, 'packages', 'daemon') };
}

interface Opened {
  readonly ok: boolean;
  readonly smurg?: string;
  readonly workspaceId?: string;
  readonly fingerprint?: string;
  readonly members?: string[];
  readonly revokedDevices?: string[];
  readonly devices?: number;
  readonly invites?: string[];
  readonly settings?: Record<string, unknown>;
  readonly name?: string;
  readonly message?: string;
}

let scratch: string | null = null;
let tree: { readonly daemon: string } | { readonly missing: string } = { missing: 'not looked for yet' };
let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];

beforeAll(async () => {
  scratch = await createTempDir('published-tree');
  tree = await publishedTree(scratch);
}, 120_000);
afterAll(async () => {
  if (scratch !== null) await removeTempDir(scratch);
});
afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) await copy.remove().catch(() => {});
});

/** The daemon of the tag, started on the copy and stopped again: what it read, or its refusal. */
async function openedByTheTag(copy: FixtureCopy, at: number): Promise<Opened> {
  if (!('daemon' in tree)) throw new Error(tree.missing);
  const child = await run(process.execPath, ['test/upgrade/published-runner.ts', copy.hostHome, copy.workspaceId, copy.project, String(at)], {
    cwd: tree.daemon,
    env: { ...process.env, SMURG_NO_BROWSER: '1' },
    timeout: 90_000,
    maxBuffer: 16 * MIB,
  }).catch((err: { stdout?: string; stderr?: string; message: string }) => ({ stdout: err.stdout ?? '', stderr: `${err.stderr ?? ''}\n${err.message}` }));
  const line = child.stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
  if (line === undefined) throw new Error(`the daemon of ${TAG} gave no result:\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(line.slice('RESULT '.length)) as Opened;
}

const membersOf = (state: StoredState): string[] => state.members.map((member) => `${member.userId} ${member.role} ${member.status}`);
const keptOf = async (dir: string): Promise<Record<string, string>> => Object.fromEntries(Object.entries(await snapshotOf(dir)).filter(([name]) => name.includes('.before-upgrade-from-') || name === `./${STAMP_NAME}`));

describe(`smurg ${TAG.slice(1)} and this smurg open each other's folders (the code of the tag, from git archive)`, { timeout: 180_000 }, () => {
  it.runIf(RELEASE_GATE)('for the release the code of the tag must be at hand', () => {
    expect(tree).toHaveProperty('daemon');
  });

  it('the tag is at hand, or this checkout says why these tests are skipped', (context) => {
    if (!('daemon' in tree)) context.skip(tree.missing);
    expect(tree).toHaveProperty('daemon');
  });

  it('the tag\'s daemon really is the other side: it refuses what 0.4.0 left, with the sentence the owner met', async (context) => {
    if (!('daemon' in tree)) context.skip(tree.missing);
    const copy = await copyOf('0.4.0');
    copies.push(copy);
    const opened = await openedByTheTag(copy, copy.at);
    expect(opened).toEqual({
      ok: false,
      name: 'StateFileError',
      message: `state file does not match its schema (settings.maxLiveAgents: Invalid input: expected number, received undefined; settings.escalateAfterMs: Invalid input: expected number, received undefined; settings.agentMcp: Invalid input: expected boolean, received undefined): ${join(copy.workspaceDir, 'state.json')}`,
    });
  });

  it.for(['0.4.0', '0.5.0'] as const)('what this smurg wrote over the folder %s left opens in the tag\'s code, and what the tag then wrote opens here again', async (version, context) => {
    if (!('daemon' in tree)) context.skip(tree.missing);
    const copy = await copyOf(version);
    copies.push(copy);
    const before = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));

    // ---- This smurg shares the folder and stops.
    let t = (running = await startOn(copy));
    const upgradedHere = t.daemon.upgraded.map((entry) => entry.document);
    expect(upgradedHere).toEqual(version === '0.4.0' ? ['state', 'suggestions'] : []);
    const fingerprint = t.daemon.fingerprint;
    await t.cleanup();
    running = null;
    const written = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    const kept = await keptOf(copy.workspaceDir);
    expect(Object.keys(kept).sort()).toEqual([...(version === '0.4.0' ? [`./${keptCopyName('state', '0.4.0')}`, `./${keptCopyName('suggestions', '0.4.0')}`] : []), `./${STAMP_NAME}`].sort());

    // ---- The tag's daemon opens that folder: every document, every member, device and link, the settings.
    const opened = await openedByTheTag(copy, copy.at + 60_000);
    expect(opened.message, 'the refusal of the tag\'s daemon').toBeUndefined();
    expect(opened).toMatchObject({ ok: true, smurg: TAG.slice(1), workspaceId: copy.workspaceId, fingerprint });
    expect(opened.members).toEqual(membersOf(before));
    expect(opened.revokedDevices).toEqual(before.devices.filter((device) => device.revoked).map((device) => device.deviceId).sort());
    expect(opened.devices).toBe(before.devices.length);
    expect(opened.settings).toEqual(written.settings);
    for (const invite of before.invites) expect(opened.invites, invite.id).toContain(invite.id);
    // What 0.5.0 does not know it leaves alone: the stamp and the kept copies are as this smurg wrote them.
    expect(await keptOf(copy.workspaceDir)).toEqual(kept);

    // ---- And the other way round: what the tag's daemon wrote (it writes state.json at every start) opens here,
    // as a folder of today's shapes: no step, nothing put back, everybody still there.
    const afterTag = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    expect(afterTag.invites.length).toBeGreaterThan(written.invites.length);
    t = running = await startOn(copy);
    expect(t.daemon.upgraded).toEqual([]);
    expect(t.daemon.putBack).toBe(false);
    expect(t.daemon.internals.folder.loaded.get('state')?.value).toEqual(afterTag);
    expect(t.daemon.internals.folder.stamp).toMatchObject({ smurg: DAEMON_VERSION, shapes: 1 });
    expect(t.ctx.members.list({ includeKicked: true }).map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(membersOf(before));
    expect(t.daemon.fingerprint).toBe(fingerprint);
    expect((await stat(join(copy.workspaceDir, STAMP_NAME))).isFile()).toBe(true);
  });

  it('what the tag\'s daemon left behind when it refused a 0.4.0 folder whose owner had added the three settings by hand opens here', async (context) => {
    if (!('daemon' in tree)) context.skip(tree.missing);
    // FOUND-REAL t02. An owner who read the refusal and wrote the three missing settings into state.json met the
    // second one: 0.5.0 then refused suggestions.json, AFTER it had created its own new documents, emptied
    // sessions.json and removed the launch files. The folder it left is of two versions at once.
    const copy = await copyOf('0.4.0');
    copies.push(copy);
    const statePath = join(copy.workspaceDir, 'state.json');
    const original = await readJson<StoredState>(statePath);
    const mended = { ...original, settings: { ...original.settings, maxLiveAgents: 5, escalateAfterMs: 300_000, agentMcp: true } };
    await writeFile(statePath, `${JSON.stringify(mended, null, 2)}\n`, { mode: 0o600 });
    const suggestionsBefore = await readFile(join(copy.workspaceDir, 'suggestions.json'));

    const refused = await openedByTheTag(copy, copy.at);
    expect(refused).toMatchObject({ ok: false, name: 'StateFileError' });
    expect(refused.message).toMatch(/^state file does not match its schema \(suggestions\.0\.origin: /);
    expect(refused.message?.endsWith(join(copy.workspaceDir, 'suggestions.json'))).toBe(true);
    // What it wrote before it refused (this is why a refusal of this smurg reads everything first).
    expect(await readdir(copy.workspaceDir)).toEqual(expect.arrayContaining(['agent-sessions.json', 'audit-text.jsonl', 'cards.json', 'claude-trust.json', 'host-rules.json', 'inbox.json']));
    expect((await readFile(join(copy.workspaceDir, 'suggestions.json'))).equals(suggestionsBefore)).toBe(true);

    // This smurg: each document by its own shape. state.json is today's (the owner's values stand, agentMcp too:
    // no step runs over what a host wrote), suggestions.json is 0.4.0's and is upgraded, the rest is 0.5.0's.
    const t = (running = await startOn(copy));
    expect(t.daemon.upgraded).toEqual([{ document: 'suggestions', from: '0.4.0', copy: join(copy.workspaceDir, keptCopyName('suggestions', '0.4.0')) }]);
    expect(t.daemon.putBack).toBe(false);
    const loaded = t.daemon.internals.folder.loaded;
    expect(loaded.get('state')?.upgradedFrom).toBeNull();
    expect((loaded.get('state')?.value as StoredState).settings).toEqual(mended.settings);
    expect(t.ctx.settings.get()).toMatchObject({ maxLiveAgents: 5, agentMcp: true });
    expect(t.ctx.members.list({ includeKicked: true }).map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(membersOf(original));
    expect((await readFile(join(copy.workspaceDir, keptCopyName('suggestions', '0.4.0')))).equals(suggestionsBefore)).toBe(true);
    expect((await readdir(copy.workspaceDir)).filter((name) => name.includes('.before-upgrade-from-'))).toEqual([keptCopyName('suggestions', '0.4.0')]);
  });
});
