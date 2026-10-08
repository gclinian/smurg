// What an EARLIER published smurg wrote is read through steps (ARCHITECTURE §7.1, core/state-store.ts): today's strict
// schema first, then each frozen earlier shape; on a match the steps run in memory and the result must pass today's
// schema. These tests prove the mechanism with small hand-made files; the files the published versions really wrote
// are opened by test/upgrade/.
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultHostSettings, defaultMaxLiveAgents } from '../src/core/config.ts';
import { createMemoryLogger, silentLogger } from '../src/core/logger.ts';
import {
  KEPT_COPIES_MAX,
  STAMP_FILE,
  STATE_FILE_PROBLEMS_MAX,
  StateFileError,
  WORKSPACE_SHAPES,
  compareVersionNames,
  declareDocument,
  defineStep,
  expectedVersionOf,
  keepCopy,
  keptCopyPath,
  listKeptCopies,
  loadDocumentValue,
  readDocument,
  readStamp,
  writeKeptCopy,
  writeStamp,
  type StepEnv,
} from '../src/core/state-store.ts';
import { stateDocument, workspaceStateSchema, type WorkspaceState } from '../src/core/workspace-state.ts';
import { stateShapeV040, suggestionsShapeV040 } from '../src/frozen/v0.4.0.ts';
import { suggestionsDocument, suggestionsDocumentSchema } from '../src/suggest/store.ts';
import { createTempDir, removeTempDir } from '../src/testing/temp.ts';
import { GiB, WS, rejectionOf, refusalOf, stateOfV040, suggestionsOfV040 } from './fixtures/hand-made.ts';

const ENV: StepEnv = { memoryBytes: 16 * GiB };

/** A letter that composes with no mark, and `count` combining marks in a row (what 0.4.0 wrote stays as it is under NFC). */
const marks = (count: number): string => `x${'\u0301'.repeat(count)}`;

let base: string;
beforeEach(async () => {
  base = await createTempDir('steps');
});
afterEach(async () => {
  await removeTempDir(base);
});

