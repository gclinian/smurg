// Keeps the host awake while sharing (SPEC R1 「主持期間防止電腦進入睡眠」; pty-packaging.md §6.7):
//   macOS: `caffeinate -i -w <daemon pid>` — exits on its own when the daemon dies, even on SIGKILL.
//   Linux: `systemd-inhibit --what=sleep:idle … cat` with cat's stdin a pipe from the daemon — daemon death closes the
//          pipe, cat exits, the inhibitor is released. (Unverified on a real Linux host; ARCHITECTURE §12.)
// stop() signals ONLY the child this service spawned and recorded (ARCHITECTURE §0 rule 1).
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { PowerService, PowerStatus } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface KeepAwakeOptions {
  readonly enabled: boolean;
  readonly log: Logger;
  readonly platform?: NodeJS.Platform;
  /** The process the inhibitor is tied to (default: this daemon). */
  readonly pid?: number;
  readonly spawn?: SpawnFn;
  /** Locates systemd-inhibit (Linux); default: /usr/bin and /bin. */
  readonly findSystemdInhibit?: () => Promise<string | null>;
  /** Override the command (tests): replaces caffeinate / systemd-inhibit with `command args…`, stdin piped. */
  readonly command?: { readonly file: string; readonly args: readonly string[]; readonly mechanism: PowerStatus['mechanism'] };
}

async function defaultFindSystemdInhibit(): Promise<string | null> {
  for (const candidate of ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit']) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

function assertOwnChildPid(pid: number | undefined): pid is number {
  // §0 rule 1: never signal anything but a positive pid we spawned; never ourselves, never pid 1.
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

export class KeepAwake implements PowerService {
  private readonly options: KeepAwakeOptions;
  private readonly spawnFn: SpawnFn;
  private child: ChildProcess | null = null;
  private current: PowerStatus = { active: false, mechanism: 'none', pid: null, reason: 'not started' };
  private exited: Promise<void> | null = null;

  constructor(options: KeepAwakeOptions) {
    this.options = options;
    this.spawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
  }

  status(): PowerStatus {
    return this.current;
  }

  async start(): Promise<PowerStatus> {
    if (this.child) return this.current;
    if (!this.options.enabled) {
      this.current = { active: false, mechanism: 'none', pid: null, reason: 'disabled' };
      return this.current;
    }
    const plan = await this.plan();
    if ('reason' in plan) {
      this.current = { active: false, mechanism: 'none', pid: null, reason: plan.reason };
      this.options.log.warn('keep-awake unavailable', { reason: plan.reason });
      return this.current;
    }
    let child: ChildProcess;
    try {
      child = this.spawnFn(plan.file, plan.args, { stdio: plan.pipeStdin ? ['pipe', 'ignore', 'ignore'] : 'ignore', detached: false });
    } catch (err) {
      this.current = { active: false, mechanism: 'none', pid: null, reason: `spawn failed: ${err instanceof Error ? err.name : 'error'}` };
      return this.current;
    }
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!started || !assertOwnChildPid(child.pid)) {
      this.current = { active: false, mechanism: 'none', pid: null, reason: 'the inhibitor could not be started' };
      this.options.log.warn('keep-awake failed to start', { mechanism: plan.mechanism });
      return this.current;
    }
    this.child = child;
    this.exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.current = { active: false, mechanism: 'none', pid: null, reason: 'the inhibitor exited' };
      this.options.log.warn('keep-awake inhibitor exited', { code: code ?? null, signal: signal ?? null });
    });
    // Neither the child nor its stdin pipe may keep the daemon alive on their own.
    child.unref();
    (child.stdin as { unref?: () => void } | null)?.unref?.();
    this.current = { active: true, mechanism: plan.mechanism, pid: child.pid, reason: null };
    return this.current;
  }

  async stop(): Promise<void> {
    const child = this.child;
    const exited = this.exited;
    this.child = null;
    this.current = { active: false, mechanism: 'none', pid: null, reason: 'stopped' };
    if (!child || !assertOwnChildPid(child.pid)) return;
    try {
      child.stdin?.end();
    } catch {
      // The pipe may already be closed.
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 2_000);
      timer.unref();
    });
    if ((await Promise.race([exited ?? Promise.resolve(), timeout])) === 'timeout' && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }

  private async plan(): Promise<
    | { readonly file: string; readonly args: readonly string[]; readonly mechanism: PowerStatus['mechanism']; readonly pipeStdin: boolean }
    | { readonly reason: string }
  > {
    if (this.options.command) return { ...this.options.command, pipeStdin: true };
    const platform = this.options.platform ?? process.platform;
    const pid = this.options.pid ?? process.pid;
    if (platform === 'darwin') return { file: '/usr/bin/caffeinate', args: ['-i', '-w', String(pid)], mechanism: 'caffeinate', pipeStdin: false };
    if (platform === 'linux') {
      const inhibit = await (this.options.findSystemdInhibit ?? defaultFindSystemdInhibit)();
      if (!inhibit) return { reason: 'systemd-inhibit not found' };
      return {
        file: inhibit,
        args: ['--what=sleep:idle', '--who=smurg', '--why=smurg is sharing a folder', '--mode=block', 'cat'],
        mechanism: 'systemd-inhibit',
        pipeStdin: true,
      };
    }
    return { reason: `unsupported platform ${platform}` };
  }
}
