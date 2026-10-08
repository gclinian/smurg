// What a run of the opt-in upgrade test (sea-upgrade.test.ts; docs/RELEASING.md, the release dry run) says when it
// did NOT test the upgrade, and where it reads the executables from (0.5.1, sceptics V2-1, V5-3, V5-4):
//   - the command of docs/RELEASING.md names the new executable by a path from the repository's root
//     (SMURG_SEA_BINARY=packages/cli/dist/...), and `pnpm --filter @smurg/cli exec` runs vitest in packages/cli: the
//     test read the path from there, found nothing, and failed with "TypeError: .toMatch() expects to receive a string";
//   - a run without the variables printed "Test Files 1 passed" and NOTHING on stderr, although the guide says that a
//     skipped run says so there: the one step that proves the upgrade from the published executables could be skipped
//     without anyone reading that it was.
// The rules are in ./sea-binaries.ts. Here: the rules on their own, and the test file itself, run by vitest as a
// person runs it, for what only the real run shows (stderr outside any test body, the exit code).
import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from '@smurg/daemon/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, UPGRADE_SKIPPED, executableProblem, fromRepoRoot, requireSeaBinary, seaBinary, upgradePlan, type BinaryDeps } from './sea-binaries.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

const ROOT = '/repo';
/** A repository whose only executables are the three the guide's command names. */
const there = (executables: readonly string[], others: Readonly<Record<string, 'not-executable' | 'not-a-file'>> = {}): BinaryDeps => ({
  root: ROOT,
  lookAt: (path) => (executables.includes(path) ? 'executable' : (others[path] ?? 'missing')),
});
const OLD_040 = '/downloads/v0.4.0/smurg-darwin-arm64';
const OLD_050 = '/downloads/v0.5.0/smurg-darwin-arm64';
const BUILT = `${ROOT}/packages/cli/dist/smurg-darwin-arm64`;

