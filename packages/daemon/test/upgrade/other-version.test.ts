// The newest published smurg (0.6.0) and this smurg meet each other's folders (DESIGN "What 0.5.1 must NOT change":
// every document is written exactly as the published smurg writes it; the stamp says which smurg wrote the folder
// last, and the kept copies stay as they are). Each case is stated over the numbers of each side (DESIGN 0.7.0 D1):
// the `shapes` the tag's daemon writes (WORKSPACE_SHAPES of its tree) and the ones this smurg writes. While they are
// equal, what this smurg wrote opens there with no step and opens here again; once this smurg writes more (a step it
// has and the tag has not), the tag refuses that folder as written by a newer smurg ("Run smurg update. Nothing was
// changed.") and changes nothing in it, and this smurg opens what the tag wrote and upgrades it.
//
// The other side here is THE CODE OF TAG v0.6.0 itself (the newest published smurg), not a description of it:
// `git archive v0.6.0` of the daemon and the protocol package into a scratch folder, run with node
// (test/upgrade/published-runner.ts starts that tree's daemon on a folder). Two tests are about what 0.5.0 did with a
// folder of 0.4.0 (it refused it, and what it left behind when it refused must open here): they run the code of tag
// v0.5.0 the same way. A scratch tree gets its dependencies from this checkout's node_modules: the versions are the
// same as long as the lockfile entries of the two packages are (they are for 0.6.0); when a dependency is raised,
// the old code runs with the new one here, and the opt-in test with the published executables
// (packages/cli/test/sea-upgrade.test.ts) is the one that runs the old code exactly as it shipped.
//
// The tags must be at hand: this repository's git with the tags (`GIT_DIR` works), or a folder
// `$SMURG_PUBLISHED_TREES/<tag>/` for each (v0.6.0, v0.5.0) that holds `packages/daemon` and `packages/protocol` of
// the tag. A checkout without tags (a shallow clone) SKIPS these tests and says so; for the release
// (SMURG_RELEASE_GATE=1) the tags must be there and a missing one fails.
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STATE_VERSION } from '../../src/core/workspace-state.ts';
import { WORKSPACE_SHAPES } from '../../src/core/state-store.ts';
import { createTempDir, removeTempDir, type TestDaemon } from '../../src/testing/index.ts';
import { startOn } from './daemon-on.ts';
import { STAMP_NAME, copyOf, everythingOf, keptCopyName, readJson, snapshotOf, type FixtureCopy, type StoredState } from './fixture.ts';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = join(HERE, '..', '..');
const REPO = join(DAEMON_DIR, '..', '..');
const TAG = 'v0.6.0';
/** The published smurg that refused what 0.4.0 left (the owner met it, FOUND-REAL t02): the two tests of that refusal run its code. */
const REFUSING_TAG = 'v0.5.0';
const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';
const MIB = 1024 * 1024;

/** A tree of a tag: its daemon package, the `shapes` its daemon writes and the `version` of its state.json. */
type Tree = { readonly daemon: string; readonly shapes: number; readonly stateVersion: number } | { readonly missing: string };

/** A constant of the tag's own source (`export const NAME = <number>;`): what that side's code writes. */
async function numberIn(file: string, name: string): Promise<number> {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(await readFile(file, 'utf8'));
  if (match === null) throw new Error(`${name} is not in ${file}`);
  return Number(match[1]);
}

