// Everything a command touches outside its own arguments: environment, working directory, streams, the terminal,
// signals, the browser opener and the network constructors. Commands get it injected, so every command runs in tests
// with a fake home, a temp SMURG_HOME, captured output and a fake terminal. processIo() is the real process.
import { execFile } from 'node:child_process';

export interface OutputStream {
  write(chunk: string | Uint8Array): unknown;
}

/** The local terminal `smurg attach` takes over. */
export interface AttachTerminal {
  /** stdin AND stdout are terminals. */
  readonly isTTY: boolean;
  /** Current size, or null when unknown. */
  size(): { readonly cols: number; readonly rows: number } | null;
  setRawMode(on: boolean): void;
  write(data: string | Uint8Array): void;
  /** Keystrokes (raw bytes). Returns an unsubscribe function. */
  onInput(handler: (chunk: Uint8Array) => void): () => void;
  /** The window was resized (SIGWINCH). */
  onResize(handler: () => void): () => void;
  /** Stops reading stdin so the process can exit. */
  releaseInput(): void;
}

export type CliSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly terminal: AttachTerminal;
  onSignal(signal: CliSignal, handler: () => void): () => void;
  /** Runs `handler` when the process exits for any reason (the last chance to restore the terminal). */
  onExit(handler: () => void): () => void;
  /**
   * Opens a URL in the person's browser; false when that is not possible or not allowed (the URL is printed anyway).
   * processIo() never opens one for an automated run, over SSH or without a terminal (browserBlock()).
   */
  openUrl(url: string): Promise<boolean>;
  /**
   * One line typed or pasted by the person, NOT echoed (a terminal: `prompt` goes to stderr, echo off), or the first
   * line of a piped stdin. null when cancelled (Ctrl-C, Ctrl-D, end of input). For secrets that must not be on the
   * command line (argv is visible in `ps` and lands in shell history).
   */
  readSecret(prompt: string): Promise<string | null>;
  /** Leaves immediately with `code` (a second Ctrl-C while stopping). */
  exit(code: number): void;
  /**
   * Changes the process's working directory (`smurg host` runs its daemon from a directory of its own; `cwd` above
   * keeps the directory the command was typed in). Absent: nothing changes (tests that run a command in-process).
   */
  chdir?(dir: string): void;
  /** fetch / WebSocket for the relay; default: the runtime's own. */
  readonly fetch?: typeof globalThis.fetch;
  readonly WebSocket?: typeof globalThis.WebSocket;
  /** Milliseconds since the epoch (tests pin it). */
  now(): number;
  /** Waits `ms` (the login's polling). Absent: a real timer; tests shorten the wait or move their clock instead. */
  delay?(ms: number): Promise<void>;
}

function processTerminal(): AttachTerminal {
  const stdin = process.stdin;
  const stdout = process.stdout;
  return {
    get isTTY() {
      return Boolean(stdin.isTTY && stdout.isTTY);
    },
    size: () => (stdout.isTTY && stdout.columns > 0 && stdout.rows > 0 ? { cols: stdout.columns, rows: stdout.rows } : null),
    setRawMode: (on) => {
      if (stdin.isTTY) stdin.setRawMode(on);
    },
    write: (data) => {
      stdout.write(data);
    },
    onInput: (handler) => {
      const listener = (chunk: Buffer | string): void => handler(typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk);
      stdin.on('data', listener);
      stdin.resume();
      return () => stdin.off('data', listener);
    },
    onResize: (handler) => {
      stdout.on('resize', handler);
      return () => stdout.off('resize', handler);
    },
    releaseInput: () => {
      stdin.pause();
    },
  };
}

/** Why the CLI does not open a browser by itself here; null when it may. */
export type BrowserBlock = 'disabled' | 'ci' | 'ssh' | 'not-a-terminal' | 'no-display' | 'unsupported-platform';

export interface BrowserSituation {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly platform: NodeJS.Platform;
}

/** An environment flag is on unless it is unset, empty, `0` or `false`. */
function flagOn(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * THE decision whether `smurg` may start the person's browser (every command that logs in goes through
 * CliIo.openUrl, and processIo's openUrl asks this first). Fails closed: automated runs (SMURG_NO_BROWSER, CI), SSH
 * sessions (the browser would open on the machine's own screen, or not at all), a stdin / stdout that is not a
 * terminal (scripts, tests, tools) and a Linux without a display never open one; the URL is printed instead.
 */
export function browserBlock(situation: BrowserSituation): BrowserBlock | null {
  const { env } = situation;
  if (flagOn(env['SMURG_NO_BROWSER'])) return 'disabled';
  if (flagOn(env['CI'])) return 'ci';
  if (flagOn(env['SSH_CONNECTION']) || flagOn(env['SSH_CLIENT']) || flagOn(env['SSH_TTY'])) return 'ssh';
  if (!situation.stdinIsTTY || !situation.stdoutIsTTY) return 'not-a-terminal';
  if (situation.platform === 'linux' && !flagOn(env['DISPLAY']) && !flagOn(env['WAYLAND_DISPLAY'])) return 'no-display';
  if (situation.platform !== 'darwin' && situation.platform !== 'linux') return 'unsupported-platform';
  return null;
}

/** macOS `open`, Linux `xdg-open`, never through a shell, and only when browserBlock() allows it. */
export function openInBrowser(url: string, situation: BrowserSituation): Promise<boolean> {
  if (browserBlock(situation) !== null || !/^https?:\/\//.test(url)) return Promise.resolve(false);
  const command = situation.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  return new Promise((resolve) => {
    const child = execFile(command, [url], { timeout: 10_000 }, (err) => resolve(err === null));
    child.on('error', () => resolve(false));
  });
}

const SECRET_MAX_BYTES = 8192;

/** processIo().readSecret: raw mode without echo on a terminal, else the first line of stdin. */
function readSecretFromStdin(prompt: string): Promise<string | null> {
  const stdin = process.stdin;
  const tty = Boolean(stdin.isTTY);
  if (tty) process.stderr.write(prompt);
  return new Promise((resolve) => {
    let text = '';
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      if (tty) {
        try {
          stdin.setRawMode(false);
        } catch {
          // not a terminal any more
        }
        process.stderr.write('\n');
      }
      stdin.pause();
      const line = value?.trim() ?? '';
      resolve(line === '' ? null : line);
    };
    const onEnd = (): void => finish(tty ? null : text);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish(text);
        if (tty && (ch === '\u0003' || (ch === '\u0004' && text === ''))) return finish(null);
        if (tty && (ch === '\u007f' || ch === '\b')) {
          text = text.slice(0, -1);
          continue;
        }
        text += ch;
        if (Buffer.byteLength(text) > SECRET_MAX_BYTES) return finish(null);
      }
    };
    if (tty) {
      try {
        stdin.setRawMode(true);
      } catch {
        // fall through: still read a line
      }
    }
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onEnd);
    stdin.resume();
  });
}

function processSituation(): BrowserSituation {
  return { env: process.env, stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY), platform: process.platform };
}

export function processIo(): CliIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    terminal: processTerminal(),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    onExit: (handler) => {
      process.on('exit', handler);
      return () => process.off('exit', handler);
    },
    openUrl: (url) => openInBrowser(url, processSituation()),
    readSecret: readSecretFromStdin,
    exit: (code) => process.exit(code),
    chdir: (dir) => process.chdir(dir),
    now: () => Date.now(),
  };
}