describe('state.json: the step from smurg 0.4.0', () => {
  const declaration = stateDocument(WS, defaultHostSettings(ENV.memoryBytes));
  const path = '/nowhere/state.json';

  it('a file in today\'s shape runs no step', () => {
    const today = declaration.init();
    expect(loadDocumentValue(declaration, path, structuredClone(today), ENV)).toEqual({ value: today, upgradedFrom: null, ran: [] });
  });

  it('adds the three settings and carries everything else as it is', () => {
    const old = stateOfV040();
    expect(stateShapeV040.safeParse(old).success).toBe(true);
    expect(workspaceStateSchema.safeParse(old).success).toBe(false); // the refusal 0.5.0 published
    const loaded = loadDocumentValue(declaration, path, old, ENV);
    expect(loaded.upgradedFrom).toBe('0.4.0');
    expect(loaded.ran.map((step) => step.from)).toEqual(['0.4.0']);
    const value = loaded.value as WorkspaceState;
    expect(workspaceStateSchema.safeParse(value).success).toBe(true);
    // Every member, device, invite and root, every kick, revocation and use count: untouched.
    const { settings: newSettings, ...rest } = value;
    const { settings: oldSettings, ...oldRest } = old;
    expect(rest).toEqual(oldRest);
    expect(newSettings).toEqual({ ...(oldSettings as object), maxLiveAgents: defaultMaxLiveAgents(ENV.memoryBytes), escalateAfterMs: 300_000, agentMcp: false });
    expect(value.version).toBe(1);
  });

  it('the added values are constants of the step: agentMcp is closed whatever a NEW workspace would get; only maxLiveAgents follows the machine', () => {
    // The caller's defaults for a new workspace (the test harness passes some) are not what an upgrade gives.
    const open = stateDocument(WS, { ...defaultHostSettings(ENV.memoryBytes), agentMcp: true, escalateAfterMs: 900_000, maxLiveAgents: 2 });
    for (const memoryBytes of [4 * GiB, 16 * GiB, 64 * GiB]) {
      const value = loadDocumentValue(open, path, stateOfV040(), { memoryBytes }).value as WorkspaceState;
      expect(value.settings.agentMcp).toBe(false);
      expect(value.settings.escalateAfterMs).toBe(300_000);
      expect(value.settings.maxLiveAgents).toBe(defaultMaxLiveAgents(memoryBytes));
    }
    expect(new Set([4 * GiB, 16 * GiB, 64 * GiB].map(defaultMaxLiveAgents)).size).toBeGreaterThan(1);
  });

  it('the two published shapes of version 1 cannot be confused: neither matches the other', () => {
    const today = declaration.init();
    expect(stateShapeV040.safeParse(today).success).toBe(false);
    expect(workspaceStateSchema.safeParse(stateOfV040()).success).toBe(false);
  });

  it('a value 0.4.0 accepted and this smurg refuses (a path with more than 30 combining marks in a row) is refused naming the entry and the rule; nothing is dropped', () => {
    const fine = stateOfV040();
    (fine['settings'] as { sharedDirs: string[] }).sharedDirs = ['data', marks(30)];
    expect((loadDocumentValue(declaration, path, fine, ENV).value as WorkspaceState).settings.sharedDirs).toEqual(['data', marks(30)]);

    const old = stateOfV040();
    (old['settings'] as { sharedDirs: string[] }).sharedDirs = ['data', marks(31)];
    expect(stateShapeV040.safeParse(old).success).toBe(true); // 0.4.0 opened this file
    const refusal = refusalOf(() => loadDocumentValue(declaration, path, old, ENV));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'carried-value-refused', path });
    expect(refusal.problems).toEqual(['settings.sharedDirs.1: invalid relative path: mark-run']);
    expect(refusal.message).toMatch(/written by smurg 0\.4\.0/);
  });

  it('a 0.4.0 file with one bad record is measured against the 0.4.0 shape: the record is named, not "three settings are missing"', () => {
    const old = stateOfV040();
    (old['members'] as { role: string }[])[1]!.role = 'runner';
    const refusal = refusalOf(() => loadDocumentValue(declaration, path, old, ENV));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape' });
    expect(refusal.problems).toHaveLength(1);
    expect(refusal.problems[0]).toMatch(/^members\.1\.role: /);
    expect(refusal.message).toMatch(/measured against what smurg 0\.4\.0 wrote/);
    expect(refusal.problems.join(' ')).not.toMatch(/maxLiveAgents|agentMcp/);
  });

  it('a file that is neither shape is refused with at most eight problems, the count of the rest, and control characters escaped', () => {
    const damaged = declaration.init() as unknown as Record<string, unknown>;
    const members: unknown[] = [];
    for (let i = 0; i < 20; i++) members.push({ userId: 'dev:x', displayName: 'X', role: 'nobody', color: '#000000', joinedAt: 1, lastSeenAt: 1, status: 'active' });
    const refusal = refusalOf(() => loadDocumentValue(declaration, path, { ...damaged, members, '\u001b]0;pwned\u0007': 1 }, ENV));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape' });
    expect(refusal.problems).toHaveLength(STATE_FILE_PROBLEMS_MAX);
    expect(refusal.moreProblems).toBe(21 - STATE_FILE_PROBLEMS_MAX);
    const everything = `${refusal.message} ${refusal.problems.join(' ')}`;
    // eslint-disable-next-line no-control-regex
    expect(everything).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(refusalOf(() => loadDocumentValue(declaration, path, { ...damaged, '\u001b]0;pwned\u0007': 1 }, ENV)).problems[0]).toContain('\\u{1b}]0;pwned\\u{7}');
  });

  it('a version above the one this smurg expects is `newer`, never "damaged"; a lower or a non-number one is not', () => {
    const today = declaration.init();
    expect(refusalOf(() => loadDocumentValue(declaration, path, { ...today, version: 2 }, ENV))).toMatchObject({ kind: 'newer', path });
    expect(refusalOf(() => loadDocumentValue(declaration, path, { version: 7, somethingNew: [] }, ENV))).toMatchObject({ kind: 'newer' });
    expect(refusalOf(() => loadDocumentValue(declaration, path, { ...today, version: 0 }, ENV))).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape' });
    expect(refusalOf(() => loadDocumentValue(declaration, path, { ...today, version: '2' }, ENV))).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape' });
    expect(refusalOf(() => loadDocumentValue(declaration, path, [1, 2, 3], ENV))).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape' });
  });
});

