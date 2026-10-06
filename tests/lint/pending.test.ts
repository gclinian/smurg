// The pending list of v0.5.0 (pending-v050.ts) stays honest: every skipped part names the file that skips it, that
// file really asks for it by its id, and for the release (SMURG_RELEASE_GATE=1) nothing is pending.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PENDING_ACCEPTANCE_REFS, PENDING_TEST_PARTS, RELEASE_GATE, isPendingPart } from './pending-v050.ts';
import { read, repoFiles, REPO_ROOT } from './tree.ts';

describe('the pending list of v0.5.0', () => {
  it('every skipped part names an existing test file that asks for exactly that id, its package and why', () => {
    const problems: string[] = [];
    for (const part of PENDING_TEST_PARTS) {
      if (!existsSync(join(REPO_ROOT, part.where))) problems.push(`${part.id}: ${part.where} does not exist`);
      else if (!read(part.where).includes(`isPendingPart('${part.id}')`)) problems.push(`${part.id}: ${part.where} does not call isPendingPart('${part.id}')`);
      if (!/^P(?:[1-9]|1[0-2])$/.test(part.owner)) problems.push(`${part.id}: no package`);
      if (part.why.length < 20) problems.push(`${part.id}: say why`);
    }
    expect(problems).toEqual([]);
    const ids = PENDING_TEST_PARTS.map((part) => part.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no test asks for a part the list does not have (a typo would run or skip the wrong thing)', () => {
    const known = new Set(PENDING_TEST_PARTS.map((part) => part.id));
    const unknown: string[] = [];
    for (const path of repoFiles()) {
      if (!/\.test\.tsx?$/.test(path) || path.startsWith('tests/lint/')) continue;
      for (const match of read(path).matchAll(/isPendingPart\('([^']+)'\)/g)) if (!known.has(match[1] as string)) unknown.push(`${path}: ${match[1] as string}`);
    }
    // For the release the list is empty and no call is left at all.
    expect(unknown).toEqual([]);
  });

  it('a part is pending only while the release is being built', () => {
    for (const part of PENDING_TEST_PARTS) expect(isPendingPart(part.id)).toBe(!RELEASE_GATE);
    expect(isPendingPart('no-such-part')).toBe(false);
  });

  it.runIf(RELEASE_GATE)('the release gate: the list is empty', () => {
    expect(PENDING_TEST_PARTS).toEqual([]);
    expect(PENDING_ACCEPTANCE_REFS).toEqual([]);
  });
});
