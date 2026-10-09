// THE WIRE OF THIS TREE IS THE WIRE OF THE PUBLISHED TAG (0.5.1, the last fixes: V1-7).
//
// The relay serves ONE web app to everybody. A page built from this tree talks to hosts that still run the published
// smurg, and every message schema is strict: one added key in a payload, and that page cuts off every such host
// (and the other way round for a host that updated first). While PROTOCOL_VERSION is what the published smurg has,
// nothing a peer sends or accepts may differ from it. Nothing in the tree said so: the pin of the stored shapes hashes
// only what a stored schema is built from, and other-version.test.ts runs the tag's daemon on FOLDERS, not a message.
//
// Two things are compared with the protocol package of the tag itself (`git archive v0.5.0 packages/protocol`):
//   1. WHAT THE PACKAGE SAYS, as text, by the pin's own machinery (wire-runner.ts, run with plain node in each tree):
//      the protocol version; every registered message type with its direction, channel, capability, checks and
//      flags, and the shape of its payload and of its result; every schema and every data constant the tag exports
//      (limits, lists of values such as the audit actions and the activity kinds, patterns).
//   2. THE SOURCE. A rule written as code (a `.refine`, the bytes of a frame, how the handshake is read) is in no
//      such text. So every source file of the package is byte for byte the tag's, EXCEPT the ones named below, each
//      with the reason why it changes no byte a peer sends or accepts. A file that differs and is not named fails
//      with one question, as the pin does.
// When PROTOCOL_VERSION is raised the wire changes on purpose, and these comparisons no longer apply: the test says
// so and asks for nothing (peers of another version are refused at the handshake, with words).
//
// The tag must be at hand, as for other-version.test.ts: this repository's git with the tag (`GIT_DIR` works), or
// `$SMURG_PUBLISHED_TREES/v0.5.0/packages/protocol`. Without it these tests are SKIPPED and say so; for the release
// (SMURG_RELEASE_GATE=1) a missing tag FAILS. After a release, TAG moves to the new tag (docs/RELEASING.md).
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION } from '@smurg/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const PROTOCOL = join(REPO, 'packages', 'protocol');
const TAG = 'v0.5.0';
const RELEASE_GATE = process.env['SMURG_RELEASE_GATE'] === '1';
const MIB = 1024 * 1024;

const QUESTION =
  'DOES THIS CHANGE A BYTE A PEER SENDS OR ACCEPTS? Then it is a new protocol version (PROTOCOL_VERSION in packages/protocol/src/constants.ts): the page the relay serves to everybody would otherwise cut off every host that still runs the published smurg. If it does not: name the file in CHANGED_WITHOUT_A_WIRE_CHANGE with the reason.';

/**
 * packages/protocol/src/<file>: the source files that differ from the tag's, and why none of them changes the wire.
 * (Tests and fixtures of the package are not compared.)
 */
const CHANGED_WITHOUT_A_WIRE_CHANGE: Readonly<Record<string, string>> = {
  'codec.ts': 'decodeClientHello RETURNS the peer\'s protocol number when it is another version (what `smurg host` words its one line from). It reads the same bytes and nothing is encoded differently.',
  'browser/key-stores.ts': 'the browser\'s own key store (IndexedDB): a record written by a later page is no longer replaced by a new key. Nothing of it is ever sent.',
  'node/index.ts': 'exports assertPrivateDirectory (a look at a folder of the host\'s disk).',
  'node/key-file.ts': 'assertPrivateDirectory: checks owner and mode of a folder and creates nothing. Files on the host\'s disk, never on the wire.',
  'i18n/messages/topics.ts':
    'the Start blocker `plan.start.noGit` is gone (0.5.2: one message per reason, the worktree.unavailable.* ones). A message id is free-form wire text (messageRefSchema bounds its shape only) and travels with its English fallback: a page that does not know an id shows the fallback. No schema or message type changes.',
  'i18n/messages/worktrees.ts':
    'the worktree.unavailable.* sentences say what the host can do (0.5.2), three are new (noCommit, checkFailed, gitDirGone), gitNotFound and gitTooOld take parameters, and gitUnusable, worktree.mainNoCommits and worktree.worktreesDirUnusable are gone. The same free-form ids with their English fallback: a page of 0.5.1 renders an id it knows in its own words and shows the fallback for one it does not. No schema or message type changes.',
};

