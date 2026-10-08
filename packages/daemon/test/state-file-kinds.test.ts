// Every refusal of a file of the workspace folder has a KIND (core/state-file-error.ts; the table of throw sites is
// in the 0.5.1 contract between the daemon and the command). One test per throw site that the tests of the steps
// (state-steps.test.ts) and of the two phases (workspace-folder.test.ts) do not already reach: the checked open that
// every file goes through, the audit log, the audit text store, the activity log, the key, and the two refusals that
// are a bug of the caller and no file at all.
import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadOrCreateDaemonIdentity } from '@smurg/protocol/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JsonlAuditLog } from '../src/core/audit.ts';
import { AuditTextStore } from '../src/core/audit-text.ts';
import { defaultHostSettings } from '../src/core/config.ts';
import { ManualClock } from '../src/core/lifecycle.ts';
import { silentLogger } from '../src/core/logger.ts';
import { inspectPrivateFile, openPrivateFile } from '../src/core/private-file.ts';
import { STATE_FILE_KINDS, STATE_FILE_PROBLEMS_MAX, StateFileError, describeProblems, escapeForTerminal } from '../src/core/state-file-error.ts';
import { FileStateStore, readPrivateJson, serializeDocument } from '../src/core/state-store.ts';
import { readWorkspaceFolder } from '../src/core/workspace-folder.ts';
import { stateDocument } from '../src/core/workspace-state.ts';
import { ActivityLogError, ActivityLogFile } from '../src/locks/activity-log.ts';
import { createTempDir, removeTempDir } from '../src/testing/temp.ts';
import { GiB, WS, rejectionOf, refusalOf } from './fixtures/hand-made.ts';

let base: string;
let dir: string;
const clock = new ManualClock();

beforeEach(async () => {
  base = await createTempDir('kinds');
  dir = join(base, 's');
  await mkdir(dir, { mode: 0o700 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(base);
});

const notRoot = process.getuid?.() !== 0;

/** What stands in a file's place, and the refusal it must get from every open of a private file. */
const WRONG: Record<string, { readonly make: (path: string) => Promise<void>; readonly refusal: Record<string, unknown> }> = {
  'a symlink (to a file of ours)': {
    make: async (path) => {
      await writeFile(`${path}.target`, '', { mode: 0o600 });
      await symlink(`${path}.target`, path);
    },
    refusal: { kind: 'insecure', cause: 'symlink' },
  },
  'a dangling symlink': { make: (path) => symlink(`${path}.nowhere`, path), refusal: { kind: 'insecure', cause: 'symlink' } },
  'a directory': { make: async (path) => void (await mkdir(path, { mode: 0o700 })), refusal: { kind: 'insecure', cause: 'not-a-file' } },
  'a FIFO': { make: async (path) => void execFileSync('mkfifo', ['-m', '600', path]), refusal: { kind: 'insecure', cause: 'not-a-file' } },
  'group-readable': {
    make: async (path) => {
      await writeFile(path, '', { mode: 0o640 });
      await chmod(path, 0o640);
    },
    refusal: { kind: 'insecure', cause: 'mode', mode: 0o640 },
  },
  'world-writable': {
    make: async (path) => {
      await writeFile(path, '', { mode: 0o602 });
      await chmod(path, 0o602);
    },
    refusal: { kind: 'insecure', cause: 'mode', mode: 0o602 },
  },
};

describe('StateFileError', () => {
  it('carries its kind and path, and defaults: paths = [path], no problems, no copies', () => {
    const refusal = new StateFileError({ kind: 'other-workspace', path: '/s/state.json', message: 'state file belongs to another workspace' });
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ name: 'StateFileError', kind: 'other-workspace', path: '/s/state.json', paths: ['/s/state.json'], problems: [], moreProblems: 0, copies: [] });
    expect(refusal.message).toBe('state file belongs to another workspace: /s/state.json');
    for (const field of ['cause', 'mode', 'errno', 'reason', 'writtenBy'] as const) expect(refusal[field]).toBeUndefined();
    expect(STATE_FILE_KINDS).toEqual(['newer', 'insecure', 'cannot-open', 'other-workspace', 'unreadable']);
  });

  it('keeps at most eight problems and counts the rest; `cause` is the insecure cause, the system\'s error is `source`', () => {
    const problems = Array.from({ length: 11 }, (_, index) => `members.${index}.role: Invalid option`);
    const refusal = new StateFileError({ kind: 'unreadable', reason: 'no-known-shape', path: '/s/state.json', message: 'x', problems, moreProblems: 4 });
    expect(refusal.problems).toEqual(problems.slice(0, STATE_FILE_PROBLEMS_MAX));
    expect(refusal.moreProblems).toBe(4 + 3);
    expect(describeProblems(problems, 4)).toBe(`${problems.slice(0, 8).join('; ')}; and 7 more`);
    expect(describeProblems(['a: b'], 0)).toBe('a: b');
    const source = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const insecure = new StateFileError({ kind: 'insecure', cause: 'mode', mode: 0o644, path: '/s/a', message: 'x', source });
    expect(insecure).toMatchObject({ cause: 'mode', mode: 0o644, source });
  });

  it('with(): the same refusal with what only the folder\'s reader knows (every path, the writer, the kept copies)', () => {
    const first = new StateFileError({ kind: 'insecure', cause: 'mode', mode: 0o644, path: '/s/a.json', message: 'state file mode 644 grants group/other access' });
    const copies = [{ path: '/s/a.json.before-upgrade-from-0.4.0', from: '0.4.0', at: 5 }];
    const more = first.with({ paths: ['/s/a.json', '/s/b.json'], writtenBy: '0.5.1', copies });
    expect(more).toMatchObject({ kind: 'insecure', cause: 'mode', mode: 0o644, path: '/s/a.json', paths: ['/s/a.json', '/s/b.json'], writtenBy: '0.5.1', copies });
    expect(more.message).toBe(first.message);
    expect(first.paths).toEqual(['/s/a.json']);
  });

  it('escapes what a terminal would act on: controls, bidirectional and invisible characters', () => {
    expect(escapeForTerminal('a\u001b[31mb\u0007\u009b\u202e\u200b\ufeff c')).toBe('a\\u{1b}[31mb\\u{7}\\u{9b}\\u{202e}\\u{200b}\\u{feff} c');
    expect(escapeForTerminal('plain: text / 1.2')).toBe('plain: text / 1.2');
    expect(new StateFileError({ kind: 'unreadable', path: '/s/a\u001b.json', message: 'x' }).message).toBe('x: /s/a\\u{1b}.json');
  });
});

