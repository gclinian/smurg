// A refused start leaves everything byte for byte (DESIGN A2): the whole workspace folder (names, modes, bytes),
// the launch files under ~/.smurg/sessions, the uploads, and the rest of the host's ~/.smurg.
//
// The folders are the ones a published smurg left WHILE IT WAS RUNNING (the `running` variant of each fixture: what a
// crash or a pulled plug leaves), made a little worse the way a hard death does it: the last line of audit.jsonl is
// torn, and an upload whose manifest cannot be read lies in both upload folders. Such a folder is full of things a
// start changes before its last document is read: the list of live sessions is emptied and their processes are
// looked for, the launch files are removed, the torn line is terminated, uploads that cannot be read are deleted,
// pending suggestions are closed, new documents and audit-text.jsonl are created, and (0.4.0) state.json and
// suggestions.json are upgraded. 0.5.0 did all of that and then refused at a later file (FOUND-REAL t02); what was
// left opened in neither version, and the advice was to move the folder away.
//
// Each case: the start is refused; nothing differs; the refusal says what kind it is and names the file; and with
// the one damaged thing put right, the same folder starts and only then is all of the above done.
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/core/logger.ts';
import { DEFAULT_FEATURE_MODULES, createDaemon } from '../../src/daemon.ts';
import { MEMORY_RELAY_ORIGIN, MemoryRelay, createTempDir, removeTempDir, type TestDaemon } from '../../src/testing/index.ts';
import { clockAt, startOn } from './daemon-on.ts';
import { PUBLISHED_VERSIONS, STAMP_NAME, copyOf, everythingOf, keptCopyName, readJson, type FixtureCopy, type PublishedVersion } from './fixture.ts';

let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];

afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) await copy.remove().catch(() => {});
});

/** What the start was refused with (fails when the daemon starts). */
async function refusalOf(copy: FixtureCopy): Promise<Record<string, unknown>> {
  try {
    running = await startOn(copy);
  } catch (err) {
    if (err instanceof Error) return err as unknown as Record<string, unknown>;
    throw err;
  }
  throw new Error('the daemon STARTED on a folder it must refuse');
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const TORN_LINE = '{"id":"au_torn","at":';
const UNREADABLE_UPLOAD = `up_${'a'.repeat(22)}`;

/** The `running` variant, as a hard death leaves it. */
async function crashed(version: PublishedVersion): Promise<FixtureCopy> {
  const copy = await copyOf(version, 'running');
  copies.push(copy);
  // The last audit line was being written (opening the log terminates it).
  await appendFile(join(copy.workspaceDir, 'audit.jsonl'), TORN_LINE);
  // An upload whose manifest this smurg cannot read, in the workspace folder and in the shared folder (the upload
  // store deletes such an upload at its start).
  await mkdir(join(copy.project, '.smurg', 'uploads'), { recursive: true, mode: 0o700 });
  for (const dir of [join(copy.workspaceDir, 'uploads'), join(copy.project, '.smurg', 'uploads')]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const ext of ['json', 'log', 'part']) await writeFile(join(dir, `${UNREADABLE_UPLOAD}.${ext}`), ext === 'json' ? '{"v": 2}\n' : 'data', { mode: 0o600 });
  }
  return copy;
}

interface Case {
  readonly name: string;
  /** Makes the folder one that must be refused; returns how to put that one thing right again. */
  damage(copy: FixtureCopy): Promise<() => Promise<void>>;
  /** What the refusal must say (`<dir>` is the workspace folder). */
  refusal(copy: FixtureCopy): Record<string, unknown>;
}

/** A document that one of the LAST modules opens: everything before it has been created and started by then. */
const LATER_DOCUMENT: Readonly<Record<PublishedVersion, string>> = { '0.4.0': 'suggestions', '0.5.0': 'topics' };