/** The tag's `packages/daemon` and `packages/protocol` in a scratch folder, or why they cannot be had. */
async function publishedTree(tag: string, into: string): Promise<Tree> {
  const given = process.env['SMURG_PUBLISHED_TREES'];
  if (given !== undefined && given !== '') {
    try {
      for (const name of ['daemon', 'protocol']) await cp(join(given, tag, 'packages', name), join(into, 'packages', name), { recursive: true, filter: (source) => !source.split('/').includes('node_modules') });
    } catch (err) {
      return { missing: `SMURG_PUBLISHED_TREES is set and ${join(given, tag)} does not hold packages/daemon and packages/protocol (${err instanceof Error ? err.message : 'unknown'})` };
    }
  } else {
    try {
      // `git archive <tag> <paths> | tar -x`, without a shell.
      const archive = join(into, 'tag.tar');
      await run('git', ['-C', REPO, 'archive', '--format=tar', '-o', archive, tag, 'packages/daemon', 'packages/protocol'], { maxBuffer: 64 * MIB });
      await run('tar', ['-xf', archive, '-C', into]);
    } catch (err) {
      return { missing: `git archive ${tag} failed in ${REPO} (no git, no tag: a shallow checkout?): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}` };
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
  if (`v${version}` !== tag) return { missing: `the tree for ${tag} says it is ${version}` };
  const daemon = join(into, 'packages', 'daemon');
  // Before 0.5.1 nothing stamped a folder and state.json had no version beyond 1.
  const shapes = await numberIn(join(daemon, 'src', 'core', 'state-store.ts'), 'WORKSPACE_SHAPES').catch(() => 0);
  const stateVersion = await numberIn(join(daemon, 'src', 'core', 'workspace-state.ts'), 'STATE_VERSION').catch(() => 1);
  return { daemon, shapes, stateVersion };
}

interface Opened {
  readonly ok: boolean;
  /** With a refusal: the StateFileError's kind (`newer`, …). */
  readonly kind?: string;
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
const trees: Record<string, Tree> = { [TAG]: { missing: 'not looked for yet' }, [REFUSING_TAG]: { missing: 'not looked for yet' } };
let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];

beforeAll(async () => {
  scratch = await createTempDir('published-tree');
  for (const tag of [TAG, REFUSING_TAG]) {
    await mkdir(join(scratch, tag));
    trees[tag] = await publishedTree(tag, join(scratch, tag));
  }
}, 180_000);
afterAll(async () => {
  if (scratch !== null) await removeTempDir(scratch);
});
afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) await copy.remove().catch(() => {});
});