describe('the checked open of a private file (every file of the workspace folder goes through it)', () => {
  for (const [what, wrong] of Object.entries(WRONG)) {
    it(`${what}: refused for reading and for appending, and left as it is`, async () => {
      const path = join(dir, 'file.jsonl');
      await wrong.make(path);
      const before = await lstat(path);
      expect(await rejectionOf(openPrivateFile(path, fsConstants.O_RDONLY, { what: 'state file' }))).toMatchObject({ ...wrong.refusal, path });
      expect(await rejectionOf(openPrivateFile(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT, { what: 'audit log' }))).toMatchObject({ ...wrong.refusal, path });
      expect(await inspectPrivateFile(path, 'state file')).toMatchObject({ exists: true, refusal: wrong.refusal });
      const after = await lstat(path);
      expect([after.mode, after.size, after.isSymbolicLink()]).toEqual([before.mode, before.size, before.isSymbolicLink()]);
    });
  }

  it('a file of another user is `insecure` with cause `owner`', async () => {
    const path = join(dir, 'file.json');
    await writeFile(path, '{}', { mode: 0o600 });
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    expect(await rejectionOf(openPrivateFile(path, fsConstants.O_RDONLY, { what: 'state file' }))).toMatchObject({ kind: 'insecure', cause: 'owner', path });
  });

  it.skipIf(!notRoot)('a file that is there and cannot be opened is `cannot-open` with the errno', async () => {
    const path = join(dir, 'file.json');
    await writeFile(path, '{}', { mode: 0o600 });
    await chmod(path, 0o000);
    try {
      const refusal = await rejectionOf(openPrivateFile(path, fsConstants.O_RDONLY, { what: 'state file' }));
      expect(refusal).toMatchObject({ kind: 'cannot-open', errno: 'EACCES', path });
      expect(refusal.cause).toBeUndefined();
      expect(await inspectPrivateFile(path, 'state file')).toMatchObject({ exists: true, refusal: { kind: 'cannot-open' } });
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('a file that is not there: null for a read, created 0600 for an open that creates', async () => {
    const path = join(dir, 'file.json');
    expect(await openPrivateFile(path, fsConstants.O_RDONLY, { what: 'state file' })).toBeNull();
    expect(await inspectPrivateFile(path, 'state file')).toEqual({ exists: false, refusal: null });
    const previous = process.umask(0);
    try {
      const handle = await openPrivateFile(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT, { what: 'audit log' });
      await handle?.close();
    } finally {
      process.umask(previous);
    }
    expect(((await lstat(path)).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('documents', () => {
  it('a file that is not JSON is `unreadable` / `not-json`', async () => {
    await writeFile(join(dir, 'a.json'), '{"count": ', { mode: 0o600 });
    expect(await rejectionOf(readPrivateJson(join(dir, 'a.json')))).toMatchObject({ kind: 'unreadable', reason: 'not-json', path: join(dir, 'a.json') });
  });

  it('a file that matches no shape is `unreadable` / `no-known-shape` with the problems (a store outside a daemon reads when it opens)', async () => {
    const schema = z.strictObject({ count: z.int().min(0) });
    await writeFile(join(dir, 'odd.json'), '{"count": 1, "extra": true}', { mode: 0o600 });
    const store = await FileStateStore.open(dir, silentLogger);
    const refusal = await rejectionOf(store.document('odd', schema, () => ({ count: 0 })));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', path: join(dir, 'odd.json') });
    expect(refusal.problems).toEqual(['(root): Unrecognized key: "extra"']);
    expect(await readFile(join(dir, 'odd.json'), 'utf8')).toBe('{"count": 1, "extra": true}');
  });

  it('an update or an initial value the code itself gets wrong is refused before it is written (a bug of the caller, no file is involved)', async () => {
    const schema = z.strictObject({ count: z.int().min(0) });
    const store = await FileStateStore.open(dir, silentLogger);
    const doc = await store.document('things', schema, () => ({ count: 0 }));
    expect(refusalOf(() => doc.update(() => ({ count: -1 })))).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', path: join(dir, 'things.json'), problems: [expect.stringMatching(/^count: /)] });
    expect(await rejectionOf(store.document('wrong', schema, () => ({ count: -1 })))).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', path: join(dir, 'wrong.json') });
    await expect(lstat(join(dir, 'wrong.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    store.close();
  });
});

describe('the logs', () => {
  const openers: Record<string, (path: string) => Promise<{ close(): Promise<void> }>> = {
    'audit.jsonl': (path) => JsonlAuditLog.open(path, { clock, log: silentLogger, pageMax: 100 }),
    'audit-text.jsonl': (path) => AuditTextStore.open(path, { clock, log: silentLogger }),
    'activity.jsonl': async (path) => {
      const file = new ActivityLogFile(path, { log: silentLogger });
      await file.open();
      return file;
    },
  };
  for (const [name, open] of Object.entries(openers)) {
    for (const [what, wrong] of Object.entries(WRONG)) {
      it(`${name}, ${what}: the refusal has its kind`, async () => {
        const path = join(dir, name);
        await wrong.make(path);
        expect(await rejectionOf(open(path))).toMatchObject({ ...wrong.refusal, path });
      });
    }
    it.skipIf(!notRoot)(`${name} that cannot be opened: \`cannot-open\` with the errno`, async () => {
      const path = join(dir, name);
      await writeFile(path, '', { mode: 0o600 });
      await chmod(path, 0o000);
      try {
        expect(await rejectionOf(open(path))).toMatchObject({ kind: 'cannot-open', errno: 'EACCES', path });
      } finally {
        await chmod(path, 0o600);
      }
    });
    it(`${name} that is not there is created 0600`, async () => {
      const path = join(dir, name);
      await (await open(path)).close();
      expect(((await lstat(path)).mode & 0o777).toString(8)).toBe('600');
    });
  }

  it('an activity log that was closed says so with its own error (that is no refusal of a file)', async () => {
    const file = new ActivityLogFile(join(dir, 'activity.jsonl'), { log: silentLogger });
    await file.open();
    await file.close();
    await expect(file.open()).rejects.toBeInstanceOf(ActivityLogError);
  });
});

describe('identity.key', () => {
  const documents = [stateDocument(WS, defaultHostSettings(16 * GiB))];
  const read = (): Promise<unknown> => readWorkspaceFolder({ dir, log: silentLogger, documents, env: { memoryBytes: 16 * GiB }, smurg: '0.5.1', workspaceId: WS });
  beforeEach(async () => {
    await writeFile(join(dir, 'state.json'), serializeDocument(documents[0]!.init()), { mode: 0o600 });
  });

  for (const [what, wrong] of Object.entries(WRONG)) {
    it(`${what}: the same kinds as every other file of the folder, and no new key`, async () => {
      await wrong.make(join(dir, 'identity.key'));
      const before = await lstat(join(dir, 'identity.key'));
      expect(await rejectionOf(read())).toMatchObject({ ...wrong.refusal, path: join(dir, 'identity.key') });
      expect((await lstat(join(dir, 'identity.key'))).mode).toBe(before.mode);
    });
  }

  it('a good key is read as it is', async () => {
    const { keyPair } = await loadOrCreateDaemonIdentity(dir);
    expect(Buffer.from(((await read()) as { keyPair: { publicKey: Uint8Array } }).keyPair.publicKey).equals(Buffer.from(keyPair.publicKey))).toBe(true);
  });
});