async function replaceDocument(copy: FixtureCopy, name: string, change: (value: Record<string, unknown>) => unknown): Promise<() => Promise<void>> {
  const path = join(copy.workspaceDir, `${name}.json`);
  const before = await readFile(path);
  const changed = change(JSON.parse(before.toString('utf8')) as Record<string, unknown>);
  await writeFile(path, typeof changed === 'string' ? changed : serialize(changed), { mode: 0o600 });
  return () => writeFile(path, before, { mode: 0o600 });
}

function casesOf(version: PublishedVersion): Case[] {
  const later = LATER_DOCUMENT[version];
  return [
    {
      name: 'a stamp of a smurg with newer shapes: the whole folder, before any document is read',
      damage: async (copy) => {
        await writeFile(join(copy.workspaceDir, STAMP_NAME), serialize({ smurg: '9.3.1', shapes: 2, at: copy.at }), { mode: 0o600 });
        return () => rm(join(copy.workspaceDir, STAMP_NAME));
      },
      refusal: (copy) => ({ kind: 'newer', path: copy.workspaceDir, writtenBy: '9.3.1' }),
    },
    {
      name: 'a document with a newer `version`',
      damage: (copy) => replaceDocument(copy, 'state', (value) => ({ ...value, version: 2 })),
      refusal: (copy) => ({ kind: 'newer', path: join(copy.workspaceDir, 'state.json') }),
    },
    {
      name: 'a damaged document: cut off in the middle (not JSON)',
      damage: (copy) => replaceDocument(copy, 'worktrees', (value) => serialize(value).slice(0, 120)),
      refusal: (copy) => ({ kind: 'unreadable', reason: 'not-json', path: join(copy.workspaceDir, 'worktrees.json') }),
    },
    {
      name: 'a damaged document: a member record without its role (no shape a published smurg wrote)',
      damage: (copy) =>
        replaceDocument(copy, 'state', (value) => {
          const members = (value['members'] as Record<string, unknown>[]).map((member, index) => (index === 1 ? Object.fromEntries(Object.entries(member).filter(([key]) => key !== 'role')) : member));
          return { ...value, members };
        }),
      refusal: (copy) => ({ kind: 'unreadable', reason: 'no-known-shape', path: join(copy.workspaceDir, 'state.json'), problems: [expect.stringMatching(/^members\.1\.role: /)], moreProblems: 0 }),
    },
    {
      name: 'a wrong mode: the key, a log and a document readable by others (every such path is named; none is chmod-ed)',
      damage: async (copy) => {
        const names = ['identity.key', 'audit.jsonl', `${later}.json`];
        for (const name of names) await chmod(join(copy.workspaceDir, name), 0o644);
        return async () => {
          for (const name of names) await chmod(join(copy.workspaceDir, name), 0o600);
        };
      },
      refusal: (copy) => ({ kind: 'insecure', cause: 'mode', mode: 0o644, path: join(copy.workspaceDir, 'identity.key'), paths: ['identity.key', 'audit.jsonl', `${later}.json`].map((name) => join(copy.workspaceDir, name)) }),
    },
    {
      name: 'the state file of another workspace',
      damage: (copy) => replaceDocument(copy, 'state', (value) => ({ ...value, workspaceId: 'ws_AnotherWorkspace0123w' })),
      refusal: (copy) => ({ kind: 'other-workspace', path: join(copy.workspaceDir, 'state.json') }),
    },
    {
      name: 'state.json missing beside the key (no empty workspace is made under the old key)',
      damage: async (copy) => {
        const path = join(copy.workspaceDir, 'state.json');
        await rename(path, join(copy.root, 'state.json.aside'));
        return () => rename(join(copy.root, 'state.json.aside'), path);
      },
      refusal: (copy) => ({ kind: 'unreadable', reason: 'missing', path: join(copy.workspaceDir, 'state.json') }),
    },
    {
      name: 'the key missing beside state.json (no new key is made: every teammate would see "the host computer\'s key has changed")',
      damage: async (copy) => {
        const path = join(copy.workspaceDir, 'identity.key');
        await rename(path, join(copy.root, 'identity.key.aside'));
        return () => rename(join(copy.root, 'identity.key.aside'), path);
      },
      refusal: (copy) => ({ kind: 'unreadable', reason: 'missing', path: join(copy.workspaceDir, 'identity.key') }),
    },
    {
      name: `a LATER document (${later}.json) that fails after every earlier one was read${version === '0.4.0' ? ' and state.json would have been upgraded' : ''}`,
      damage: (copy) => replaceDocument(copy, later, (value) => ({ ...value, [later]: [...(value[later] as unknown[]), { id: 'damaged' }] })),
      refusal: (copy) => ({ kind: 'unreadable', reason: 'no-known-shape', path: join(copy.workspaceDir, `${later}.json`) }),
    },
  ];
}