describe('which executables the upgrade test runs (test/sea-binaries.ts)', () => {
  it('the command as the guide prints it, typed at the repository\'s root: a path that is not absolute is read from the root', () => {
    const env = { SMURG_PREVIOUS_BINARIES: `${OLD_040}:${OLD_050}`, SMURG_SEA_BINARY: 'packages/cli/dist/smurg-darwin-arm64' };
    expect(upgradePlan(env, there([OLD_040, OLD_050, BUILT]))).toEqual({ kind: 'run', next: BUILT, previous: [OLD_040, OLD_050] });
    // The old ones too; an absolute path is taken as it is; an empty item of the list is none.
    expect(upgradePlan({ SMURG_PREVIOUS_BINARIES: `:scratch/old/smurg::${OLD_050}:`, SMURG_SEA_BINARY: BUILT }, there([`${ROOT}/scratch/old/smurg`, OLD_050, BUILT]))).toEqual({
      kind: 'run',
      next: BUILT,
      previous: [`${ROOT}/scratch/old/smurg`, OLD_050],
    });
    // The real root is the repository's (this file is packages/cli/test/…), whatever folder the runner is in.
    expect(fromRepoRoot('packages/cli/test/sea-binaries.ts')).toBe(fileURLToPath(new URL('./sea-binaries.ts', import.meta.url)));
    expect(fromRepoRoot('packages/cli/dist/smurg-darwin-arm64')).toBe(join(REPO_ROOT, 'packages/cli/dist/smurg-darwin-arm64'));
    expect(seaBinary({ SMURG_SEA_BINARY: 'packages/cli/dist/smurg-darwin-arm64' }, { root: ROOT })).toBe(BUILT);
    expect(seaBinary({})).toBeNull();
    expect(seaBinary({ SMURG_SEA_BINARY: '' })).toBeNull();
  });

  it('a named executable that is not there, is no file or may not be executed: a plain sentence with the variable, the path as given and the place looked at', () => {
    const env = { SMURG_PREVIOUS_BINARIES: `${OLD_040}:${OLD_050}`, SMURG_SEA_BINARY: 'packages/cli/dist/smurg-darwin-arm64' };
    expect(upgradePlan(env, there([OLD_040, OLD_050]))).toEqual({
      kind: 'failed',
      problems: [`SMURG_SEA_BINARY names an executable that cannot be run: packages/cli/dist/smurg-darwin-arm64 (read from the repository's root: ${BUILT}): there is no such file.`],
    });
    // Every problem is said, the old executables first (the order of the run).
    expect(upgradePlan(env, there([OLD_040], { [OLD_050]: 'not-a-file', [BUILT]: 'not-executable' }))).toEqual({
      kind: 'failed',
      problems: [
        `SMURG_PREVIOUS_BINARIES names an executable that cannot be run: ${OLD_050}: it is not a file.`,
        `SMURG_SEA_BINARY names an executable that cannot be run: packages/cli/dist/smurg-darwin-arm64 (read from the repository's root: ${BUILT}): the file may not be executed (chmod +x).`,
      ],
    });
    expect(executableProblem('SMURG_SEA_BINARY', BUILT, there([BUILT]))).toBeNull();
    // The other two opt-in tests (sea.test.ts, sea-update.test.ts) say the same before they start anything.
    expect(() => requireSeaBinary({ SMURG_SEA_BINARY: 'nowhere/smurg' }, there([]))).toThrow(`SMURG_SEA_BINARY names an executable that cannot be run: nowhere/smurg (read from the repository's root: ${ROOT}/nowhere/smurg): there is no such file.`);
    expect(() => requireSeaBinary({ SMURG_SEA_BINARY: BUILT }, there([BUILT]))).not.toThrow();
    expect(() => requireSeaBinary({}, there([]))).not.toThrow();
  });

  it('neither variable: skipped, with the line for stderr; for a release\'s gate that is a failure', () => {
    expect(upgradePlan({}, there([]))).toEqual({ kind: 'skipped', line: UPGRADE_SKIPPED });
    expect(upgradePlan({ SMURG_SEA_BINARY: '', SMURG_PREVIOUS_BINARIES: '' }, there([]))).toEqual({ kind: 'skipped', line: UPGRADE_SKIPPED });
    expect(UPGRADE_SKIPPED).toMatch(/^\[sea-upgrade\] SKIPPED: the upgrade from the published executables was NOT tested\. It needs SMURG_PREVIOUS_BINARIES .* and SMURG_SEA_BINARY /);
    expect(upgradePlan({ SMURG_RELEASE_GATE: '1' }, there([]))).toEqual({
      kind: 'failed',
      problems: [
        'SMURG_RELEASE_GATE=1 and the upgrade from the published executables was NOT tested: a release\'s gate needs SMURG_PREVIOUS_BINARIES (the published smurg executables, separated by ":") and SMURG_SEA_BINARY (the build of this tree).',
      ],
    });
    // Any other value of the gate's variable is not the gate.
    expect(upgradePlan({ SMURG_RELEASE_GATE: '0' }, there([])).kind).toBe('skipped');
  });

  it('only one of the two (a forgotten or misspelled variable): a failure that names the missing one, never a skip', () => {
    expect(upgradePlan({ SMURG_SEA_BINARY: BUILT }, there([BUILT]))).toEqual({
      kind: 'failed',
      problems: ['SMURG_SEA_BINARY is set and SMURG_PREVIOUS_BINARIES is not: the upgrade from the published executables needs both, and was NOT tested.'],
    });
    expect(upgradePlan({ SMURG_PREVIOUS_BINARIES: OLD_040, SMURG_PREVIOUS_BINARY: OLD_050 }, there([OLD_040]))).toEqual({
      kind: 'failed',
      problems: ['SMURG_PREVIOUS_BINARIES is set and SMURG_SEA_BINARY is not: the upgrade from the published executables needs both, and was NOT tested.'],
    });
    // A list that names nothing is a variable that is not set.
    expect(upgradePlan({ SMURG_PREVIOUS_BINARIES: '::', SMURG_SEA_BINARY: BUILT }, there([BUILT])).kind).toBe('failed');
  });
});