describe('suggestions.json: the step from smurg 0.4.0', () => {
  const path = '/nowhere/suggestions.json';

  it('gives every 0.4.0 entry its origin (a selection when it has a source, else the composer) and carries the rest', () => {
    const old = suggestionsOfV040();
    expect(suggestionsShapeV040.safeParse(old).success).toBe(true);
    expect(suggestionsDocumentSchema.safeParse(old).success).toBe(false);
    const loaded = loadDocumentValue(suggestionsDocument, path, old, ENV);
    expect(loaded.upgradedFrom).toBe('0.4.0');
    const entries = loaded.value.suggestions;
    expect(entries.map((entry) => entry.origin)).toEqual(['selection', 'composer', 'composer', 'composer']);
    expect(entries.map(({ origin: _origin, ...rest }) => rest)).toEqual(old['suggestions']);
    // Nothing is decided by the step: the pending one is still pending here (the suggest module closes it at its start).
    expect(entries[3]).toMatchObject({ status: 'pending', text: 'still waiting' });
    expect(entries[0]).not.toHaveProperty('cleaned');
    expect(entries[0]).not.toHaveProperty('decidedBy');
  });

  it('an empty 0.4.0 file is today\'s shape already: no step, no copy', () => {
    expect(loadDocumentValue(suggestionsDocument, path, { version: 1, suggestions: [] }, ENV)).toMatchObject({ upgradedFrom: null, ran: [] });
  });

  it('a source path 0.4.0 accepted and this smurg refuses is named; the file is refused whole', () => {
    const old = suggestionsOfV040();
    ((old['suggestions'] as { source?: { file: { path: string } } }[])[0]!.source as { file: { path: string } }).file.path = `src/${marks(31)}.ts`;
    const refusal = refusalOf(() => loadDocumentValue(suggestionsDocument, path, old, ENV));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'carried-value-refused' });
    expect(refusal.problems).toEqual(['suggestions.0.source.file.path: invalid relative path: mark-run']);
  });
});

