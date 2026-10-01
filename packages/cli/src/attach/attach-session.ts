// `smurg attach`: one session in the person's own terminal (SPEC R4; ARCHITECTURE §7.6 "PTY"; pty-packaging.md §6.4,
// V6, V8). The terminal goes into raw mode; the daemon's snapshot is painted after a reset, then live output follows
// by absolute byte offset (no gap, no duplicate); keystrokes and SIGWINCH go to the session only when this person OWNS
// it (everyone else is read-only with a notice: suggestions are the way to steer someone else's agent, R6); Ctrl-]
// detaches (also in its kitty / CSI-u form). The output goes through an allow-list filter (./output-filter.ts): no
// query, OSC 52, DCS, APC or other unknown sequence reaches the local terminal (the daemon's mirror answers queries). The local terminal is restored on EVERY way out: detach, the session's exit (whose exit
// code becomes ours), a lost connection, a signal, an exception, process exit.
import { EXEC_INPUT_MAX_BYTES, can, type SessionInfo } from '@smurg/protocol';
import type { WorkspaceChannel } from '../channel/channel.ts';
import type { ChannelEnd } from '../channel/channel.ts';
import type { AttachTerminal, CliIo, CliSignal } from '../cli/io.ts';
import { OutputFilter } from './output-filter.ts';

/** Ctrl-] (the telnet convention) and its CSI-u form (an app that enabled the kitty keyboard protocol). */
export const DETACH_BYTE = 0x1d;
const DETACH_CSI_U = Buffer.from('\x1b[93;5u', 'latin1');

/**
 * Modes a remote TUI may have switched on in the local terminal, all reset on the way out: alternate screen, mouse
 * tracking and encodings, bracketed paste, focus events, colour-scheme notifications, cursor keys / keypad, wraparound,
 * scroll region (without moving the cursor), SGR, cursor shape, cursor visible.
 */
export const TERMINAL_RESTORE =
  '\x1b[?1049l' +
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l' +
  '\x1b[?2004l' +
  '\x1b[?1004l' +
  '\x1b[?2031l' +
  '\x1b[?1l\x1b>' +
  '\x1b[?7h' +
  '\x1b7\x1b[r\x1b8' +
  '\x1b[0m' +
  '\x1b[ q' +
  '\x1b[?25h';

/** Save / restore the window title around our notices (XTWINOPS 22/23; ignored by terminals without it). */
const TITLE_PUSH = '\x1b[22;0t';
const TITLE_POP = '\x1b[23;0t';
/** Resets the terminal before a snapshot is painted (RIS), as the snapshot contract says. */
const RESET = '\x1bc';

const PTY_COLS = { min: 20, max: 500 };
const PTY_ROWS = { min: 5, max: 200 };

export type AttachOutcome =
  | { readonly kind: 'detached' }
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'ended'; readonly end: ChannelEnd }
  | { readonly kind: 'signal'; readonly signal: CliSignal };

export interface AttachSessionOptions {
  readonly channel: WorkspaceChannel;
  readonly session: SessionInfo;
  readonly terminal: AttachTerminal;
  readonly io: Pick<CliIo, 'onExit' | 'onSignal'>;
  /** The local terminal takes UTF-8 (default true; false: only ASCII text is passed, see output-filter.ts). */
  readonly utf8?: boolean;
}

function clampSize(size: { readonly cols: number; readonly rows: number }): { cols: number; rows: number } {
  const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.floor(n)));
  return { cols: clamp(size.cols, PTY_COLS.min, PTY_COLS.max), rows: clamp(size.rows, PTY_ROWS.min, PTY_ROWS.max) };
}

/** Where the detach key is in `chunk` (-1: not there). */
export function findDetach(chunk: Uint8Array): number {
  const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const byte = buf.indexOf(DETACH_BYTE);
  const csi = buf.indexOf(DETACH_CSI_U);
  if (byte < 0) return csi;
  if (csi < 0) return byte;
  return Math.min(byte, csi);
}