/** The daemon of the tag, started on the copy and stopped again: what it read, or its refusal. */
async function openedByTheTag(copy: FixtureCopy, at: number, tag: string = TAG): Promise<Opened> {
  const tree = trees[tag] as Tree;
  if (!('daemon' in tree)) throw new Error(tree.missing);
  const child = await run(process.execPath, ['test/upgrade/published-runner.ts', copy.hostHome, copy.workspaceId, copy.project, String(at)], {
    cwd: tree.daemon,
    env: { ...process.env, SMURG_NO_BROWSER: '1' },
    timeout: 90_000,
    maxBuffer: 16 * MIB,
  }).catch((err: { stdout?: string; stderr?: string; message: string }) => ({ stdout: err.stdout ?? '', stderr: `${err.stderr ?? ''}\n${err.message}` }));
  const line = child.stdout.split('\n').find((candidate) => candidate.startsWith('RESULT '));
  if (line === undefined) throw new Error(`the daemon of ${tag} gave no result:\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(line.slice('RESULT '.length)) as Opened;
}

const membersOf = (state: StoredState): string[] => state.members.map((member) => `${member.userId} ${member.role} ${member.status}`);
/** The numbers of the tag's daemon (its tree is at hand when this is called). */
const tagSide = (): { readonly shapes: number; readonly stateVersion: number } => {
  const tree = trees[TAG] as Tree;
  if (!('daemon' in tree)) throw new Error(tree.missing);
  return { shapes: tree.shapes, stateVersion: tree.stateVersion };
};
/** What a start of THIS smurg upgrades in the folder a published version left (the steps this tree has beyond it). */
const upgradedHereFrom = (version: string): string[] => (version === '0.4.0' ? ['state', 'suggestions'] : version === '0.6.0' ? [] : ['state', 'agent-sessions']);
/** The kept copies a start of this smurg leaves in that folder. */
const keptHereFrom = (version: string): string[] =>
  version === '0.4.0' ? [keptCopyName('state', '0.4.0'), keptCopyName('suggestions', '0.4.0')] : version === '0.6.0' ? [] : [keptCopyName('state', '0.5.0'), keptCopyName('agent-sessions', '0.5.0')];
const keptOf = async (dir: string): Promise<Record<string, string>> => Object.fromEntries(Object.entries(await snapshotOf(dir)).filter(([name]) => name.includes('.before-upgrade-from-') || name === `./${STAMP_NAME}`));
const copiesOf = async (dir: string): Promise<Record<string, string>> => Object.fromEntries(Object.entries(await keptOf(dir)).filter(([name]) => name !== `./${STAMP_NAME}`));
/** Why a test of the two tags cannot run here, or null. */
const missing = (...tags: string[]): string | null => {
  for (const tag of tags) {
    const tree = trees[tag] as Tree;
    if (!('daemon' in tree)) return tree.missing;
  }
  return null;
};

describe(`smurg ${TAG.slice(1)} and this smurg open each other's folders (the code of the tag, from git archive)`, { timeout: 180_000 }, () => {
  it.runIf(RELEASE_GATE)('for the release the code of the tag must be at hand', () => {
    expect(trees[TAG]).toHaveProperty('daemon');
    expect(trees[REFUSING_TAG]).toHaveProperty('daemon');
  });

  // Both trees: the tag's, and the one of 0.5.0 for the two tests of its refusal.
  it('the tag is at hand, or this checkout says why these tests are skipped', (context) => {
    const why = missing(TAG, REFUSING_TAG);
    if (why !== null) context.skip(why);
    expect(trees[TAG]).toHaveProperty('daemon');
    expect(trees[REFUSING_TAG]).toHaveProperty('daemon');
  });

  it('the tag\'s daemon really is the other side: it upgrades what 0.4.0 left, keeps the two files as they were and stamps the folder with its own version', async (context) => {
    const why = missing(TAG);
    if (why !== null) context.skip(why);
    const copy = await copyOf('0.4.0');
    copies.push(copy);
    const state = await readFile(join(copy.workspaceDir, 'state.json'));
    const suggestions = await readFile(join(copy.workspaceDir, 'suggestions.json'));
    const opened = await openedByTheTag(copy, copy.at);
    expect(opened.message, 'the refusal of the tag\'s daemon').toBeUndefined();
    expect(opened).toMatchObject({ ok: true, smurg: TAG.slice(1), workspaceId: copy.workspaceId });
    expect(Object.keys(await copiesOf(copy.workspaceDir)).sort()).toEqual([`./${keptCopyName('state', '0.4.0')}`, `./${keptCopyName('suggestions', '0.4.0')}`]);
    expect((await readFile(join(copy.workspaceDir, keptCopyName('state', '0.4.0')))).equals(state)).toBe(true);
    expect((await readFile(join(copy.workspaceDir, keptCopyName('suggestions', '0.4.0')))).equals(suggestions)).toBe(true);
    expect(await readJson(join(copy.workspaceDir, STAMP_NAME))).toEqual({ smurg: TAG.slice(1), shapes: tagSide().shapes, at: expect.any(Number) });
  });

  it('smurg 0.5.0 refuses what 0.4.0 left, with the sentence the owner met', async (context) => {
    const why = missing(REFUSING_TAG);
    if (why !== null) context.skip(why);
    const copy = await copyOf('0.4.0');
    copies.push(copy);
    const opened = await openedByTheTag(copy, copy.at, REFUSING_TAG);
    expect(opened).toEqual({
      ok: false,
      name: 'StateFileError',
      message: `state file does not match its schema (settings.maxLiveAgents: Invalid input: expected number, received undefined; settings.escalateAfterMs: Invalid input: expected number, received undefined; settings.agentMcp: Invalid input: expected boolean, received undefined): ${join(copy.workspaceDir, 'state.json')}`,
    });
  });

  it.for(['0.4.0', '0.5.0', '0.5.1', '0.5.2', '0.6.0'] as const)('what this smurg wrote over the folder %s left: refused by the tag\'s code (changing nothing) when this smurg writes more shapes than the tag, else opened there with no step; and it opens here again', async (version, context) => {
    const why = missing(TAG);
    if (why !== null) context.skip(why);
    const copy = await copyOf(version);
    copies.push(copy);
    const before = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));

    // ---- This smurg shares the folder and stops: it upgrades what the version wrote (its steps beyond that version), once.
    let t = (running = await startOn(copy));
    expect(t.daemon.upgraded.map((entry) => entry.document)).toEqual(upgradedHereFrom(version));
    const fingerprint = t.daemon.fingerprint;
    await t.cleanup();
    running = null;
    const written = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    expect(written.version).toBe(STATE_VERSION);
    const kept = await keptOf(copy.workspaceDir);
    expect(Object.keys(kept).sort()).toEqual([...keptHereFrom(version).map((name) => `./${name}`), `./${STAMP_NAME}`].sort());
    const stamp = await readJson<{ smurg: string; shapes: number; at: number }>(join(copy.workspaceDir, STAMP_NAME));
    expect(stamp).toMatchObject({ shapes: WORKSPACE_SHAPES });

    const untouched = await everythingOf(copy);
    const opened = await openedByTheTag(copy, copy.at + 60_000);
    if (WORKSPACE_SHAPES > tagSide().shapes) {
      // ---- The tag's daemon refuses that folder as written by a newer smurg (its stamp's shapes), before it reads a
      // document, and changes nothing: not the stamp, not a document, not a kept copy (the command then says "Run
      // smurg update. Nothing was changed.").
      expect(opened).toMatchObject({ ok: false, name: 'StateFileError', kind: 'newer' });
      expect(opened.message).toMatch(/^this workspace folder was last written by a newer smurg \(/);
      expect((await everythingOf(copy)).workspace).toEqual(untouched.workspace);
      expect(await readJson(join(copy.workspaceDir, STAMP_NAME))).toEqual(stamp);
    } else {
      // ---- The same shapes on both sides: the tag's daemon opens it with no step (no new kept copy), everybody there,
      // and stamps it with its own version.
      expect(opened.message, 'the refusal of the tag\'s daemon').toBeUndefined();
      expect(opened).toMatchObject({ ok: true, smurg: TAG.slice(1), workspaceId: copy.workspaceId, fingerprint, members: membersOf(before) });
      expect(await copiesOf(copy.workspaceDir)).toEqual(Object.fromEntries(Object.entries(kept).filter(([name]) => name !== `./${STAMP_NAME}`)));
      expect(await readJson(join(copy.workspaceDir, STAMP_NAME))).toEqual({ smurg: TAG.slice(1), shapes: tagSide().shapes, at: expect.any(Number) });
    }
    const stampNow = await readJson<{ smurg: string; shapes: number; at: number }>(join(copy.workspaceDir, STAMP_NAME));
    const writtenNow = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));

    // ---- And this smurg opens it again: no step, nothing put back, everybody still there.
    t = running = await startOn(copy);
    expect(t.daemon.upgraded).toEqual([]);
    expect(t.daemon.putBack).toBe(false);
    expect(t.daemon.internals.folder.loaded.get('state')?.value).toEqual(writtenNow);
    expect(t.daemon.internals.folder.stamp).toEqual(stampNow);
    expect(t.ctx.members.list({ includeKicked: true }).map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(membersOf(before));
    expect(t.daemon.fingerprint).toBe(fingerprint);
    expect((await stat(join(copy.workspaceDir, STAMP_NAME))).isFile()).toBe(true);
  });

  it.for(['0.4.0', '0.5.0', '0.5.1', '0.5.2', '0.6.0'] as const)('what the tag wrote over the folder %s left opens here: this smurg runs the steps it has beyond the tag (none while both write the same shapes), the tag\'s stamp is read', async (version, context) => {
    const why = missing(TAG);
    if (why !== null) context.skip(why);
    const copy = await copyOf(version);
    copies.push(copy);
    const before = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    // ---- The tag shares it first (what an earlier version wrote it upgrades with its own steps).
    const opened = await openedByTheTag(copy, copy.at + 60_000);
    expect(opened.message, 'the refusal of the tag\'s daemon').toBeUndefined();
    expect(opened).toMatchObject({ ok: true, smurg: TAG.slice(1), workspaceId: copy.workspaceId });
    const stamp = await readJson<{ smurg: string; shapes: number; at: number }>(join(copy.workspaceDir, STAMP_NAME));
    expect(stamp).toEqual({ smurg: TAG.slice(1), shapes: tagSide().shapes, at: expect.any(Number) });
    const tagState = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    expect(tagState.version).toBe(tagSide().stateVersion);

    // ---- This smurg: the steps it has beyond the tag, each from the tag's shape and naming the tag as the writer.
    const t = (running = await startOn(copy));
    expect(t.daemon.internals.folder.stamp).toEqual(stamp);
    if (WORKSPACE_SHAPES > tagSide().shapes) {
      expect(t.daemon.upgraded.length).toBeGreaterThan(0);
      for (const entry of t.daemon.upgraded) expect(entry.writer, entry.document).toBe(TAG.slice(1));
    } else expect(t.daemon.upgraded).toEqual([]);
    expect(t.daemon.putBack).toBe(false);
    expect(t.ctx.settings.get()).toMatchObject({ ...tagState.settings });
    expect(t.ctx.settings.notices()).toEqual(tagState.hostNotices ?? []);
    expect(t.ctx.members.list({ includeKicked: true }).map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(membersOf(before));
  });

  it('what the daemon of 0.5.0 left behind when it refused a 0.4.0 folder whose owner had added the three settings by hand opens here', async (context) => {
    const why = missing(REFUSING_TAG);
    if (why !== null) context.skip(why);
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

    const refused = await openedByTheTag(copy, copy.at, REFUSING_TAG);
    expect(refused).toMatchObject({ ok: false, name: 'StateFileError' });
    expect(refused.message).toMatch(/^state file does not match its schema \(suggestions\.0\.origin: /);
    expect(refused.message?.endsWith(join(copy.workspaceDir, 'suggestions.json'))).toBe(true);
    // What it wrote before it refused (this is why a refusal of this smurg reads everything first).
    expect(await readdir(copy.workspaceDir)).toEqual(expect.arrayContaining(['agent-sessions.json', 'audit-text.jsonl', 'cards.json', 'claude-trust.json', 'host-rules.json', 'inbox.json']));
    expect((await readFile(join(copy.workspaceDir, 'suggestions.json'))).equals(suggestionsBefore)).toBe(true);

    // This smurg: each document by its own shape. state.json is 0.5.0's (the owner's values stand, agentMcp too: the
    // step from 0.4.0 does not run over what a host wrote; the step from 0.5.0 adds auto mode), suggestions.json is
    // 0.4.0's and is upgraded; the agent-sessions.json 0.5.0 made holds no session: today's shape as it is.
    const t = (running = await startOn(copy));
    expect(t.daemon.upgraded.map((entry) => `${entry.document} from ${entry.from}`)).toEqual(['state from 0.5.0', 'suggestions from 0.4.0']);
    expect(t.daemon.putBack).toBe(false);
    const loaded = t.daemon.internals.folder.loaded;
    expect(loaded.get('state')?.upgradedFrom).toBe('0.5.0');
    expect((loaded.get('state')?.value as StoredState).settings).toEqual({ ...mended.settings, permissionMode: 'auto' });
    expect(t.ctx.settings.get()).toMatchObject({ maxLiveAgents: 5, agentMcp: true, permissionMode: 'auto' });
    expect(t.ctx.members.list({ includeKicked: true }).map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(membersOf(original));
    expect((await readFile(join(copy.workspaceDir, keptCopyName('suggestions', '0.4.0')))).equals(suggestionsBefore)).toBe(true);
    expect((await readdir(copy.workspaceDir)).filter((name) => name.includes('.before-upgrade-from-')).sort()).toEqual([keptCopyName('state', '0.5.0'), keptCopyName('suggestions', '0.4.0')].sort());
  });
});
