// Short-lived helper processes of the sessions module (`claude --version`, `claude auth status --json`,
// `claude auth logout`, `security delete-generic-password`): asynchronous (never spawnSync, ARCHITECTURE §0 rule 5),
// bounded output, and a deadline after which the helper is killed. The helper is started detached (setsid ⇒ its own
// process group, pgid = its pid): on timeout that group, which this code created and recorded, is signalled after the
// §0 assertion (integer > 1, not the daemon's pid, not the daemon's own group). When the daemon's group is not known
// the helper's pid alone is signalled.
import { spawn } from 'node:child_process';
import { isSafePgid, ownProcessGroup } from './kill-tree.ts';

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly timedOut: boolean;
  /** The executable could not be started at all. */
  readonly spawnError: boolean;
}

export interface RunOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  /** stdout is cut here (auth status prints a few hundred bytes). */
  readonly maxStdoutBytes?: number;
  /** Aborted: the helper is killed like at the deadline (a guest sandbox that no longer holds, SandboxService.onRevoked). */
  readonly signal?: AbortSignal;
}

export type ProcessRunner = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** Pids of helpers running right now: children of the daemon that belong to no session (kill-tree never targets them). */
const helpers = new Set<number>();

export function runningHelperPids(): ReadonlySet<number> {
  return helpers;
}

export const runProcess: ProcessRunner = async (file, args, options) => {
  const ownPgid = await ownProcessGroup();
  if (options.signal?.aborted === true) return { code: null, signal: null, stdout: '', timedOut: false, spawnError: true };
  return new Promise((resolve) => {
    const maxBytes = options.maxStdoutBytes ?? 1024 * 1024;
    let stdout = '';
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { cwd: options.cwd, env: { ...options.env }, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: null, signal: null, stdout: '', timedOut: false, spawnError: true });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) helpers.add(pid);
    const kill = (): void => {
      if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
      // Only while the helper itself has not exited: once reaped, its pid (and group id) can be reused by a stranger.
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (ownPgid !== null && isSafePgid(pid, process.pid, ownPgid)) process.kill(-pid, 'SIGKILL');
        else process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = (): void => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < maxBytes) stdout += chunk.slice(0, maxBytes - stdout.length);
    });
    child.on('error', () => {
      if (pid !== undefined) helpers.delete(pid);
      options.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, timedOut, spawnError: true });
    });
    child.on('exit', () => {
      if (pid !== undefined) helpers.delete(pid);
    });
    child.on('close', (code, signal) => {
      if (pid !== undefined) helpers.delete(pid);
      options.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // No signal after 'close': the group may be empty by now and its id free for reuse.
      resolve({ code, signal, stdout, timedOut, spawnError: false });
    });
  });
};
