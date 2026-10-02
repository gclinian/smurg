// TEST ONLY: shared pieces of the CLI's tests — an injected CliIo (captured output, a fake terminal, signals), a short
// private SMURG_HOME (its run dir must fit macOS's 103-byte socket paths) plus a fake HOME, and the daemon fixture
// process. Every process a test starts is recorded and only that pid is ever signalled (ARCHITECTURE §0 rule 1).
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, createTempRunDir, registerTestProcess, removeTempDir, removeTempRunDir, waitFor } from '@smurg/daemon/testing';
import type { SessionInfo } from '@smurg/protocol';
import type { AttachTerminal, CliIo, CliSignal } from '../src/cli/io.ts';

export const CLI_MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
export const DAEMON_FIXTURE = fileURLToPath(new URL('./fixtures/daemon-proc.ts', import.meta.url));

export interface Dirs {
  /** SMURG_HOME: short, 0700 (OS temp dir when short enough, else /tmp). */
  readonly stateDir: string;
  /** A fake HOME with a project folder inside. */
  readonly home: string;
  readonly project: string;
  cleanup(): Promise<void>;
}

export async function makeDirs(): Promise<Dirs> {
  const stateDir = await createTempRunDir();
  const base = await createTempDir('cli');
  const home = join(base, 'home');
  const project = join(home, 'project');
  await mkdir(project, { recursive: true });
  return {
    stateDir,
    home,
    project,
    cleanup: async () => {
      await removeTempRunDir(stateDir);
      await removeTempDir(base);
    },
  };
}

