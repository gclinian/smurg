// An upgrade that did not finish, on what the published 0.4.0 really left (0.5.1, the last fixes: V1-1, V2-2, V1-3,
// V1-5, V1-6), on what the published 0.5.2 left (0.6.0: its state.json and agent-sessions.json are upgraded, the
// owner's decision; a kill between the two is the same story, DESIGN 0.6.0 D21), and on what the published 0.6.0 left
// (0.7.0: its state.json is upgraded to automatic merging, the owner's words of 2026-10-26; a kill before, between and
// after its writes, DESIGN 0.7.0 D4).
//
// The first `smurg host` after the update is the one start that upgrades. When it ended between its writes (a kill,
// a full disk, something in the way of a kept copy), the host met two untruths: the refused start said "Nothing was
// changed." although the stamp, and sometimes a rewritten state.json, were on disk; and the NEXT start, the first
// real upgrade, warned that an OLDER state.json had been put back and that every removal and revoked link since was
// undone. Nothing had been put back. The warning sends a host through members, roles and links for no reason, at the
// one moment they read closely.
//
//   - What can be known before a start writes is looked at before it writes: the names of the kept copies. Something
//     in the way of one refuses in phase 1, and the WHOLE copy of the fixture is byte for byte as it was.
//   - What cannot (a kill, a disk that fills while it writes): the stamp says what is under way, and the next start
//     finishes it and reports the upgrade. A put back is said only for a stamp that names no upgrade under way.
//   - A refusal that does come while a start writes says so (`phase: 2`).
//
// The unit tests of the same rules, on small hand-made folders: test/workspace-folder.test.ts.
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultHostSettings } from '../../src/core/config.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { WORKSPACE_SHAPES } from '../../src/core/state-store.ts';
import { readWorkspaceFolder, writeWorkspaceFolder } from '../../src/core/workspace-folder.ts';
import { DAEMON_VERSION, declaredDocuments } from '../../src/daemon.ts';
import type { TestDaemon } from '../../src/testing/index.ts';
import { clockAt, startOn } from './daemon-on.ts';
import { STAMP_NAME, copyOf, everythingOf, keptCopyName, readJson, type FixtureCopy, type StoredState } from './fixture.ts';

type Json = Record<string, unknown>;

let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];
afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) {
    await chmod(copy.workspaceDir, 0o700).catch(() => {});
    await copy.remove().catch(() => {});
  }
});

/** Published folders whose first start of this smurg upgrades documents, and what each one's start upgrades. */
interface Upgraded {
  readonly version: '0.4.0' | '0.5.2' | '0.6.0';
  /** The documents, in the order a start writes them. */
  readonly documents: readonly string[];
  /** The step they are upgraded from (the kept copies' name). */
  readonly from: '0.4.0' | '0.5.0' | '0.6.0';
}
const UPGRADED: readonly Upgraded[] = [
  { version: '0.4.0', documents: ['state', 'suggestions'], from: '0.4.0' },
  { version: '0.5.2', documents: ['state', 'agent-sessions'], from: '0.5.0' },
  { version: '0.6.0', documents: ['state'], from: '0.6.0' },
];

/** Where a start may die: after the stamp, after each kept copy and after each document, in the order it writes them. */
function killPoints(documents: readonly string[]): [string, string][] {
  return [
    ['stamp', 'between the stamp and the first document'],
    ...documents.flatMap((document, index): [string, string][] => [
      [`copy:${document}`, `after the kept copy of ${document}.json, before ${document}.json`],
      [`document:${document}`, index < documents.length - 1 ? 'between two documents' : 'after the last document, before the stamp was written again'],
    ]),
  ];
}

/** What a version left while it was running (what a crash leaves): live sessions, launch files, pending suggestions. */
async function left(version: Upgraded['version'] = '0.4.0'): Promise<FixtureCopy> {
  const copy = await copyOf(version, 'running');
  copies.push(copy);
  await mkdir(join(copy.project, '.smurg', 'uploads'), { recursive: true, mode: 0o700 }); // a start makes it before it reads anything
  return copy;
}

class Died extends Error {}