describe.each(PUBLISHED_VERSIONS)('a refused start leaves what smurg %s left while it was running byte for byte', { timeout: 60_000 }, (version) => {
  it('the folder is what a hard death leaves: live sessions, launch files, pending suggestions, a torn audit line, an upload that cannot be read', async () => {
    const copy = await crashed(version);
    const everything = await everythingOf(copy);
    expect((await readJson<{ live: unknown[] }>(join(copy.workspaceDir, 'sessions.json'))).live.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(everything.sessions).filter((name) => name.endsWith('/settings.json')).length).toBeGreaterThanOrEqual(1);
    expect((await readJson<{ suggestions: { status: string }[] }>(join(copy.workspaceDir, 'suggestions.json'))).suggestions.filter((entry) => entry.status === 'pending').length).toBeGreaterThanOrEqual(2);
    expect((await readFile(join(copy.workspaceDir, 'audit.jsonl'), 'utf8')).endsWith(TORN_LINE)).toBe(true);
    expect(Object.keys(everything.shareUploads)).toContain(`./${UNREADABLE_UPLOAD}.json`);
    expect(Object.keys(everything.workspace)).toContain(`./uploads/${UNREADABLE_UPLOAD}.part`);
    // No audit-text.jsonl where 0.4.0 wrote the folder (0.5.0 added it): a start creates it.
    expect(Object.keys(everything.workspace).includes('./audit-text.jsonl')).toBe(version !== '0.4.0');
    expect(Object.keys(everything.workspace)).not.toContain(`./${STAMP_NAME}`);
    expect(Object.keys(everything.all).filter((name) => /^\.\/host\/run\/[A-Za-z0-9]{12}\.pid$/.test(name))).toHaveLength(1);

    // And it is a folder this smurg STARTS on, doing all of that (so each refusal below is refused for its one reason).
    const t = (running = await startOn(copy));
    expect(await readJson(join(copy.workspaceDir, 'sessions.json'))).toEqual({ live: [] });
    expect(Object.keys((await everythingOf(copy)).sessions).filter((name) => name.endsWith('/settings.json'))).toEqual([]);
    expect((await readFile(join(copy.workspaceDir, 'audit.jsonl'), 'utf8')).includes(`${TORN_LINE}\n`)).toBe(true);
    const names = await readdir(copy.workspaceDir);
    expect(names).toEqual(expect.arrayContaining([STAMP_NAME, 'audit-text.jsonl', 'inbox.json']));
    expect((await readdir(join(copy.workspaceDir, 'uploads'))).filter((name) => name.startsWith(UNREADABLE_UPLOAD))).toEqual([]);
    expect((await readdir(join(copy.project, '.smurg', 'uploads'))).filter((name) => name.startsWith(UNREADABLE_UPLOAD))).toEqual([]);
    expect(t.daemon.upgraded.map((entry) => entry.document)).toEqual(version === '0.4.0' ? ['state', 'suggestions'] : []);
  });

  it.each(casesOf(version))('$name', async (one) => {
    const copy = await crashed(version);
    const repair = await one.damage(copy);
    const before = await everythingOf(copy);

    const refusal = await refusalOf(copy);
    const after = await everythingOf(copy);
    // Names, modes, bytes: the workspace folder with its uploads, ~/.smurg/sessions, the uploads in the shared folder;
    // and then the whole copy: the rest of ~/.smurg with run/ (the process id file of the daemon that died) and
    // logs/, the member's own files, the shared folder.
    expect(after.workspace).toEqual(before.workspace);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.shareUploads).toEqual(before.shareUploads);
    expect(after.all).toEqual(before.all);
    // Said once more by name, for the reader of a failure: nothing of what a start makes is there.
    const names = await readdir(copy.workspaceDir);
    expect(names.filter((name) => name.includes('.before-upgrade-from-') || name.endsWith('.tmp'))).toEqual([]);
    if (!one.name.startsWith('a stamp')) expect(names).not.toContain(STAMP_NAME);
    expect((await readFile(join(copy.workspaceDir, 'audit.jsonl'), 'utf8')).endsWith(TORN_LINE)).toBe(true);

    // What the command words: the kind, the file, and what belongs to the kind.
    expect(refusal).toMatchObject({ name: 'StateFileError', ...one.refusal(copy) });

    // With that one thing put right, the same folder starts; nothing the refusal did stands in the way.
    await repair();
    const t = (running = await startOn(copy));
    expect(t.daemon.upgraded).toEqual((version === '0.4.0' ? ['state', 'suggestions'] : []).map((document) => ({ document, from: '0.4.0', copy: join(copy.workspaceDir, keptCopyName(document, '0.4.0')) })));
    expect(t.daemon.putBack).toBe(false);
  });

  it('nothing is written when the saved relay login is ANOTHER account than the workspace\'s host and a later document is refused (the security critic\'s probe P3b)', async () => {
    // Before anything else a start makes the logged-in account the host of the workspace and the host on file a
    // Viewer (ensureHost: the host changed their login). 0.5.0 did that, wrote state.json, and then refused a later
    // document: the folder it left had another host. This smurg reads everything first.
    const copy = await crashed(version);
    const repair = await replaceDocument(copy, LATER_DOCUMENT[version], (value) => ({ ...value, [LATER_DOCUMENT[version]]: [...(value[LATER_DOCUMENT[version]] as unknown[]), { id: 'damaged' }] }));
    const home = await createTempDir('upgrade-home');
    try {
      const before = await everythingOf(copy);
      const hostOnFile = (await readJson<{ members: { userId: string; role: string }[] }>(join(copy.workspaceDir, 'state.json'))).members.filter((member) => member.role === 'host').map((member) => member.userId);
      expect(hostOnFile).toEqual(['dev:host']);
      const relay = new MemoryRelay(copy.workspaceId);
      const shareAs = async (hostUserId: string): Promise<unknown> => {
        const daemon = await createDaemon({
          config: { stateDir: copy.hostHome, shareDir: copy.project, workspaceId: copy.workspaceId, hostUserId, hostName: 'Somebody Else', relayUrl: MEMORY_RELAY_ORIGIN, keepAwake: false },
          relay: { token: 'a-relay-session', socketFactory: relay.hostSocketFactory() },
          identityKeys: { get: () => null, refresh: async () => {} },
          modules: DEFAULT_FEATURE_MODULES,
          log: silentLogger,
          homeDir: home,
          clock: clockAt(copy.at),
        });
        try {
          await daemon.start();
        } finally {
          await daemon.stop().catch(() => {});
        }
        return null;
      };
      const refusal = await shareAs('dev:somebody-else').then(
        () => {
          throw new Error('the daemon STARTED on a folder it must refuse');
        },
        (err: unknown) => err,
      );
      const after = await everythingOf(copy);
      expect(after.workspace).toEqual(before.workspace);
      expect(after.all).toEqual(before.all);
      expect(refusal).toMatchObject({ name: 'StateFileError', kind: 'unreadable', reason: 'no-known-shape', path: join(copy.workspaceDir, `${LATER_DOCUMENT[version]}.json`) });
      await repair();
    } finally {
      await removeTempDir(home);
    }
  });
});
