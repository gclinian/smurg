// Keeps the host awake while sharing (SPEC R1: no sleep while hosting; pty-packaging.md §6.7):
//   macOS: `caffeinate -i -w <daemon pid>` — exits on its own when the daemon dies, even on SIGKILL.
//   Linux: `systemd-inhibit --what=sleep:idle … cat` with cat's stdin a pipe from the daemon — daemon death closes the
//          pipe, cat exits, the inhibitor is released. Refused (reason 'refused') for a host started
//          over SSH: polkit's inhibit-block-sleep is allow_any=no (verified on Ubuntu 24.04); unverified with a local
//          desktop session (ARCHITECTURE §12).
// stop() signals ONLY the child this service spawned and recorded (ARCHITECTURE §0 rule 1).
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { PowerReason, PowerService, PowerStatus } from '../core/interfaces.ts';
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

/**
 * How long start() waits for an inhibitor that ends right away before it reports keep-awake as active (linux-binary
 * F5: over SSH, polkit refuses systemd-inhibit's sleep block within ~20 ms, and the start summary said "on" in most
 * runs, then "lost" two seconds later).
 */
const SETTLE_MS = 250;
/** stderr of an inhibitor the system refused (systemd-inhibit through logind / polkit). */
const REFUSED = /access denied|permission denied|not authori[sz]ed|interactive authentication required/i;
/** The most bytes of an inhibitor's stderr kept for the log. */
const STDERR_MAX = 200;

/** The first line of `text`, control characters removed (for the log). */
function firstLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return (text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, STDERR_MAX);
}

function assertOwnChildPid(pid: number | undefined): pid is number {
  // §0 rule 1: never signal anything but a positive pid we spawned; never ourselves, never pid 1.
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

export class KeepAwake implements PowerService {
  private readonly options: KeepAwakeOptions;
  private readonly spawnFn: SpawnFn;
  private child: ChildProcess | null = null;
  private current: PowerStatus = { active: false, mechanism: 'none', pid: null, reason: 'not-started' };
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
      this.options.log.warn('keep-awake unavailable', { reason: plan.reason, ...(plan.platform === undefined ? {} : { platform: plan.platform }) });
      return this.current;
    }
    let child: ChildProcess;
    try {
      // stderr is read (its first line only) so a refusal can say why: over SSH, polkit refuses the sleep block.
      child = this.spawnFn(plan.file, plan.args, { stdio: [plan.pipeStdin ? 'pipe' : 'ignore', 'ignore', 'pipe'], detached: false });
    } catch (err) {
      this.current = { active: false, mechanism: 'none', pid: null, reason: 'spawn-failed' };
      this.options.log.warn('keep-awake failed to spawn', { mechanism: plan.mechanism, error: err instanceof Error ? err.name : 'error' });
      return this.current;
    }
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!started || !assertOwnChildPid(child.pid)) {
      this.current = { active: false, mechanism: 'none', pid: null, reason: 'start-failed' };
      this.options.log.warn('keep-awake failed to start', { mechanism: plan.mechanism });
      return this.current;
    }
    this.child = child;
    this.exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let stderr = '';
    const stderrDone = new Promise<void>((resolve) => {
      const stream = child.stderr;
      if (!stream) return resolve();
      // Read to the end (a full pipe must never stall the inhibitor), keep the first bytes.
      stream.on('data', (chunk: Buffer | string) => {
        if (stderr.length < STDERR_MAX * 4) stderr += String(chunk).slice(0, STDERR_MAX * 4 - stderr.length);
      });
      stream.once('end', () => resolve());
      stream.once('close', () => resolve());
      stream.once('error', () => resolve());
    });
    /** Resolves once an exit of this child was recorded with its reason (never for a child that keeps running). */
    const settled = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        if (this.child !== child) return resolve();
        this.child = null;
        this.current = { active: false, mechanism: 'none', pid: null, reason: 'exited' };
        const tail = new Promise<void>((done) => setTimeout(done, 500));
        void Promise.race([stderrDone, tail]).then(() => {
          const line = firstLine(stderr);
          // e.g. "Failed to inhibit: Access denied" (systemd-inhibit from an SSH session: logind's polkit action
          // org.freedesktop.login1.inhibit-block-sleep is allow_any=no on Ubuntu)
          if (REFUSED.test(line) && this.child === null && this.current.reason === 'exited') {
            this.current = { active: false, mechanism: 'none', pid: null, reason: 'refused' };
          }
          this.options.log.warn('keep-awake inhibitor exited', { code: code ?? null, signal: signal ?? null, ...(line === '' ? {} : { stderr: line }) });
          resolve();
        });
      });
    });
    // Neither the child nor its pipes may keep the daemon alive on their own.
    child.unref();
    (child.stdin as { unref?: () => void } | null)?.unref?.();
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    this.current = { active: true, mechanism: plan.mechanism, pid: child.pid, reason: null };
    // An inhibitor that is refused ends at once: report that, not a keep-awake that is lost a moment later.
    await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))]);
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
    | { readonly reason: PowerReason; readonly platform?: string }
  > {
    if (this.options.command) return { ...this.options.command, pipeStdin: true };
    const platform = this.options.platform ?? process.platform;
    const pid = this.options.pid ?? process.pid;
    if (platform === 'darwin') return { file: '/usr/bin/caffeinate', args: ['-i', '-w', String(pid)], mechanism: 'caffeinate', pipeStdin: false };
    if (platform === 'linux') {
      const inhibit = await (this.options.findSystemdInhibit ?? defaultFindSystemdInhibit)();
      if (!inhibit) return { reason: 'systemd-inhibit-not-found' };
      return {
        file: inhibit,
        args: ['--what=sleep:idle', '--who=smurg', '--why=smurg is sharing a folder', '--mode=block', 'cat'],
        mechanism: 'systemd-inhibit',
        pipeStdin: true,
      };
    }
    return { reason: 'unsupported-platform', platform };
  }
}
