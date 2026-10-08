// A value a published smurg accepted and this one refuses, in a document that has NO step (0.5.1, the last fixes: V1-2).
//
// 0.4.0 accepted a path with more than 30 combining marks in a row; 0.5.0 made that rule tighter. In state.json and
// suggestions.json such a value arrives through a step and is refused as `carried-value-refused`, with the words for
// it. conflicts.json and worktrees.json have no step (what 0.4.0 wrote of them passes today's schema as it is), so
// the same value there was refused as `no-known-shape`: "not in a form that smurg 0.5.1 or an earlier published smurg
// wrote ... if a newer smurg was ever used on this computer, run smurg update", three statements that are wrong for a
// file 0.4.0 wrote. The reason is decided by what the problems ARE: a file that fails ONLY because of rules that got
// tighter since a published smurg wrote it is `carried-value-refused`, in every document.
//
// On what the published 0.4.0 really left (test/fixtures/published/0.4.0), with one record given such a path: the
// published 0.4.0 executable shares on exactly that (the sceptic's run, W/V1/logs/exe/S1 of the 0.5.1 work).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestDaemon } from '../../src/testing/index.ts';
import { startOn } from './daemon-on.ts';
import { STAMP_NAME, copyOf, everythingOf, readJson, type FixtureCopy } from './fixture.ts';
import { documentsOfThisSmurg } from './persisted.ts';

type Json = Record<string, unknown>;

let running: TestDaemon | null = null;
const copies: FixtureCopy[] = [];
afterEach(async () => {
  await running?.cleanup().catch(() => {});
  running = null;
  for (const copy of copies.splice(0)) await copy.remove().catch(() => {});
});

/** A name 0.4.0 accepted: a letter that composes with no mark, and 31 combining marks in a row. */
const MARKS = `x${'\u0301'.repeat(31)}`;

async function refusalAfter(change: (copy: FixtureCopy) => Promise<void>): Promise<{ readonly refusal: Json; readonly unchanged: boolean; readonly copy: FixtureCopy }> {
  const copy = await copyOf('0.4.0');
  copies.push(copy);
  await mkdir(join(copy.project, '.smurg', 'uploads'), { recursive: true, mode: 0o700 }); // a start makes it before it reads anything
  await change(copy);
  const before = await everythingOf(copy);
  let refusal: Json;
  try {
    running = await startOn(copy);
    throw new Error('the daemon STARTED on a folder it must refuse');
  } catch (err) {
    refusal = err as Json;
  }
  return { refusal, unchanged: JSON.stringify(await everythingOf(copy)) === JSON.stringify(before), copy };
}