interface Line {
  readonly what: 'protocol version' | 'message' | 'schema' | 'constant';
  readonly [key: string]: unknown;
}

/** The tag's `packages/protocol` in a scratch folder (with this checkout's dependencies), or why it cannot be had. */
async function protocolOfTheTag(into: string): Promise<{ readonly dir: string } | { readonly missing: string }> {
  const given = process.env['SMURG_PUBLISHED_TREES'];
  if (given !== undefined && given !== '') {
    try {
      await cp(join(given, TAG, 'packages', 'protocol'), join(into, 'packages', 'protocol'), { recursive: true, filter: (source) => !source.split('/').includes('node_modules') });
    } catch (err) {
      return { missing: `SMURG_PUBLISHED_TREES is set and ${join(given, TAG)} does not hold packages/protocol (${err instanceof Error ? err.message : 'unknown'})` };
    }
  } else {
    try {
      const archive = join(into, 'tag.tar');
      await run('git', ['-C', REPO, 'archive', '--format=tar', '-o', archive, TAG, 'packages/protocol'], { maxBuffer: 64 * MIB });
      await run('tar', ['-xf', archive, '-C', into]);
    } catch (err) {
      return { missing: `git archive ${TAG} failed in ${REPO} (no git, no tag: a shallow checkout?): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}` };
    }
  }
  const dir = join(into, 'packages', 'protocol');
  const to = join(dir, 'node_modules');
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(join(PROTOCOL, 'node_modules'))) {
    if (entry === '.bin' || entry === '.vite') continue;
    await symlink(join(PROTOCOL, 'node_modules', entry), join(to, entry));
  }
  const version = (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  if (`v${version}` !== TAG) return { missing: `the tree for ${TAG} says it is ${version}` };
  return { dir };
}

/** What a protocol package says about the wire, as text: one process of plain node per package, the same runner. */
async function saidBy(protocolDir: string): Promise<Line[]> {
  const { stdout } = await run(process.execPath, [join(HERE, 'wire-runner.ts'), join(protocolDir, 'src', 'index.ts')], { maxBuffer: 64 * MIB, timeout: 60_000 });
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Line);
}

/** Every source file below `dir` (no tests, no fixtures, no test helpers): relative path -> its bytes. */
async function sourcesOf(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (path: string): Promise<void> => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'testing' && entry.name !== 'node_modules') await walk(full);
      } else if (!entry.name.endsWith('.test.ts') && !entry.name.endsWith('.fixture.ts')) out.set(relative(dir, full), await readFile(full));
    }
  };
  await walk(dir);
  return out;
}

let scratch: string | null = null;
let tag: { readonly dir: string } | { readonly missing: string } = { missing: 'not looked for yet' };
let ofTheTag: Line[] = [];
let ofThisTree: Line[] = [];

beforeAll(async () => {
  scratch = await createTempDir('published-wire');
  tag = await protocolOfTheTag(scratch);
  if ('dir' in tag) [ofTheTag, ofThisTree] = await Promise.all([saidBy(tag.dir), saidBy(PROTOCOL)]);
}, 180_000);
afterAll(async () => {
  if (scratch !== null) await removeTempDir(scratch);
});

const versionOf = (lines: readonly Line[]): unknown => lines.find((line) => line.what === 'protocol version')?.['value'];