// ---- the test file itself, as a person runs it

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const CLI_DIR = join(REPO_ROOT, 'packages', 'cli');
/** vitest's own entry (`vitest run …` is this file run by node), found the way node finds the package. */
const VITEST = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

/**
 * `vitest run test/sea-upgrade.test.ts` in packages/cli (where `pnpm --filter @smurg/cli exec` runs it), with the
 * default reporter and nothing of this run's own vitest in its environment.
 */
function runUpgradeTest(env: Readonly<Record<string, string>>): Promise<Ran> {
  // (No colours either: a runner started from a terminal passes FORCE_COLOR on, and the lines are compared as text.)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VITEST|SMURG_SEA_|SMURG_PREVIOUS_|SMURG_RELEASE_GATE$|NODE_ENV$|CI$|FORCE_COLOR$|COLORTERM$)/.test(name)));
  return new Promise((done) => {
    execFile(
      process.execPath,
      [VITEST, 'run', 'test/sea-upgrade.test.ts'],
      { cwd: CLI_DIR, env: { ...inherited, SMURG_LANG: 'en', NO_COLOR: '1', ...env }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}

describe('a run of test/sea-upgrade.test.ts that does not test the upgrade says so', () => {
  it('without the variables: the SKIPPED line is on stderr (outside any test body: every reporter shows it), and the run is green', async () => {
    const ran = await runUpgradeTest({});
    expect(ran.stderr).toContain(`${UPGRADE_SKIPPED}\n`);
    expect(ran.stdout).toMatch(/Tests\s+1 skipped \(1\)/);
    expect(ran.code).toBe(0);
  }, 150_000);

  it('for a release\'s gate (SMURG_RELEASE_GATE=1) without the variables: it FAILS', async () => {
    const ran = await runUpgradeTest({ SMURG_RELEASE_GATE: '1' });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('SMURG_RELEASE_GATE=1 and the upgrade from the published executables was NOT tested');
    expect(ran.stdout).toMatch(/Tests\s+1 failed/);
    expect(ran.stderr).not.toContain('SKIPPED');
  }, 150_000);

  it('with only one of the two variables: it FAILS and names the missing one', async () => {
    const ran = await runUpgradeTest({ SMURG_SEA_BINARY: process.execPath });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('SMURG_SEA_BINARY is set and SMURG_PREVIOUS_BINARIES is not: the upgrade from the published executables needs both, and was NOT tested.');
    expect(ran.stdout).toMatch(/Tests\s+1 failed/);
  }, 150_000);

  it('a named executable that is not there (the guide\'s command, typed at the root, before the build): one plain sentence that says where it looked, no TypeError', async () => {
    // A scratch folder stands in for the downloads: one old executable that is there (any executable file), one that is not.
    const scratch = await createTempDir('sea-asked');
    cleanups.push(() => removeTempDir(scratch));
    const old = join(scratch, 'v0.4.0', 'smurg-darwin-arm64');
    await mkdir(dirname(old), { recursive: true });
    await writeFile(old, '#!/bin/sh\nexit 0\n');
    await chmod(old, 0o755);
    const gone = join(scratch, 'v0.5.0', 'smurg-darwin-arm64');
    const built = 'packages/cli/dist/no-such-build/smurg-darwin-arm64';
    const ran = await runUpgradeTest({ SMURG_PREVIOUS_BINARIES: `${old}:${gone}`, SMURG_SEA_BINARY: built });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(`SMURG_PREVIOUS_BINARIES names an executable that cannot be run: ${gone}: there is no such file.`);
    expect(ran.stderr).toContain(`SMURG_SEA_BINARY names an executable that cannot be run: ${built} (read from the repository's root: ${join(REPO_ROOT, built)}): there is no such file.`);
    expect(`${ran.stdout}\n${ran.stderr}`).not.toContain('TypeError');
    // Nothing was started: the one failure is the sentence, and no test of an old executable ran.
    expect(ran.stdout).toMatch(/Tests\s+1 failed \(1\)/);
  }, 150_000);
});