/** The start of `smurg host`, as far as the workspace folder goes, DYING right after one of its writes. */
async function startThatDiesAfter(copy: FixtureCopy, write: string): Promise<void> {
  const documents = declaredDocuments({ workspaceId: copy.workspaceId, defaultSettings: defaultHostSettings(totalmem()) });
  const reading = await readWorkspaceFolder({ dir: copy.workspaceDir, log: silentLogger, documents, env: { memoryBytes: totalmem() }, smurg: DAEMON_VERSION, workspaceId: copy.workspaceId });
  const died = writeWorkspaceFolder(reading, {
    log: silentLogger,
    clock: clockAt(copy.at),
    interrupt: (written) => {
      if (written === write) throw new Died(write);
    },
  });
  await expect(died).rejects.toBeInstanceOf(Died);
}

async function refusalOf(copy: FixtureCopy): Promise<Json> {
  try {
    running = await startOn(copy);
  } catch (err) {
    return err as Json;
  }
  throw new Error('the daemon STARTED on a folder it must refuse');
}

const membersOf = (state: StoredState): string[] => state.members.map((member) => `${member.userId} ${member.role} ${member.status}`);

type OldBytes = Readonly<Record<string, Buffer>>;

/**
 * The next `smurg host`: it upgrades, says so, and everybody is who they were. (Who wrote the folder before is not
 * said: the stamp named a start that did not finish, or the folder had none.)
 */
async function theNextStartIsTheUpgrade(copy: FixtureCopy, asLeft: StoredState, oldBytes: OldBytes, upgraded: Upgraded = UPGRADED[0] as Upgraded): Promise<void> {
  const t = (running = await startOn(copy));
  expect(t.daemon.putBack, 'NOTHING WAS PUT BACK: this is the first upgrade of the folder').toBe(false);
  expect(t.daemon.upgraded.map(({ writer: _writer, ...entry }) => entry)).toEqual(upgraded.documents.map((document) => ({ document, from: upgraded.from, copy: join(copy.workspaceDir, keptCopyName(document, upgraded.from)) })));
  expect(t.ctx.members.list({ includeKicked: true }).map((member) => `${member.userId} ${member.role} ${member.status}`)).toEqual(membersOf(asLeft));
  expect(t.ctx.members.list({ includeKicked: true }).flatMap((member) => t.daemon.internals.members.devicesOf(member.userId)).filter((device) => device.revoked).map((device) => device.deviceId).sort()).toEqual(asLeft.devices.filter((device) => device.revoked).map((device) => device.deviceId).sort());
  for (const invite of asLeft.invites) expect(t.ctx.invites.list().map((listed) => listed.id), invite.id).toContain(invite.id);
  // The files as the version left them are kept, once each, whichever start made the copy.
  for (const document of upgraded.documents) expect((await readFile(join(copy.workspaceDir, keptCopyName(document, upgraded.from)))).equals(oldBytes[document] as Buffer), document).toBe(true);
  expect((await readdir(copy.workspaceDir)).filter((name) => name.includes('.before-upgrade-from-')).sort()).toEqual(upgraded.documents.map((document) => keptCopyName(document, upgraded.from)).sort());
  expect(await readJson<Json>(join(copy.workspaceDir, STAMP_NAME))).toEqual({ smurg: DAEMON_VERSION, shapes: WORKSPACE_SHAPES, at: expect.any(Number) });
  // The workspace's mode is auto now and its work items merge by themselves, and the host is told (DESIGN 0.6.0 D6,
  // D13; DESIGN 0.7.0 D4): 0.6.0's own notices stay, the steps add theirs.
  expect(t.ctx.settings.get().permissionMode).toBe('auto');
  expect(t.ctx.settings.get().merging).toBe('auto');
  expect(t.ctx.settings.notices()).toEqual(upgraded.version === '0.6.0' ? [...new Set([...(asLeft.hostNotices ?? []), 'auto-merge'])] : ['agents-auto', 'auto-merge']);
  await t.cleanup();
  running = null;
  // And the start after that is an ordinary one.
  const again = (running = await startOn(copy));
  expect(again.daemon.upgraded).toEqual([]);
  expect(again.daemon.putBack).toBe(false);
}

const oldBytesOf = async (copy: FixtureCopy, upgraded: Upgraded = UPGRADED[0] as Upgraded): Promise<OldBytes> =>
  Object.fromEntries(await Promise.all(upgraded.documents.map(async (document) => [document, await readFile(join(copy.workspaceDir, `${document}.json`))] as const)));

