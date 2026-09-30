// TEST ONLY: a daemon sharing a temp git repository with the real worktree module, plus git helpers that run with an
// isolated HOME and no global/system config (the harness's isolatedGitEnv): nothing touches the developer's git setup.
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HostSettings } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import type { Principal } from '../../src/core/interfaces.ts';
import { createTestDaemon, isolatedGitEnv, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import type { WorktreeManagerImpl, WorktreeModuleOptions } from '../../src/worktree/worktree-manager.ts';

const execFileAsync = promisify(execFile);

export interface WorktreeStack {
  readonly t: TestDaemon;
  readonly manager: WorktreeManagerImpl;
  readonly host: TestClient;
  /** Runs git in `cwd` (default: the shared folder) with the isolated test environment; returns stdout. */
  git(args: readonly string[], cwd?: string): Promise<string>;
  /** Like git(), but resolves with the exit code instead of throwing. */
  gitCode(args: readonly string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  connect(userId: string, role: 'runner' | 'editor' | 'viewer'): Promise<TestClient>;
  principal(userId: string): Principal;
  worktreeDir(worktreeId: string): string;
  cleanup(): Promise<void>;
}

export interface WorktreeStackOptions {
  /** An existing folder to share instead of a fresh temp project (the caller removes it). */
  readonly root?: string;
  readonly files?: Record<string, string>;
  readonly git?: boolean;
  readonly settings?: Partial<HostSettings>;
  readonly module?: WorktreeModuleOptions;
  readonly extraModules?: readonly FeatureModule[];
  /** Modules composed after the worktree module (e.g. a real sessions module). */
  readonly laterModules?: readonly FeatureModule[];
}

export async function startWorktreeStack(options: WorktreeStackOptions = {}): Promise<WorktreeStack> {
  const t = await createTestDaemon({
    modules: [...(options.extraModules ?? []), createWorktreeModule(options.module ?? {}), ...(options.laterModules ?? [])],
    ...(options.root !== undefined
      ? { root: options.root }
      : { project: { git: options.git ?? true, files: options.files ?? { 'README.md': '# demo\n', 'src/app.ts': 'export const answer = 42;\n' } } }),
    ...(options.settings ? { settings: options.settings } : {}),
  });
  const home = join(t.stateDir, '..', '.git-home');
  await mkdir(home, { recursive: true });
  const env = isolatedGitEnv(home);
  const gitCode = async (args: readonly string[], cwd = t.root): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await execFileAsync('git', [...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
  const git = async (args: readonly string[], cwd = t.root): Promise<string> => {
    const result = await gitCode(args, cwd);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`);
    return result.stdout;
  };
  const host = await t.connectHost();
  return {
    t,
    manager: t.ctx.services.worktrees as WorktreeManagerImpl,
    host,
    git,
    gitCode,
    connect: (userId, role) => t.connect({ userId, role }),
    principal: (userId) => {
      const principal = t.ctx.members.principalOf(userId);
      if (!principal) throw new Error(`${userId} is not a member`);
      return principal;
    },
    worktreeDir: (worktreeId) => join(t.ctx.roots.worktreesDir, worktreeId),
    cleanup: () => t.cleanup(),
  };
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function settleError(promise: Promise<unknown>): Promise<{ code: string; reason?: string; detail?: Record<string, unknown>; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: Record<string, unknown> };
    const reason = e.detail?.['reason'];
    return { code: e.code ?? 'unknown', message: e.message ?? '', ...(typeof reason === 'string' ? { reason } : {}), ...(e.detail ? { detail: e.detail } : {}) };
  }
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
