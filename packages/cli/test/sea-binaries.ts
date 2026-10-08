// TEST ONLY: which real executables the opt-in tests run (sea.test.ts, sea-update.test.ts, sea-upgrade.test.ts), read
// from the environment the way the documents print the commands.
//
// The commands of docs/RELEASING.md are typed at the repository's root, and `pnpm --filter @smurg/cli exec vitest`
// runs vitest in packages/cli: a path that is not absolute is therefore read from the ROOT, never from the folder the
// runner happens to be in (0.5.1, sceptics V2-1 and V5-4: `SMURG_SEA_BINARY=packages/cli/dist/smurg-darwin-arm64` as
// printed named packages/cli/packages/cli/dist/..., and the test failed with a TypeError that said nothing of it).
// A named executable that is not there is a plain sentence, said before any test starts one.
//
// The upgrade test (sea-upgrade.test.ts) is the one step of a release that proves the upgrade from the PUBLISHED
// executables, so not running it must never read as "covered" (sceptic V5-3):
//   - neither variable set: SKIPPED, with one line on stderr (the test file writes it outside any test body, so every
//     reporter shows it); with SMURG_RELEASE_GATE=1 that is a FAILURE: a release's gate does not pass without it;
//   - only one of the two set (a misspelled or forgotten variable): a FAILURE that names the missing one;
//   - both set: every named file must be an executable file, else a FAILURE that names the variable, the path as it
//     was given and the place that was looked at.
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const SEA_BINARY_ENV = 'SMURG_SEA_BINARY';
export const PREVIOUS_BINARIES_ENV = 'SMURG_PREVIOUS_BINARIES';
export const RELEASE_GATE_ENV = 'SMURG_RELEASE_GATE';

type Env = Readonly<Record<string, string | undefined>>;

export interface BinaryDeps {
  /** Where a path that is not absolute is read from (default: the repository's root). */
  readonly root?: string;
  /** What is at a path: an executable file, a file that may not be executed, something else, or nothing. */
  readonly lookAt?: (path: string) => 'executable' | 'not-executable' | 'not-a-file' | 'missing';
}

function lookAtPath(path: string): 'executable' | 'not-executable' | 'not-a-file' | 'missing' {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch {
    return 'missing';
  }
  if (!isFile) return 'not-a-file';
  try {
    accessSync(path, fsConstants.X_OK);
    return 'executable';
  } catch {
    return 'not-executable';
  }
}

/** `path` as the person typed it at the repository's root. */
export function fromRepoRoot(path: string, root: string = REPO_ROOT): string {
  return resolve(root, path);
}

/** Why the file `variable` names cannot be run, as one plain sentence; null when it is an executable file. */
export function executableProblem(variable: string, given: string, deps: BinaryDeps = {}): string | null {
  const path = fromRepoRoot(given, deps.root);
  const found = (deps.lookAt ?? lookAtPath)(path);
  if (found === 'executable') return null;
  const where = isAbsolute(given) ? given : `${given} (read from the repository's root: ${path})`;
  const what = found === 'missing' ? 'there is no such file' : found === 'not-a-file' ? 'it is not a file' : 'the file may not be executed (chmod +x)';
  return `${variable} names an executable that cannot be run: ${where}: ${what}.`;
}

/** The executable SMURG_SEA_BINARY names (absolute), or null when the variable is not set. */
export function seaBinary(env: Env = process.env, deps: BinaryDeps = {}): string | null {
  const given = env[SEA_BINARY_ENV];
  return given === undefined || given === '' ? null : fromRepoRoot(given, deps.root);
}

/** For a `beforeAll` of a suite that runs SMURG_SEA_BINARY: throws the plain sentence when the file cannot be run. */
export function requireSeaBinary(env: Env = process.env, deps: BinaryDeps = {}): void {
  const given = env[SEA_BINARY_ENV];
  if (given === undefined || given === '') return;
  const problem = executableProblem(SEA_BINARY_ENV, given, deps);
  if (problem !== null) throw new Error(problem);
}

export const UPGRADE_SKIPPED =
  `[sea-upgrade] SKIPPED: the upgrade from the published executables was NOT tested. It needs ${PREVIOUS_BINARIES_ENV} (one or more published smurg executables, separated by "${delimiter}") ` +
  `and ${SEA_BINARY_ENV} (the build of this tree). See the top of packages/cli/test/sea-upgrade.test.ts.`;

export type UpgradePlan =
  /** Both variables are set and every file is an executable: `previous` then `next`, absolute. */
  | { readonly kind: 'run'; readonly next: string; readonly previous: readonly string[] }
  /** Neither variable is set (and this is not a release's gate): one line for stderr. */
  | { readonly kind: 'skipped'; readonly line: string }
  /** The run was asked for and cannot be what was asked: one plain sentence per problem. */
  | { readonly kind: 'failed'; readonly problems: readonly string[] };

/** What sea-upgrade.test.ts does with this environment (see the top of this file). */
export function upgradePlan(env: Env = process.env, deps: BinaryDeps = {}): UpgradePlan {
  const next = env[SEA_BINARY_ENV] ?? '';
  const previous = (env[PREVIOUS_BINARIES_ENV] ?? '').split(delimiter).filter((path) => path !== '');
  if (next === '' && previous.length === 0) {
    if (env[RELEASE_GATE_ENV] !== '1') return { kind: 'skipped', line: UPGRADE_SKIPPED };
    return {
      kind: 'failed',
      problems: [
        `${RELEASE_GATE_ENV}=1 and the upgrade from the published executables was NOT tested: a release's gate needs ${PREVIOUS_BINARIES_ENV} (the published smurg executables, separated by "${delimiter}") and ${SEA_BINARY_ENV} (the build of this tree).`,
      ],
    };
  }
  if (next === '' || previous.length === 0) {
    const [set, missing] = next === '' ? [PREVIOUS_BINARIES_ENV, SEA_BINARY_ENV] : [SEA_BINARY_ENV, PREVIOUS_BINARIES_ENV];
    return { kind: 'failed', problems: [`${set} is set and ${missing} is not: the upgrade from the published executables needs both, and was NOT tested.`] };
  }
  const problems = [...previous.map((path) => executableProblem(PREVIOUS_BINARIES_ENV, path, deps)), executableProblem(SEA_BINARY_ENV, next, deps)].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) return { kind: 'failed', problems };
  return { kind: 'run', next: fromRepoRoot(next, deps.root), previous: previous.map((path) => fromRepoRoot(path, deps.root)) };
}