async function edit(copy: FixtureCopy, name: string, change: (value: Json) => void): Promise<void> {
  const path = join(copy.workspaceDir, `${name}.json`);
  const value = JSON.parse(await readFile(path, 'utf8')) as Json;
  change(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

describe('a path 0.4.0 accepted and this smurg refuses, in a document without a step', { timeout: 60_000 }, () => {
  it('the test\'s name really is what the rule is about: 31 combining marks in a row, plain ASCII in this file', () => {
    expect([...MARKS].length).toBe(32);
    expect(MARKS.normalize('NFC')).toBe(MARKS);
  });

  it('conflicts.json: the file of a kept conflict: `carried-value-refused`, naming the entry and the rule; the folder byte for byte; no kept copy is named, and this one file can be set aside', async () => {
    const { refusal, unchanged, copy } = await refusalAfter((made) =>
      edit(made, 'conflicts', (value) => {
        ((value['conflicts'] as { file: { path: string } }[])[0] as { file: { path: string } }).file.path = `docs/${MARKS}.md`;
      }),
    );
    expect(refusal).toMatchObject({ name: 'StateFileError', kind: 'unreadable', reason: 'carried-value-refused', phase: 1, path: join(copy.workspaceDir, 'conflicts.json'), document: 'conflicts', canSetAside: true, copies: [] });
    expect(refusal['problems']).toEqual(['conflicts.0.file.path: invalid relative path: mark-run']);
    expect(refusal['writtenBy']).toBeUndefined();
    expect(unchanged).toBe(true);
  });

  it('worktrees.json: a shared folder of a worktree, and a file of a merge request that conflicted: the same', async () => {
    const { refusal, unchanged, copy } = await refusalAfter((made) =>
      edit(made, 'worktrees', (value) => {
        ((value['worktrees'] as { sharedDirs: string[] }[])[0] as { sharedDirs: string[] }).sharedDirs = ['data', MARKS];
        const merges = value['merges'] as Json[];
        if (merges.length === 0) throw new Error('the fixture has no merge request');
        (merges[0] as Json)['conflictFiles'] = [`src/${MARKS}/a.ts`];
      }),
    );
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'carried-value-refused', phase: 1, path: join(copy.workspaceDir, 'worktrees.json'), document: 'worktrees', canSetAside: true });
    expect(refusal['problems']).toEqual(['worktrees.0.sharedDirs.1: invalid relative path: mark-run', 'merges.0.conflictFiles.0: invalid relative path: mark-run']);
    expect(unchanged).toBe(true);
  });

  it('sessions.json holds no path and no name: no rule that got tighter can refuse it, and what is wrong with one is `no-known-shape`', async () => {
    const sessions = documentsOfThisSmurg().find((document) => document.name === 'sessions');
    // (The whole of it: ids of sessions and ids of processes. Should it ever hold a path, this test is where to say what 0.4.0 wrote.)
    expect(JSON.stringify(sessions?.init())).toBe('{"live":[]}');
    const { refusal, unchanged } = await refusalAfter((made) => edit(made, 'sessions', (value) => void (value['live'] = [MARKS])));
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', document: 'sessions', canSetAside: true });
    expect(unchanged).toBe(true);
  });

  it('ONLY such rules: one more problem of another kind in the same file, and it is `no-known-shape` again (no published smurg wrote that)', async () => {
    const { refusal } = await refusalAfter((made) =>
      edit(made, 'conflicts', (value) => {
        const first = (value['conflicts'] as Json[])[0] as Json;
        (first['file'] as { path: string }).path = `docs/${MARKS}.md`;
        first['somethingNobodyWrote'] = true;
      }),
    );
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape', document: 'conflicts' });
    expect((refusal['problems'] as string[]).length).toBe(2);
  });

  it('a path that was never valid (it leaves the folder) is not such a rule: `no-known-shape`', async () => {
    const { refusal } = await refusalAfter((made) =>
      edit(made, 'conflicts', (value) => {
        ((value['conflicts'] as { file: { path: string } }[])[0] as { file: { path: string } }).file.path = '../outside.md';
      }),
    );
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'no-known-shape' });
    expect(refusal['problems']).toEqual(['conflicts.0.file.path: invalid relative path: dot-segment']);
  });

  it('state.json in TODAY\'s shape with such a path (a host who added the three settings by hand after 0.5.0\'s refusal): `carried-value-refused` too, not "three keys nobody knows"', async () => {
    const { refusal, unchanged, copy } = await refusalAfter((made) =>
      edit(made, 'state', (value) => {
        const settings = value['settings'] as Json;
        value['settings'] = { ...settings, sharedDirs: [...(settings['sharedDirs'] as string[]), MARKS], maxLiveAgents: 5, escalateAfterMs: 300_000, agentMcp: false };
      }),
    );
    expect(refusal).toMatchObject({ kind: 'unreadable', reason: 'carried-value-refused', document: 'state', canSetAside: false, path: join(copy.workspaceDir, 'state.json') });
    expect((refusal['problems'] as string[]).every((problem) => /^settings\.sharedDirs\.\d+: invalid relative path: mark-run$/.test(problem))).toBe(true);
    expect(unchanged).toBe(true);
  });

  it('with the one record taken out by hand, the same folder is upgraded and starts', async () => {
    const copy = await copyOf('0.4.0');
    copies.push(copy);
    await edit(copy, 'conflicts', (value) => {
      ((value['conflicts'] as { file: { path: string } }[])[0] as { file: { path: string } }).file.path = `docs/${MARKS}.md`;
    });
    await expect(startOn(copy)).rejects.toMatchObject({ reason: 'carried-value-refused' });
    await edit(copy, 'conflicts', (value) => void (value['conflicts'] as unknown[]).shift());
    const t = (running = await startOn(copy));
    expect(t.daemon.upgraded.map((entry) => entry.document)).toEqual(['state', 'suggestions']);
    expect(t.daemon.putBack).toBe(false);
    expect(await readJson<Json>(join(copy.workspaceDir, STAMP_NAME))).not.toHaveProperty('pending');
  });
});