describe(`the wire of this tree is the wire of smurg ${TAG.slice(1)} (the protocol package of the tag, from git archive)`, { timeout: 180_000 }, () => {
  it.runIf(RELEASE_GATE)('for the release the protocol package of the tag must be at hand', () => {
    expect(tag).toHaveProperty('dir');
  });

  it('the tag is at hand, or this checkout says why these tests are skipped', (context) => {
    if (!('dir' in tag)) context.skip(tag.missing);
    expect(versionOf(ofThisTree)).toBe(PROTOCOL_VERSION);
    expect(typeof versionOf(ofTheTag)).toBe('number');
    // The runner really read two packages, and each says a lot.
    expect(ofTheTag.filter((line) => line.what === 'message').length).toBeGreaterThan(100);
    expect(ofThisTree.filter((line) => line.what === 'message').length).toBeGreaterThan(100);
  });

  /** Skips when the tag is not at hand, and when the protocol version was raised (the wire then changes on purpose). */
  const sameVersion = (context: { skip: (note?: string) => never }): void => {
    if (!('dir' in tag)) context.skip(tag.missing);
    const [theirs, ours] = [versionOf(ofTheTag) as number, versionOf(ofThisTree) as number];
    if (ours !== theirs) {
      expect(ours, 'a protocol version is only ever raised').toBeGreaterThan(theirs);
      context.skip(`PROTOCOL_VERSION is ${ours} here and ${theirs} in ${TAG}: the wire changed on purpose, and peers of the other version are refused at the handshake`);
    }
  };

  it('every registered message type: the same types in the same order, each with the same direction, channel, capability, checks and flags, and the same shape of its payload and of its result', (context) => {
    sameVersion(context);
    const messages = (lines: readonly Line[]): Map<string, Line> => new Map(lines.filter((line) => line.what === 'message').map((line) => [String(line['type']), line]));
    const [theirs, ours] = [messages(ofTheTag), messages(ofThisTree)];
    expect([...ours.keys()], `THE LIST OF MESSAGE TYPES DIFFERS FROM ${TAG}. ${QUESTION}`).toEqual([...theirs.keys()]);
    const differing = [...theirs.keys()].filter((type) => JSON.stringify(ours.get(type)) !== JSON.stringify(theirs.get(type)));
    expect(differing, `THESE MESSAGE TYPES DIFFER FROM ${TAG}. ${QUESTION}`).toEqual([]);
    // (Said once more for one of them, so that a failure shows a diff a person can read.)
    for (const type of differing.slice(0, 3)) expect(ours.get(type)).toEqual(theirs.get(type));
  });

  it('every schema and every data constant the tag exports (limits, the lists of audit actions, activity kinds and wire values, patterns) is exported here with the same shape or value', (context) => {
    sameVersion(context);
    const named = (lines: readonly Line[]): Map<string, string> => new Map(lines.filter((line) => line.what === 'schema' || line.what === 'constant').map((line) => [String(line['name']), JSON.stringify(line)]));
    const [theirs, ours] = [named(ofTheTag), named(ofThisTree)];
    expect(theirs.size).toBeGreaterThan(300);
    const gone = [...theirs.keys()].filter((name) => !ours.has(name));
    const differing = [...theirs.keys()].filter((name) => ours.has(name) && ours.get(name) !== theirs.get(name));
    expect({ gone, differing }, `EXPORTS OF THE PROTOCOL PACKAGE DIFFER FROM ${TAG}. ${QUESTION}`).toEqual({ gone: [], differing: [] });
  });

  it('every source file of the protocol package is byte for byte the tag\'s, except the ones named here with the reason why they change no byte on the wire', async (context) => {
    sameVersion(context);
    const theirs = await sourcesOf(join((tag as { dir: string }).dir, 'src'));
    const ours = await sourcesOf(join(PROTOCOL, 'src'));
    expect(theirs.size).toBeGreaterThan(50);
    const differing = [...new Set([...theirs.keys(), ...ours.keys()])].filter((file) => !(theirs.get(file)?.equals(ours.get(file) ?? Buffer.alloc(0)) ?? false) || !ours.has(file)).sort();
    expect(differing, `SOURCE FILES OF packages/protocol/src DIFFER FROM ${TAG} (or came, or went) while PROTOCOL_VERSION is still ${PROTOCOL_VERSION}. ${QUESTION}`).toEqual(Object.keys(CHANGED_WITHOUT_A_WIRE_CHANGE).sort());
    for (const [file, reason] of Object.entries(CHANGED_WITHOUT_A_WIRE_CHANGE)) expect(reason.trim(), file).not.toBe('');
  });
});