export interface FakeTerminal extends AttachTerminal {
  readonly written: Uint8Array[];
  rawMode: boolean;
  rawModeHistory: boolean[];
  released: boolean;
  cols: number;
  rows: number;
  type(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  text(): string;
}

export function fakeTerminal(options: { readonly isTTY?: boolean; readonly cols?: number; readonly rows?: number } = {}): FakeTerminal {
  const input = new EventEmitter();
  const resize = new EventEmitter();
  const term: FakeTerminal = {
    isTTY: options.isTTY ?? true,
    written: [],
    rawMode: false,
    rawModeHistory: [],
    released: false,
    cols: options.cols ?? 100,
    rows: options.rows ?? 30,
    size: () => ({ cols: term.cols, rows: term.rows }),
    setRawMode: (on) => {
      term.rawMode = on;
      term.rawModeHistory.push(on);
    },
    write: (data) => {
      term.written.push(typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
    },
    onInput: (handler) => {
      input.on('data', handler);
      return () => input.off('data', handler);
    },
    onResize: (handler) => {
      resize.on('resize', handler);
      return () => resize.off('resize', handler);
    },
    releaseInput: () => {
      term.released = true;
    },
    type: (data) => input.emit('data', typeof data === 'string' ? new TextEncoder().encode(data) : data),
    resize: (cols, rows) => {
      term.cols = cols;
      term.rows = rows;
      resize.emit('resize');
    },
    text: () => Buffer.concat(term.written.map((w) => Buffer.from(w))).toString('utf8'),
  };
  return term;
}

export interface TestIo extends CliIo {
  readonly out: () => string;
  readonly err: () => string;
  readonly terminal: FakeTerminal;
  readonly exits: number[];
  readonly opened: string[];
  signal(signal: CliSignal): void;
  runExitHandlers(): void;
}

export function testIo(options: {
  readonly env: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly terminal?: FakeTerminal;
  readonly openUrl?: (url: string) => Promise<boolean>;
  readonly readSecret?: (prompt: string) => Promise<string | null>;
  /** CliIo.readLine (a y/N question at a terminal); absent: no answer (null), as without a terminal. */
  readonly readLine?: (prompt: string) => Promise<string | null>;
  readonly now?: () => number;
  /** CliIo.delay (the login's polling); absent: real timers. */
  readonly delay?: (ms: number) => Promise<void>;
}): TestIo {
  let out = '';
  let err = '';
  const signals = new EventEmitter();
  const exitHandlers = new Set<() => void>();
  const exits: number[] = [];
  const opened: string[] = [];
  const io: TestIo = {
    env: options.env,
    cwd: options.cwd ?? (options.env['HOME'] as string),
    stdout: { write: (chunk) => (out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')) },
    stderr: { write: (chunk) => (err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')) },
    terminal: options.terminal ?? fakeTerminal(),
    onSignal: (signal, handler) => {
      signals.on(signal, handler);
      return () => signals.off(signal, handler);
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    openUrl: async (url) => {
      opened.push(url);
      return options.openUrl ? options.openUrl(url) : false;
    },
    readSecret: (prompt) => (options.readSecret ? options.readSecret(prompt) : Promise.resolve(null)),
    readLine: (prompt) => (options.readLine ? options.readLine(prompt) : Promise.resolve(null)),
    exit: (code) => {
      exits.push(code);
    },
    now: options.now ?? (() => Date.now()),
    ...(options.delay ? { delay: options.delay } : {}),
    out: () => out,
    err: () => err,
    exits,
    opened,
    signal: (signal) => {
      signals.emit(signal);
    },
    runExitHandlers: () => {
      for (const handler of [...exitHandlers]) handler();
    },
  };
  return io;
}

/** The environment every spawned CLI / daemon process gets: nothing from the developer's own environment. */
export function isolatedEnv(dirs: Dirs, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: dirs.home,
    SMURG_HOME: dirs.stateDir,
    // A CLI started by a test never opens a browser (the owner's real one): see cli/io.ts browserBlock.
    SMURG_NO_BROWSER: '1',
    // … and never asks downloads.smurg.ai whether a newer version exists (`smurg host`'s notice, update/notice.ts).
    SMURG_NO_UPDATE_CHECK: '1',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    ...extra,
  };
}

export interface DaemonProc {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly ctlPath: string;
  /** The host terminal the fixture opened at the start (`hostTerminal`), else null. */
  readonly session: SessionInfo | null;
  /** SIGTERM (graceful) to the recorded pid, then wait for exit. */
  stop(): Promise<void>;
  /** SIGKILL to the recorded pid (a daemon crash), then wait for exit. */
  crash(): Promise<void>;
  readonly exited: Promise<number | null>;
}

function assertOwnChild(pid: number | undefined): number {
  if (!Number.isInteger(pid) || (pid as number) <= 1 || pid === process.pid) throw new Error('refusing to signal a pid this test did not start');
  return pid as number;
}

/**
 * `hostTerminal`: the title of a terminal session of the host the fixture opens before it is ready (the control socket
 * cannot open sessions, review F1; in production the host opens them in the web app).
 */
export async function startDaemonProc(dirs: Dirs, workspaceId: string, options: { readonly hostTerminal?: string } = {}): Promise<DaemonProc> {
  const args = [DAEMON_FIXTURE, dirs.project, workspaceId, ...(options.hostTerminal !== undefined ? [options.hostTerminal] : [])];
  const child = spawn(process.execPath, args, { env: isolatedEnv(dirs), stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = assertOwnChild(child.pid);
  registerTestProcess(pid, dirs.project); // its argv; ended after the run if this worker dies before stop()
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  let alive = true;
  void exited.then(() => {
    alive = false;
  });
  try {
    await waitFor(() => /ready (\S+)/.test(stdout) || !alive, { timeoutMs: 20_000, what: 'the daemon fixture to start' });
  } catch (err) {
    if (alive) process.kill(pid, 'SIGKILL');
    throw err;
  }
  if (!alive) throw new Error(`daemon fixture exited early: ${stderr.slice(0, 2000)}`);
  const ctlPath = (/ready (\S+)/.exec(stdout) as RegExpExecArray)[1] as string;
  const sessionLine = /^session (.+)$/m.exec(stdout);
  const session = sessionLine ? (JSON.parse(sessionLine[1] as string) as SessionInfo) : null;
  const signalOnce = async (signal: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
    if (alive) process.kill(pid, signal);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (alive) process.kill(pid, 'SIGKILL');
    await exited;
  };
  return { child, pid, ctlPath, session, stop: () => signalOnce('SIGTERM'), crash: () => signalOnce('SIGKILL'), exited };
}