/** kitty keyboard mode pushes minus pops in `bytes` (each push must be popped when we leave). */
function kittyDelta(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let delta = 0;
  for (const _ of text.matchAll(/\x1b\[>\d*u/g)) delta += 1;
  for (const match of text.matchAll(/\x1b\[<(\d*)u/g)) delta -= match[1] ? Number(match[1]) : 1;
  return delta;
}

function title(text: string): string {
  // eslint-disable-next-line no-control-regex
  return `\x1b]2;${text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')}\x07`;
}

const SIGNAL_CODE: Readonly<Record<CliSignal, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export function signalExitCode(signal: CliSignal): number {
  return SIGNAL_CODE[signal];
}

/** Runs the attach until detach / exit / end; the terminal is restored before this resolves. */
export function attachSession(options: AttachSessionOptions): Promise<AttachOutcome> {
  const { channel, terminal, io } = options;
  const me = channel.welcome.member.userId;
  let session = options.session;
  const sessionId = session.id;
  /** The owner (who opened it) drives the PTY size (resize policy `owner`). */
  const isOwner = session.ownerUserId === me;
  /** The host and 「可使用 agent」 type into any session (`session.drive`, ARCHITECTURE §11 D-15); others only watch. */
  const canType = can(channel.welcome.member.role, 'session.drive');
  const newFilter = (): OutputFilter => new OutputFilter({ utf8: options.utf8 ?? true });
  let filter = newFilter();
  let kitty = 0;
  let ptySize = { cols: session.cols, rows: session.rows };
  /** Output up to this absolute offset is on the screen. */
  let expected = 0;
  /** Live output that arrived before the attach answer was painted. */
  let pending: { offset: number; data: Uint8Array }[] | null = [];
  /** The session's exit, seen in a session.state (it never reverts; it may arrive while the attach answer is pending). */
  let exitedState: SessionInfo | null = session.status === 'exited' ? session : null;
  let finished = false;
  let rawMode = false;
  let lastBell = 0;
  const disposers: (() => void)[] = [];
  let resolveOutcome: (outcome: AttachOutcome) => void = () => {};
  const done = new Promise<AttachOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const write = (data: string | Uint8Array): void => {
    try {
      terminal.write(data);
    } catch {
      // stdout is gone (terminal closed): nothing left to show.
    }
  };

  const out = (bytes: Uint8Array): void => {
    if (finished) return;
    // An unfinished sequence stays inside the filter (across chunks and pauses): it is never written half-way.
    const clean = filter.push(bytes);
    kitty = Math.max(0, kitty + kittyDelta(clean));
    if (clean.length > 0) write(clean);
  };

  /** Back to how the terminal was: cooked mode, modes reset, our title popped. Runs once, on every way out. */
  const restore = (message?: string): void => {
    if (!rawMode) {
      if (message) write(`${message}\r\n`);
      return;
    }
    rawMode = false;
    try {
      terminal.setRawMode(false);
    } catch {
      // not a terminal any more
    }
    write(`${TERMINAL_RESTORE}${'\x1b[<u'.repeat(kitty)}${TITLE_POP}${message ? `\r\n${message}\r\n` : '\r\n'}`);
    try {
      terminal.releaseInput();
    } catch {
      // already released
    }
  };

  const finish = (outcome: AttachOutcome, message: string): void => {
    if (finished) return;
    finished = true;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // keep going: the terminal must be restored
      }
    }
    restore(message);
    resolveOutcome(outcome);
  };

  const deliver = (offset: number, data: Uint8Array): void => {
    const end = offset + data.length;
    if (end <= expected) return; // already painted by the snapshot / an earlier chunk
    const skip = Math.max(0, expected - offset);
    out(skip > 0 ? data.subarray(skip) : data);
    expected = end;
  };

  const updateTitle = (status: 'online' | 'host-offline' | 'reconnecting' = 'online'): void => {
    const local = terminal.size();
    const parts = [`smurg：${session.title}`];
    if (!canType) parts.push('唯讀');
    if (status === 'host-offline') parts.push('主人已離線，等待重新連線…');
    if (status === 'reconnecting') parts.push('重新連線中…');
    if (!isOwner && local && (local.cols < ptySize.cols || local.rows < ptySize.rows)) parts.push(`session 視窗是 ${ptySize.cols}×${ptySize.rows}，請放大終端機`);
    write(title(parts.join(' — ')));
  };

  const exitedMessage = (s: SessionInfo): string => `[smurg] session 已結束（結束代碼 ${s.exitCode ?? 0}）。`;

  const requestAttach = async (): Promise<void> => {
    pending = [];
    const local = terminal.size();
    const viewport = local ? clampSize(local) : null;
    let result;
    try {
      result = await channel.request('session.attach', { sessionId, ...(viewport ? { cols: viewport.cols, rows: viewport.rows } : {}) });
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : '無法接上 session';
      finish({ kind: 'ended', end: { reason: 'closed', message } }, `[smurg] ${message}`);
      return;
    }
    if (finished) return;
    session = result.session;
    ptySize = { cols: result.cols, rows: result.rows };
    if (result.mode === 'snapshot') {
      // A fresh picture: whatever sequence the old stream left unfinished is gone.
      filter = newFilter();
      out(new TextEncoder().encode(RESET));
      out(result.data);
    } else {
      out(result.data);
    }
    expected = result.nextOffset;
    const queued = pending ?? [];
    pending = null;
    for (const chunk of queued) deliver(chunk.offset, chunk.data);
    updateTitle();
    if (result.session.status === 'exited') exitedState ??= result.session;
    if (exitedState) finish({ kind: 'exited', exitCode: exitedState.exitCode ?? 0 }, exitedMessage(exitedState));
  };

  // ---- listeners first: output that follows the attach answer must not be missed
  disposers.push(
    channel.on('exec.output', (payload) => {
      if (payload.sessionId !== sessionId) return;
      if (pending) pending.push({ offset: payload.offset, data: payload.data });
      else deliver(payload.offset, payload.data);
    }),
    channel.on('exec.resize', (payload) => {
      if (payload.sessionId !== sessionId) return;
      ptySize = { cols: payload.cols, rows: payload.rows };
      updateTitle();
    }),
    channel.on('session.state', (payload) => {
      if (payload.session.id !== sessionId) return;
      session = payload.session;
      if (session.status === 'exited') exitedState = session;
      // While the attach answer is pending, its queued output is painted first (requestAttach finishes then).
      if (exitedState && pending === null) finish({ kind: 'exited', exitCode: exitedState.exitCode ?? 0 }, exitedMessage(exitedState));
    }),
    channel.onEnd((end) => finish({ kind: 'ended', end }, `[smurg] ${end.message}`)),
    channel.onRestart(() => {
      // The daemon started a fresh channel (our viewer is gone): attach again; the snapshot repaints everything.
      if (!finished) void requestAttach();
    }),
    channel.onStatus((status) => updateTitle(status)),
    io.onExit(() => finish({ kind: 'detached' }, '')),
  );
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    disposers.push(io.onSignal(signal, () => finish({ kind: 'signal', signal }, `[smurg] 收到 ${signal}，已離開 session（session 仍在執行）。`)));
  }

  const sendInput = (data: Uint8Array): void => {
    for (let start = 0; start < data.length; start += EXEC_INPUT_MAX_BYTES) {
      channel.notify('exec.input', { sessionId, data: data.slice(start, Math.min(data.length, start + EXEC_INPUT_MAX_BYTES)) });
    }
  };

  // ---- raw mode and input
  write(TITLE_PUSH);
  try {
    terminal.setRawMode(true);
    rawMode = true;
  } catch {
    finish({ kind: 'ended', end: { reason: 'closed', message: '無法把終端機切換到原始模式' } }, '[smurg] 無法把終端機切換到原始模式。');
    return done;
  }
  disposers.push(
    terminal.onInput((chunk) => {
      if (finished) return;
      const cut = findDetach(chunk);
      const data = cut >= 0 ? chunk.subarray(0, cut) : chunk;
      if (data.length > 0) {
        if (canType && session.status !== 'exited') sendInput(data);
        else if (!canType) {
          // Read-only: a bell at most once a second instead of silently eating keys; the title says why.
          const now = Date.now();
          if (now - lastBell > 1_000) {
            lastBell = now;
            write('\x07');
          }
        }
      }
      if (cut >= 0) {
        channel.notify('session.detach', { sessionId });
        finish({ kind: 'detached' }, '[smurg] 已離開 session（session 仍在執行，可以再用 smurg attach 接上）。');
      }
    }),
    terminal.onResize(() => {
      const local = terminal.size();
      if (isOwner && local) {
        const size = clampSize(local);
        channel.notify('exec.resize', { sessionId, cols: size.cols, rows: size.rows });
      } else {
        updateTitle();
      }
    }),
  );
  void requestAttach();
  return done;
}

/** The zh-TW line printed BEFORE the terminal is taken over, for someone whose role may not type into sessions. */
export function readOnlyNotice(session: SessionInfo): string {
  return `唯讀模式：這個 session 是 ${session.ownerName} 開的，你的角色不能在 session 裡輸入（想參與可以在網頁上提出建議）。按 Ctrl-] 離開。`;
}