describe.each(UPGRADED)('the first upgrade of what smurg $version left, killed after each of its writes', { timeout: 120_000 }, (upgraded) => {
  it.each(killPoints(upgraded.documents))('killed after %s (%s): the next start finishes the upgrade and says UPGRADE, never "an older file was put back"', async (write) => {
    const copy = await left(upgraded.version);
    const asLeft = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    const old = await oldBytesOf(copy, upgraded);
    await startThatDiesAfter(copy, write);
    // The stamp of the start that died names what it had under way.
    expect(await readJson<Json>(join(copy.workspaceDir, STAMP_NAME))).toMatchObject({
      smurg: DAEMON_VERSION,
      shapes: WORKSPACE_SHAPES,
      pending: upgraded.documents.map((document) => ({ document, from: upgraded.from, copy: keptCopyName(document, upgraded.from) })),
    });
    await theNextStartIsTheUpgrade(copy, asLeft, old, upgraded);
  });
});

describe('the first upgrade of what smurg 0.4.0 left, when the start that does it does not finish', { timeout: 120_000 }, () => {
  describe.each(['state', 'suggestions'])('something is in the way of the kept copy of %s.json', (document) => {
    const ways: Readonly<Record<string, { make(path: string, copy: FixtureCopy): Promise<void>; refusal: Json; cure(path: string): Promise<void> }>> = {
      'a symlink to a file of the host': {
        make: async (path, copy) => {
          await writeFile(join(copy.root, 'victim.txt'), 'the host\'s own file\n', { mode: 0o600 });
          await symlink(join(copy.root, 'victim.txt'), path);
        },
        refusal: { kind: 'insecure', cause: 'symlink' },
        cure: (path) => rm(path),
      },
      'a folder': { make: (path) => mkdir(path, { mode: 0o700 }), refusal: { kind: 'insecure', cause: 'not-a-file' }, cure: (path) => rm(path, { recursive: true }) },
      'a FIFO': { make: async (path) => void execFileSync('/usr/bin/mkfifo', ['-m', '600', path]), refusal: { kind: 'insecure', cause: 'not-a-file' }, cure: (path) => rm(path) },
      'a file others can read': {
        make: async (path) => {
          await writeFile(path, '{"other": true}\n', { mode: 0o644 });
          await chmod(path, 0o644);
        },
        refusal: { kind: 'insecure', cause: 'mode', mode: 0o644 },
        cure: (path) => rm(path),
      },
      'ninety-nine copies with other bytes (no free name)': {
        make: async (path) => {
          await writeFile(path, 'x1\n', { mode: 0o600 });
          for (let n = 2; n <= 99; n++) await writeFile(`${path}-${n}`, `x${n}\n`, { mode: 0o600 });
        },
        refusal: { kind: 'cannot-open', errno: 'EEXIST' },
        cure: async (path) => {
          await rm(path);
          for (let n = 2; n <= 99; n++) await rm(`${path}-${n}`);
        },
      },
    };

    it.each(Object.keys(ways))('%s: refused in phase 1 and the WHOLE folder is byte for byte (no stamp, no copy, no rewritten document); with it gone the next start is the upgrade', async (how) => {
      const way = ways[how] as (typeof ways)[string];
      const copy = await left();
      const asLeft = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
      const old = await oldBytesOf(copy);
      const path = join(copy.workspaceDir, keptCopyName(document, '0.4.0'));
      await way.make(path, copy);
      const before = await everythingOf(copy);

      const refusal = await refusalOf(copy);
      expect(refusal).toMatchObject({ name: 'StateFileError', ...way.refusal, phase: 1 });
      expect(String(refusal['path']).startsWith(path)).toBe(true);
      const after = await everythingOf(copy);
      expect(after.workspace).toEqual(before.workspace);
      expect(after.all).toEqual(before.all);
      expect(await readdir(copy.workspaceDir)).not.toContain(STAMP_NAME);
      expect((await readFile(join(copy.workspaceDir, 'state.json'))).equals(old['state'] as Buffer)).toBe(true);

      await way.cure(path);
      await theNextStartIsTheUpgrade(copy, asLeft, old);
    });
  });

  it.skipIf(process.getuid?.() === 0)('the workspace folder cannot be written (a full or read-only disk): the refusal is of PHASE 2 (the command must not say "nothing was changed"); writable again, the next start is the upgrade', async () => {
    const copy = await left();
    const asLeft = await readJson<StoredState>(join(copy.workspaceDir, 'state.json'));
    const old = await oldBytesOf(copy);
    await chmod(copy.workspaceDir, 0o500);
    const refusal = await refusalOf(copy);
    expect(refusal).toMatchObject({ name: 'StateFileError', kind: 'cannot-open', errno: 'EACCES', phase: 2, path: join(copy.workspaceDir, STAMP_NAME) });
    await chmod(copy.workspaceDir, 0o700);
    await theNextStartIsTheUpgrade(copy, asLeft, old);
  });

  it('a REAL put back, after the upgrade finished, is still said', async () => {
    const copy = await left();
    const old = await oldBytesOf(copy);
    await (await startOn(copy)).cleanup();
    await writeFile(join(copy.workspaceDir, 'state.json'), old['state'] as Buffer, { mode: 0o600 });
    const t = (running = await startOn(copy));
    expect(t.daemon.putBack).toBe(true);
    expect(t.daemon.upgraded).toEqual([{ document: 'state', from: '0.4.0', copy: join(copy.workspaceDir, keptCopyName('state', '0.4.0')) }]);
  });
});

