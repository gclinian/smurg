// Per-run temp root for the relay (and e2e) vitest projects. miniflare keeps each local relay's Durable Object state
// in os.tmpdir()/miniflare-<hex> and deletes it fire-and-forget on close, so a test fork that exits right after
// stop() leaves it behind (build-quality review F2: ~18 directories, ~2 MB each, per full run). The project config
// points the forks' TMPDIR at a directory named here; the project's globalSetup creates it before any fork starts and
// its teardown (after every fork has exited) removes it with everything inside. Config and globalSetup both run in
// vitest's main process, which is how they share the path. Nothing is created for a project that does not run.
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const ENV_KEY = 'SMURG_TEST_TMP_ROOTS';

function roots(): Record<string, string> {
  try {
    return JSON.parse(process.env[ENV_KEY] ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function prefix(label: string): string {
  return `smurg-${label}-tests-`;
}

/** The temp root of project `label` for this vitest run: named on first use, NOT created (see createProjectTmpRoot). */
export function projectTmpRoot(label: string): string {
  const all = roots();
  const existing = all[label];
  if (existing) return existing;
  const named = join(realpathSync(tmpdir()), `${prefix(label)}${process.pid}-${randomBytes(6).toString('hex')}`);
  process.env[ENV_KEY] = JSON.stringify({ ...all, [label]: named });
  return named;
}

/** globalSetup: creates the root (0700) before the forks start. */
export function createProjectTmpRoot(label: string): void {
  mkdirSync(projectTmpRoot(label), { mode: 0o700 });
}

/** globalSetup teardown: removes the root of `label` (refuses anything that is not such a root). */
export function removeProjectTmpRoot(label: string): void {
  const dir = roots()[label];
  if (!dir) return;
  if (dirname(dir) !== realpathSync(tmpdir()) || !basename(dir).startsWith(prefix(label))) throw new Error(`refusing to remove ${dir}`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