describe('steps in general', () => {
  const v1 = z.strictObject({ names: z.array(z.string()) });
  const v2 = z.strictObject({ version: z.literal(2), names: z.array(z.string()), count: z.int() });
  const today = z.strictObject({ version: z.literal(3), people: z.array(z.strictObject({ name: z.string().max(5) })), count: z.int() });
  const steps = [
    defineStep({ from: '1.0.0', sinceShapes: 1, shape: v1, upgrade: (old) => ({ version: 2 as const, names: old.names, count: old.names.length }) }),
    defineStep({ from: '2.0.0', sinceShapes: 1, shape: v2, upgrade: (old) => ({ version: 3 as const, people: old.names.map((name) => ({ name })), count: old.count }) }),
  ];
  const declaration = declareDocument({ name: 'people', schema: today, init: () => ({ version: 3 as const, people: [], count: 0 }), steps });
  const path = '/nowhere/people.json';

  it('a file of the oldest shape runs every step in order; a newer one only the steps after it; the file names the step it matched', () => {
    expect(loadDocumentValue(declaration, path, { names: ['a', 'b'] }, ENV)).toMatchObject({ value: { version: 3, people: [{ name: 'a' }, { name: 'b' }], count: 2 }, upgradedFrom: '1.0.0' });
    expect(loadDocumentValue(declaration, path, { names: ['a', 'b'] }, ENV).ran.map((step) => step.from)).toEqual(['1.0.0', '2.0.0']);
    const fromV2 = loadDocumentValue(declaration, path, { version: 2, names: ['a'], count: 9 }, ENV);
    expect(fromV2).toMatchObject({ value: { version: 3, people: [{ name: 'a' }], count: 9 }, upgradedFrom: '2.0.0' });
    expect(fromV2.ran.map((step) => step.from)).toEqual(['2.0.0']);
  });

  it('what the last step produces must pass today\'s strict schema, and what a step in the middle produces the next shape', () => {
    expect(refusalOf(() => loadDocumentValue(declaration, path, { names: ['far-too-long'] }, ENV))).toMatchObject({ kind: 'unreadable', reason: 'carried-value-refused', problems: [expect.stringMatching(/^people\.0\.name: /)] });
    const broken = declareDocument({ name: 'people', schema: today, init: declaration.init, steps: [defineStep({ from: '1.0.0', sinceShapes: 1, shape: v1, upgrade: () => ({ version: 2, names: 'not-a-list' }) }), steps[1]!] });
    expect(refusalOf(() => loadDocumentValue(broken, path, { names: [] }, ENV))).toMatchObject({ kind: 'unreadable', reason: 'carried-value-refused' });
  });

  it('a step that throws refuses the file (fail closed); it never falls back to a new document', () => {
    const throwing = declareDocument({
      name: 'people',
      schema: today,
      init: declaration.init,
      steps: [defineStep({ from: '1.0.0', sinceShapes: 1, shape: v1, upgrade: (): never => { throw new Error('boom'); } })],
    });
    expect(refusalOf(() => loadDocumentValue(throwing, path, { names: [] }, ENV))).toMatchObject({ kind: 'unreadable', reason: 'carried-value-refused' });
  });

  it('a document that has no `version` today and carries a number is `newer`; with a version, only a higher one is', () => {
    const bare = declareDocument({ name: 'bare', schema: z.strictObject({ live: z.array(z.string()) }), init: () => ({ live: [] as string[] }) });
    expect(expectedVersionOf(bare)).toBeNull();
    expect(expectedVersionOf(declaration)).toBe(3);
    expect(refusalOf(() => loadDocumentValue(bare, path, { version: 2, live: [], extra: {} }, ENV))).toMatchObject({ kind: 'newer' });
    expect(refusalOf(() => loadDocumentValue(bare, path, { version: 1, live: [] }, ENV))).toMatchObject({ kind: 'newer' });
    expect(refusalOf(() => loadDocumentValue(bare, path, { version: 'x', live: [] }, ENV))).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape' });
    expect(refusalOf(() => loadDocumentValue(declaration, path, { version: 4 }, ENV))).toMatchObject({ kind: 'newer' });
  });

  it('refuses a declaration whose steps are not oldest first, and a step that does not name published versions', () => {
    expect(() => declareDocument({ name: 'people', schema: today, init: declaration.init, steps: [steps[1]!, steps[0]!] })).toThrow(/oldest first/);
    expect(() => defineStep({ from: 'old', sinceShapes: 1, shape: v1, upgrade: (old) => old })).toThrow(TypeError);
    expect(() => defineStep({ from: '2.0.0', sinceShapes: 0, shape: v1, upgrade: (old) => old })).toThrow(TypeError);
    expect(() => defineStep({ from: '2.0.0', sinceShapes: WORKSPACE_SHAPES + 1, shape: v1, upgrade: (old) => old })).toThrow(TypeError);
    expect(() => declareDocument({ name: '../x', schema: today, init: declaration.init })).toThrow(TypeError);
    expect(compareVersionNames('0.5.1', '0.10.0')).toBe(-1);
    expect(compareVersionNames('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersionNames('0.5.1', '0.5.1')).toBe(0);
  });

  it('readDocument: the bytes it returns are the file as it was; a missing file is null; damage is `unreadable`, never `newer`', async () => {
    await mkdir(join(base, 's'), { mode: 0o700 });
    const dir = join(base, 's');
    expect(await readDocument(dir, declaration, ENV)).toBeNull();
    const text = '{ "names": ["a"]   }\n';
    await writeFile(join(dir, 'people.json'), text, { mode: 0o600 });
    const loaded = await readDocument(dir, declaration, ENV);
    expect(loaded).toMatchObject({ name: 'people', path: join(dir, 'people.json'), upgradedFrom: '1.0.0', value: { version: 3, people: [{ name: 'a' }], count: 1 } });
    expect(loaded?.bytes.toString('utf8')).toBe(text);
    expect(Object.isFrozen(loaded?.value)).toBe(true);
    expect(await readFile(join(dir, 'people.json'), 'utf8')).toBe(text); // reading wrote nothing
    expect(await readdir(dir)).toEqual(['people.json']);
    await writeFile(join(dir, 'people.json'), '{"version": 9, "names": ', { mode: 0o600 });
    expect(await rejectionOf(readDocument(dir, declaration, ENV))).toMatchObject({ kind: 'unreadable', reason: 'not-json', path: join(dir, 'people.json') });
  });
});

describe('the stamp written-by.json', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(base, 's');
    await mkdir(dir, { mode: 0o700 });
  });
  const mode = async (path: string): Promise<string> => ((await lstat(path)).mode & 0o777).toString(8);

  it('is written atomically with 0600 (whatever the umask) and holds exactly smurg, shapes and at', async () => {
    const previous = process.umask(0);
    try {
      await writeStamp(dir, { smurg: '0.5.1', shapes: WORKSPACE_SHAPES, at: 1_727_000_000_000 });
    } finally {
      process.umask(previous);
    }
    expect(await mode(join(dir, STAMP_FILE))).toBe('600');
    expect(JSON.parse(await readFile(join(dir, STAMP_FILE), 'utf8'))).toEqual({ smurg: '0.5.1', shapes: 1, at: 1_727_000_000_000 });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await readStamp(dir, silentLogger)).toEqual({ smurg: '0.5.1', shapes: 1, at: 1_727_000_000_000 });
    expect(WORKSPACE_SHAPES).toBe(1);
  });

  it('no stamp: the writer is unknown, and nothing is logged', async () => {
    const log = createMemoryLogger();
    expect(await readStamp(dir, log)).toBeNull();
    expect(log.lines).toEqual([]);
  });

  const unusable: Record<string, (path: string) => Promise<void>> = {
    'a symlink': async (path) => {
      await writeFile(join(base, 'elsewhere.json'), JSON.stringify({ smurg: '9.9.9', shapes: 99, at: 1 }), { mode: 0o600 });
      await symlink(join(base, 'elsewhere.json'), path);
    },
    'group/other bits': async (path) => {
      await writeFile(path, JSON.stringify({ smurg: '9.9.9', shapes: 99, at: 1 }), { mode: 0o644 });
      await chmod(path, 0o644);
    },
    'a directory': async (path) => {
      await mkdir(path, { mode: 0o700 });
    },
    'a FIFO (the read must not hang)': async (path) => {
      execFileSync('mkfifo', ['-m', '600', path]);
    },
    'a file larger than a stamp': async (path) => {
      await writeFile(path, JSON.stringify({ smurg: '9.9.9', shapes: 99, at: 1, pad: 'x'.repeat(8_192) }), { mode: 0o600 });
    },
    'not JSON': async (path) => {
      await writeFile(path, '{"smurg": "9.9.9", "shapes": 99', { mode: 0o600 });
    },
    'an unknown key': async (path) => {
      await writeFile(path, JSON.stringify({ smurg: '9.9.9', shapes: 99, at: 1, protocol: 4 }), { mode: 0o600 });
    },
    'a version that is not digits.digits.digits': async (path) => {
      await writeFile(path, JSON.stringify({ smurg: '9.9.9\u001b[31m', shapes: 99, at: 1 }), { mode: 0o600 });
    },
    'shapes that is not an integer': async (path) => {
      await writeFile(path, JSON.stringify({ smurg: '9.9.9', shapes: '99', at: 1 }), { mode: 0o600 });
    },
  };
  for (const [what, make] of Object.entries(unusable)) {
    it(`${what}: the writer is unknown; it is logged and is never a refusal of its own`, async () => {
      await make(join(dir, STAMP_FILE));
      const log = createMemoryLogger();
      expect(await readStamp(dir, log)).toBeNull();
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toMatchObject({ level: 'warn', fields: { file: join(dir, STAMP_FILE) } });
    });
  }

  it('a stamp that cannot be written refuses (cannot-open, with the errno)', async () => {
    await mkdir(join(dir, STAMP_FILE));
    await writeFile(join(dir, STAMP_FILE, 'x'), 'x');
    const refusal = await rejectionOf(writeStamp(dir, { smurg: '0.5.1', shapes: 1, at: 1 }));
    expect(refusal).toMatchObject({ kind: 'cannot-open', path: join(dir, STAMP_FILE) });
    expect(typeof refusal.errno).toBe('string');
    await chmod(dir, 0o500);
    try {
      expect(await rejectionOf(writeStamp(dir, { smurg: '0.5.1', shapes: 1, at: 1 }))).toMatchObject({ kind: 'cannot-open', errno: 'EACCES' });
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe('kept copies: <name>.json.before-upgrade-from-<step>', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(base, 's');
    await mkdir(dir, { mode: 0o700 });
  });

  it('is named after the step, created 0600 whatever the umask, and holds exactly the bytes it was given', async () => {
    const copy = keptCopyPath(dir, 'state', '0.4.0');
    expect(copy).toBe(join(dir, 'state.json.before-upgrade-from-0.4.0'));
    const bytes = Buffer.from('{ "as": "it was" }\n\n');
    const previous = process.umask(0);
    try {
      expect(await writeKeptCopy(copy, dir, bytes)).toBe('created');
    } finally {
      process.umask(previous);
    }
    expect(((await lstat(copy)).mode & 0o777).toString(8)).toBe('600');
    expect((await readFile(copy)).equals(bytes)).toBe(true);
    expect(() => keptCopyPath(dir, 'state', '../x')).toThrow(TypeError);
    expect(() => keptCopyPath(dir, '../state', '0.4.0')).toThrow(TypeError);
  });

  it('is never overwritten: a copy of this step that is already there stays byte for byte', async () => {
    const copy = keptCopyPath(dir, 'state', '0.4.0');
    expect(await writeKeptCopy(copy, dir, Buffer.from('first'))).toBe('created');
    expect(await writeKeptCopy(copy, dir, Buffer.from('second, later'))).toBe('exists');
    expect(await readFile(copy, 'utf8')).toBe('first');
  });

  it('is created with O_EXCL and O_NOFOLLOW: a symlink in its place is not written through', async () => {
    const copy = keptCopyPath(dir, 'state', '0.4.0');
    await writeFile(join(base, 'target'), 'untouched', { mode: 0o600 });
    await symlink(join(base, 'target'), copy);
    expect(await writeKeptCopy(copy, dir, Buffer.from('the old state'))).toBe('exists');
    expect(await readFile(join(base, 'target'), 'utf8')).toBe('untouched');
    await symlink(join(base, 'nowhere'), keptCopyPath(dir, 'state', '0.5.0')); // dangling
    expect(await writeKeptCopy(keptCopyPath(dir, 'state', '0.5.0'), dir, Buffer.from('x'))).toBe('exists');
    await expect(lstat(join(base, 'nowhere'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keepCopy: the first free name of the step (the step alone, then -2, -3, …); a name that holds these bytes already makes nothing new; no name is ever written twice', async () => {
    const a = Buffer.from('{ "as": "it was" }\n');
    const b = Buffer.from('{ "as": "it was, later" }\n');
    const c = Buffer.from('{ "as": "it was, later still" }\n');
    expect(await keepCopy(dir, 'state', '0.4.0', a)).toEqual({ path: keptCopyPath(dir, 'state', '0.4.0'), nth: 1, made: true });
    expect(await keepCopy(dir, 'state', '0.4.0', a)).toEqual({ path: keptCopyPath(dir, 'state', '0.4.0'), nth: 1, made: false });
    expect(await keepCopy(dir, 'state', '0.4.0', b)).toEqual({ path: join(dir, 'state.json.before-upgrade-from-0.4.0-2'), nth: 2, made: true });
    expect(await keepCopy(dir, 'state', '0.4.0', c)).toEqual({ path: join(dir, 'state.json.before-upgrade-from-0.4.0-3'), nth: 3, made: true });
    expect(await keepCopy(dir, 'state', '0.4.0', b)).toEqual({ path: keptCopyPath(dir, 'state', '0.4.0', 2), nth: 2, made: false });
    expect(await keepCopy(dir, 'state', '0.4.0', a)).toEqual({ path: keptCopyPath(dir, 'state', '0.4.0', 1), nth: 1, made: false });
    // Another step and another document count by themselves.
    expect(await keepCopy(dir, 'state', '0.5.0', b)).toMatchObject({ nth: 1, made: true });
    expect(await keepCopy(dir, 'suggestions', '0.4.0', b)).toMatchObject({ nth: 1, made: true });
    expect((await readdir(dir)).sort()).toEqual([
      'state.json.before-upgrade-from-0.4.0',
      'state.json.before-upgrade-from-0.4.0-2',
      'state.json.before-upgrade-from-0.4.0-3',
      'state.json.before-upgrade-from-0.5.0',
      'suggestions.json.before-upgrade-from-0.4.0',
    ]);
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0'))).equals(a)).toBe(true);
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0', 2))).equals(b)).toBe(true);
    expect((await readFile(keptCopyPath(dir, 'state', '0.4.0', 3))).equals(c)).toBe(true);
    for (const name of await readdir(dir)) expect(`${name} ${((await lstat(join(dir, name))).mode & 0o777).toString(8)}`).toBe(`${name} 600`);
    // The names are the ones keptCopyPath makes and no others.
    expect(() => keptCopyPath(dir, 'state', '0.4.0', 0)).toThrow(TypeError);
    expect(() => keptCopyPath(dir, 'state', '0.4.0', 1.5)).toThrow(TypeError);
    expect(() => keptCopyPath(dir, 'state', '0.4.0', KEPT_COPIES_MAX + 1)).toThrow(TypeError);
  });

  it('keepCopy: what carries a name of the step and is no private file of ours refuses (the document is then not written); every name taken by other bytes is a refusal, never an overwrite', async () => {
    await writeFile(join(base, 'target'), 'untouched', { mode: 0o600 });
    await symlink(join(base, 'target'), keptCopyPath(dir, 'state', '0.4.0'));
    expect(await rejectionOf(keepCopy(dir, 'state', '0.4.0', Buffer.from('x')))).toMatchObject({ kind: 'insecure', cause: 'symlink', path: keptCopyPath(dir, 'state', '0.4.0') });
    expect(await readFile(join(base, 'target'), 'utf8')).toBe('untouched');
    await rm(keptCopyPath(dir, 'state', '0.4.0'));
    await writeFile(keptCopyPath(dir, 'state', '0.4.0'), 'open to others', { mode: 0o644 });
    await chmod(keptCopyPath(dir, 'state', '0.4.0'), 0o644);
    expect(await rejectionOf(keepCopy(dir, 'state', '0.4.0', Buffer.from('x')))).toMatchObject({ kind: 'insecure', cause: 'mode', path: keptCopyPath(dir, 'state', '0.4.0') });
    await rm(keptCopyPath(dir, 'state', '0.4.0'));
    // Every name of the step taken, each by other bytes.
    for (let nth = 1; nth <= KEPT_COPIES_MAX; nth++) await writeFile(keptCopyPath(dir, 'state', '0.4.0', nth), `copy ${nth}`, { mode: 0o600 });
    const before = await readdir(dir);
    expect(await rejectionOf(keepCopy(dir, 'state', '0.4.0', Buffer.from('one more')))).toMatchObject({ kind: 'cannot-open', errno: 'EEXIST', path: keptCopyPath(dir, 'state', '0.4.0', KEPT_COPIES_MAX) });
    expect(await readdir(dir)).toEqual(before);
    expect(await readFile(keptCopyPath(dir, 'state', '0.4.0', KEPT_COPIES_MAX), 'utf8')).toBe(`copy ${KEPT_COPIES_MAX}`);
    // The bytes of one of them: that one is named, nothing is made.
    expect(await keepCopy(dir, 'state', '0.4.0', Buffer.from('copy 57'))).toEqual({ path: keptCopyPath(dir, 'state', '0.4.0', 57), nth: 57, made: false });
  });

  it('a copy that cannot be created is a refusal (cannot-open, with the errno), and nothing half-written stays', async () => {
    await chmod(dir, 0o500);
    try {
      expect(await rejectionOf(writeKeptCopy(keptCopyPath(dir, 'state', '0.4.0'), dir, Buffer.from('x')))).toMatchObject({ kind: 'cannot-open', errno: 'EACCES', path: keptCopyPath(dir, 'state', '0.4.0') });
    } finally {
      await chmod(dir, 0o700);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('are listed newest first, and only what a private file is: no symlink, nobody else\'s bits, no other name', async () => {
    await writeKeptCopy(keptCopyPath(dir, 'state', '0.4.0'), dir, Buffer.from('a'));
    await writeKeptCopy(keptCopyPath(dir, 'state', '0.5.0'), dir, Buffer.from('b'));
    await utimes(keptCopyPath(dir, 'state', '0.4.0'), 1_000, 1_000);
    await utimes(keptCopyPath(dir, 'state', '0.5.0'), 2_000, 2_000);
    await writeFile(join(dir, 'state.json.before-upgrade-from-0.6.0'), 'open', { mode: 0o644 });
    await chmod(join(dir, 'state.json.before-upgrade-from-0.6.0'), 0o644);
    await symlink(join(base, 'elsewhere'), join(dir, 'state.json.before-upgrade-from-0.7.0'));
    await writeFile(join(dir, 'state.json.before-upgrade-from-yesterday'), 'x', { mode: 0o600 });
    await writeFile(join(dir, 'state.json.before-upgrade'), 'x', { mode: 0o600 });
    await writeKeptCopy(keptCopyPath(dir, 'suggestions', '0.4.0'), dir, Buffer.from('c'));
    expect(await listKeptCopies(dir, 'state')).toEqual([
      { path: keptCopyPath(dir, 'state', '0.5.0'), from: '0.5.0', at: 2_000_000 },
      { path: keptCopyPath(dir, 'state', '0.4.0'), from: '0.4.0', at: 1_000_000 },
    ]);
    // The second and third copy of one step are listed with it, each at its own time; names keptCopyPath would not
    // make (`-1`, `-02`, `-100`, `-2-3`, `-x`) are no copies.
    await keepCopy(dir, 'state', '0.4.0', Buffer.from('a, later'));
    await keepCopy(dir, 'state', '0.4.0', Buffer.from('a, later still'));
    await utimes(keptCopyPath(dir, 'state', '0.4.0', 2), 3_000, 3_000);
    await utimes(keptCopyPath(dir, 'state', '0.4.0', 3), 2_000, 2_000);
    for (const odd of ['-1', '-02', '-100', '-2-3', '-x', '-']) await writeFile(join(dir, `state.json.before-upgrade-from-0.4.0${odd}`), 'x', { mode: 0o600 });
    expect(await listKeptCopies(dir, 'state')).toEqual([
      { path: keptCopyPath(dir, 'state', '0.4.0', 2), from: '0.4.0', at: 3_000_000 },
      // The same millisecond: the later step first, and of one step the higher number.
      { path: keptCopyPath(dir, 'state', '0.5.0'), from: '0.5.0', at: 2_000_000 },
      { path: keptCopyPath(dir, 'state', '0.4.0', 3), from: '0.4.0', at: 2_000_000 },
      { path: keptCopyPath(dir, 'state', '0.4.0'), from: '0.4.0', at: 1_000_000 },
    ]);
    expect((await listKeptCopies(dir, 'suggestions')).map((copy) => copy.from)).toEqual(['0.4.0']);
    expect(await listKeptCopies(join(dir, 'missing'), 'state')).toEqual([]);
  });
});