describe('the stamp and the kept copies, on what a published smurg left', { timeout: 120_000 }, () => {
  // One above this smurg's shapes (0.7.0 writes 3).
  const newer = WORKSPACE_SHAPES + 1;
  it.each([
    ['a version name of another form', { smurg: '0.8.0-rc.1', shapes: newer, at: 5 }, 0o600],
    ['one more key', { smurg: '0.8.0', shapes: newer, at: 5, relay: 'x' }, 0o600],
    ['a number above 1,000,000', { smurg: '9.0.0', shapes: 1_000_001, at: 5 }, 0o600],
    ['mode 0644 (a restore without modes)', { smurg: '0.8.0', shapes: newer, at: 5 }, 0o644],
  ] as const)(`a stamp of shapes ${newer} with %s: the folder is refused as \`newer\` and the stamp is NOT written over (V1-3)`, async (_how, stamp, mode) => {
    const copy = await left();
    const path = join(copy.workspaceDir, STAMP_NAME);
    await writeFile(path, `${JSON.stringify(stamp, null, 2)}\n`, { mode });
    await chmod(path, mode);
    const before = await everythingOf(copy);
    expect(await refusalOf(copy)).toMatchObject({ name: 'StateFileError', kind: 'newer', phase: 1, path: copy.workspaceDir });
    expect((await everythingOf(copy)).all).toEqual(before.all);
    expect(await readJson<Json>(path)).toEqual(stamp);
  });

  it('after a restore without modes, the ONE refusal names every file to chmod, the kept copies with them; after that chmod nothing smurg keeps in the folder is open to others (V1-5)', async () => {
    const copy = await left();
    await (await startOn(copy)).cleanup(); // the upgrade: two kept copies and the stamp are there now
    const names = (await readdir(copy.workspaceDir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining([keptCopyName('state', '0.4.0'), keptCopyName('suggestions', '0.4.0'), STAMP_NAME]));
    for (const name of names) await chmod(join(copy.workspaceDir, name), 0o644);

    const refusal = await refusalOf(copy);
    expect(refusal).toMatchObject({ kind: 'insecure', cause: 'mode', phase: 1 });
    const paths = refusal['paths'] as string[];
    expect(paths).toEqual(expect.arrayContaining([join(copy.workspaceDir, keptCopyName('state', '0.4.0')), join(copy.workspaceDir, keptCopyName('suggestions', '0.4.0'))]));
    for (const path of paths) await chmod(path, 0o600); // the one `chmod 600 …` the command prints
    const t = (running = await startOn(copy));
    expect(t.daemon.upgraded).toEqual([]);
    await t.cleanup();
    running = null;
    // Every file of the folder smurg reads or writes is private again (the stamp was written anew by the start).
    const open: string[] = [];
    for (const entry of await readdir(copy.workspaceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const known = entry.name === STAMP_NAME || entry.name === 'identity.key' || /^(audit|audit-text|activity)\.jsonl$/.test(entry.name) || entry.name.endsWith('.json') || entry.name.includes('.before-upgrade-from-');
      const mode = (await lstat(join(copy.workspaceDir, entry.name))).mode & 0o077;
      if (known && mode !== 0) open.push(entry.name);
    }
    expect(open).toEqual([]);
  });
});
