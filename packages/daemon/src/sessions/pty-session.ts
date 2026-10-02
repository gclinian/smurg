// One PTY and everyone watching it (R4; ARCHITECTURE §7.6; pty-packaging.md §6.1, ported from the verifier's
// pty-session-fixed.ts):
//  - node-pty with `encoding: null`: raw bytes, exact absolute offsets, no decode/re-encode;
//  - output coalesced (5 ms / 64 KiB: macOS delivers ~25-byte reads), then fanned out to the headless mirror, the raw
//    tail and every READY viewer, in that order;
//  - attach = raw delta (client offset still in the tail, no resize since) or a full-scrollback mirror snapshot taken
//    exactly at an offset, then the gap, then live: no loss, no duplicate (the V1/V2 fixes: the snapshot uses the whole
//    mirror scrollback and is retried when the PTY is resized while the parser catches up);
//  - resize policy `owner`: the PTY follows the owner's most recently active viewer; everyone else renders at the PTY
//    size (exec.resize to ready viewers only, in stream order with the output);
//  - flow control: the PTY is paused while the mirror lags more than 1 MiB, AND while any ready viewer's connection
//    still has more than 1 MiB queued: all members share ONE socket from the daemon to the relay, so a
//    chatty terminal must not bury everyone's replies, doc sync and heartbeats under tens of megabytes. The program
//    in the PTY then writes at the speed of the slowest live link, as over ssh.
// Who may type is decided by the SessionManager (session.drive: the host, Agent access); this class only tracks which
// viewer drives the size (the owner's, policy `owner`).
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Logger } from '../core/logger.ts';
import { RawTail } from './raw-tail.ts';
import { TermMirror } from './term-mirror.ts';

/** Where a viewer's bytes go (the SessionManager turns these into exec.output / exec.resize on its logical channel). */
export interface ViewerSink {
  /** Live output starting at absolute byte `offset`. */
  output(offset: number, data: Uint8Array): void;
  /** The PTY was resized; the viewer renders at exactly this size from this point of the stream on. */
  resize(cols: number, rows: number): void;
  /**
   * Bytes still queued on the way to this viewer (its connection's send buffer); 0 while it is not connected (then
   * nothing is being pushed to it: output waits in its channel's outbox, or it re-syncs by snapshot).
   */
  backlog?(): number;
}

export interface PtyExit {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface PtySpawnSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtySessionOptions {
  readonly ownerUserId: string;
  readonly spawn: PtySpawnSpec;
  readonly log: Logger;
  /** Mirror scrollback (5000 lines, ≈17 MiB at 120 columns: pty-packaging.md F19). */
  readonly scrollbackLines?: number;
  /** Exact-resume window (2 MiB). */
  readonly rawTailBytes?: number;
  /** Largest serialized snapshot (the session.attach result's `data`). */
  readonly snapshotMaxBytes?: number;
  /** The PTY size changed (owner policy). */
  readonly onResize?: (cols: number, rows: number) => void;
  /** The child exited and the mirror caught up with its last output. */
  readonly onExit?: (exit: PtyExit) => void;
  /** Every flushed output chunk (login hints). Must not throw or block. */
  readonly onOutput?: (chunk: Uint8Array) => void;
}

export interface AttachPlan {
  readonly mode: 'snapshot' | 'delta';
  readonly data: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly nextOffset: number;
  /** After the reply went out: the viewer goes live (the gap since nextOffset first). */
  commit(): void;
}

interface Viewer {
  readonly key: string;
  readonly userId: string;
  readonly sink: ViewerSink;
  cols: number | null;
  rows: number | null;
  lastActive: number;
  ready: boolean;
}

export const COALESCE_MS = 5;
export const COALESCE_BYTES = 64 * 1024;
/** Pause between a paste and the Enter that submits it. */
export const PASTE_ENTER_DELAY_MS = 50;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 128 * 1024;
/** A viewer link queuing more than this pauses the PTY until it is back under VIEWER_LOW_WATER. */
export const VIEWER_HIGH_WATER = 1024 * 1024;
export const VIEWER_LOW_WATER = 256 * 1024;
/** How often a paused PTY looks at the mirror and the viewers' links again. */
const FLOW_POLL_MS = 5;
export const DEFAULT_SCROLLBACK_LINES = 5000;
export const DEFAULT_RAW_TAIL_BYTES = 2 * 1024 * 1024;
/** Clamp of the PTY size (pty-packaging.md §6.1): tiny or huge windows break TUIs and cost mirror memory. */
export const PTY_COLS_MIN = 20;
export const PTY_COLS_MAX = 500;
export const PTY_ROWS_MIN = 5;
export const PTY_ROWS_MAX = 200;
/** node-pty on macOS can report the exit before the last output was read (pty-smoke.test.ts). */
const EXIT_DRAIN_MS = 50;
/** A viewer whose attach never committed (the reply failed) is dropped after this. */
const PENDING_VIEWER_TTL_MS = 30_000;

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.floor(n)));
  return { cols: clamp(cols, PTY_COLS_MIN, PTY_COLS_MAX), rows: clamp(rows, PTY_ROWS_MIN, PTY_ROWS_MAX) };
}

export class PtySession {
  readonly ownerUserId: string;
  readonly pid: number;
  private readonly pty: IPty;
  private readonly mirror: TermMirror;
  private readonly tail: RawTail;
  private readonly log: Logger;
  private readonly scrollbackLines: number;
  private readonly snapshotMaxBytes: number;
  private readonly onResize: ((cols: number, rows: number) => void) | undefined;
  private readonly onExitCb: ((exit: PtyExit) => void) | undefined;
  private readonly onOutputCb: ((chunk: Uint8Array) => void) | undefined;
  private readonly viewers = new Map<string, Viewer>();
  private state: 'running' | 'exiting' | 'exited' = 'running';
  private exitInfo: PtyExit | null = null;
  /** Exited AND the mirror parsed the last output. */
  private finished = false;
  private readonly exitWaiters: (() => void)[] = [];
  private paused = false;
  private pauseTimer: ReturnType<typeof setTimeout> | undefined;
  private lastResizeOffset = 0;
  /** Bumped by every PTY resize: a snapshot taken across one is retried (V2). */
  private resizeGen = 0;
  private activity = 0;
  private currentCols: number;
  private currentRows: number;
  private outBuf: Buffer[] = [];
  private outLen = 0;
  private outTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: PtySessionOptions) {
    this.ownerUserId = options.ownerUserId;
    this.log = options.log;
    this.scrollbackLines = options.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    this.snapshotMaxBytes = options.snapshotMaxBytes ?? 7 * 1024 * 1024;
    this.onResize = options.onResize;
    this.onExitCb = options.onExit;
    this.onOutputCb = options.onOutput;
    const { cols, rows } = clampSize(options.spawn.cols, options.spawn.rows);
    this.currentCols = cols;
    this.currentRows = rows;
    this.mirror = new TermMirror(cols, rows, this.scrollbackLines, (reply) => {
      if (this.state === 'running') this.pty.write(reply);
    });
    this.tail = new RawTail(options.rawTailBytes ?? DEFAULT_RAW_TAIL_BYTES);
    // Everything the child gets is the caller's explicit environment (host-env.ts), never the daemon's own as it is.
    this.pty = pty.spawn(options.spawn.file, [...options.spawn.args], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.spawn.cwd,
      env: { ...options.spawn.env },
      encoding: null,
    });
    this.pid = this.pty.pid;
    this.pty.onData((data: string | Buffer) => this.coalesce(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    this.pty.onExit((exit) => {
      if (this.state !== 'running') return;
      this.state = 'exiting';
      // Give the reader a moment to deliver the last bytes, then finish in stream order.
      setTimeout(() => this.finishExit({ exitCode: exit.exitCode, ...(exit.signal ? { signal: exit.signal } : {}) }), EXIT_DRAIN_MS);
    });
  }

  get running(): boolean {
    return this.state === 'running';
  }

  get exited(): boolean {
    return this.state === 'exited';
  }

  get exit(): PtyExit | null {
    return this.exitInfo;
  }

  get cols(): number {
    return this.currentCols;
  }

  get rows(): number {
    return this.currentRows;
  }

  /** Absolute offset after all output so far (flushed). */
  get offset(): number {
    return this.tail.end;
  }

  /** Viewers attached (pending or live). */
  get viewerCount(): number {
    return this.viewers.size;
  }

  viewerKeys(): string[] {
    return [...this.viewers.keys()];
  }

  // -------------------------------------------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------------------------------------------

  private coalesce(chunk: Buffer): void {
    if (this.disposed || chunk.length === 0) return;
    this.outBuf.push(chunk);
    this.outLen += chunk.length;
    if (this.outLen >= COALESCE_BYTES) this.flushOutput();
    else if (this.outTimer === undefined) this.outTimer = setTimeout(() => this.flushOutput(), COALESCE_MS);
  }

  private flushOutput(): void {
    if (this.outTimer !== undefined) {
      clearTimeout(this.outTimer);
      this.outTimer = undefined;
    }
    if (this.outLen === 0) return;
    const chunk = this.outBuf.length === 1 ? (this.outBuf[0] as Buffer) : Buffer.concat(this.outBuf, this.outLen);
    this.outBuf = [];
    this.outLen = 0;
    const start = this.tail.end;
    this.tail.append(chunk);
    this.mirror.write(chunk);
    for (const viewer of this.viewers.values()) {
      if (!viewer.ready) continue;
      try {
        viewer.sink.output(start, chunk);
      } catch (err) {
        this.log.warn('viewer output failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    try {
      this.onOutputCb?.(chunk);
    } catch (err) {
      this.log.warn('output observer failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
    this.applyFlowControl();
  }

  private applyFlowControl(): void {
    if (this.paused || this.state !== 'running') return;
    if (this.mirror.pendingBytes <= HIGH_WATER && this.viewerBacklog() <= VIEWER_HIGH_WATER) return;
    this.paused = true;
    this.pty.pause();
    const check = (): void => {
      this.pauseTimer = undefined;
      if (this.disposed) return;
      if (this.state !== 'running' || (this.mirror.pendingBytes < LOW_WATER && this.viewerBacklog() < VIEWER_LOW_WATER)) {
        this.paused = false;
        if (this.state === 'running') this.pty.resume();
      } else {
        this.pauseTimer = setTimeout(check, FLOW_POLL_MS);
      }
    };
    this.pauseTimer = setTimeout(check, FLOW_POLL_MS);
  }

  /** The largest send backlog among the ready viewers (a failing probe counts as none: never wedge the PTY on it). */
  private viewerBacklog(): number {
    let max = 0;
    for (const viewer of this.viewers.values()) {
      if (!viewer.ready || viewer.sink.backlog === undefined) continue;
      let bytes = 0;
      try {
        bytes = viewer.sink.backlog();
      } catch {
        bytes = 0;
      }
      if (Number.isFinite(bytes) && bytes > max) max = bytes;
    }
    return max;
  }

  private finishExit(exit: PtyExit): void {
    if (this.disposed) return;
    this.flushOutput();
    this.state = 'exited';
    this.exitInfo = exit;
    this.mirror.muteReplies();
    // The mirror must have parsed the last output before anyone snapshots "the final screen".
    void this.mirror.drained().then(() => {
      this.finished = true;
      for (const waiter of this.exitWaiters.splice(0)) waiter();
      try {
        this.onExitCb?.(exit);
      } catch (err) {
        this.log.error('session exit handler failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    });
  }

  /** Resolves true once the child exited (and the mirror drained), false after `timeoutMs`. */
  waitExit(timeoutMs: number): Promise<boolean> {
    if (this.finished || this.disposed) return Promise.resolve(this.finished);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Viewers
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Prepares the sync of viewer `key` (a logical channel). The owner's `viewport` drives the PTY size BEFORE the sync,
   * so the viewer receives state at the size it will render. Replaces an earlier attach of the same key.
   */
  async attach(key: string, userId: string, sink: ViewerSink, viewport: { cols: number; rows: number } | null, haveOffset?: number): Promise<AttachPlan> {
    if (this.disposed) throw new Error('session disposed');
    const viewer: Viewer = { key, userId, sink, cols: viewport?.cols ?? null, rows: viewport?.rows ?? null, lastActive: 0, ready: false };
    this.viewers.set(key, viewer);
    const pendingTimer = setTimeout(() => {
      if (this.viewers.get(key) === viewer && !viewer.ready) {
        this.viewers.delete(key);
        this.applyResizePolicy();
      }
    }, PENDING_VIEWER_TTL_MS);
    pendingTimer.unref?.();
    if (userId === this.ownerUserId && viewport) this.touch(viewer);
    this.applyResizePolicy();
    this.flushOutput();

    const commitFrom = (plan: Omit<AttachPlan, 'commit'>): AttachPlan => ({
      ...plan,
      commit: () => {
        clearTimeout(pendingTimer);
        this.commitViewer(viewer, plan.nextOffset, plan.cols, plan.rows);
      },
    });

    if (haveOffset !== undefined && haveOffset >= this.lastResizeOffset) {
      const delta = this.tail.since(haveOffset);
      if (delta !== null) {
        return commitFrom({ mode: 'delta', data: new Uint8Array(delta), cols: this.currentCols, rows: this.currentRows, nextOffset: this.tail.end });
      }
    }
    for (let attempt = 0; ; attempt++) {
      const gen = this.resizeGen;
      const snapshot = await this.mirror.snapshot(this.scrollbackLines, this.snapshotMaxBytes);
      const gap = this.tail.since(snapshot.offset);
      if ((gen !== this.resizeGen || gap === null) && attempt < 5) continue;
      if (snapshot.scrollbackLines < this.scrollbackLines) this.log.warn('snapshot scrollback reduced to fit the attach limit', { lines: snapshot.scrollbackLines });
      return commitFrom({ mode: 'snapshot', data: snapshot.data, cols: snapshot.cols, rows: snapshot.rows, nextOffset: snapshot.offset });
    }
  }

  private commitViewer(viewer: Viewer, from: number, cols: number, rows: number): void {
    if (this.disposed || this.viewers.get(viewer.key) !== viewer) return;
    this.flushOutput();
    viewer.ready = true;
    const gap = this.tail.since(from);
    if (gap === null) {
      this.log.warn('attach gap no longer buffered', { from, end: this.tail.end });
      if (cols !== this.currentCols || rows !== this.currentRows) viewer.sink.resize(this.currentCols, this.currentRows);
      return;
    }
    if (cols !== this.currentCols || rows !== this.currentRows) {
      // A resize happened after the synced state: split the gap at the resize so the viewer applies it in place.
      const cut = Math.min(Math.max(this.lastResizeOffset, from), this.tail.end) - from;
      if (cut > 0) viewer.sink.output(from, new Uint8Array(gap.subarray(0, cut)));
      viewer.sink.resize(this.currentCols, this.currentRows);
      if (gap.length > cut) viewer.sink.output(from + cut, new Uint8Array(gap.subarray(cut)));
      return;
    }
    if (gap.length > 0) viewer.sink.output(from, new Uint8Array(gap));
  }

  detach(key: string): boolean {
    const removed = this.viewers.delete(key);
    if (removed) this.applyResizePolicy();
    return removed;
  }

  /** Keystrokes (any member who may drive the session). `key` becomes the size driver when it is an attached owner viewer. */
  input(key: string, data: Uint8Array): boolean {
    if (this.state !== 'running') return false;
    const viewer = this.viewers.get(key);
    if (viewer && viewer.userId === this.ownerUserId && viewer.cols !== null && this.touch(viewer)) this.applyResizePolicy();
    this.pty.write(Buffer.from(data));
    return true;
  }

  /** Whether the program in the PTY asked for bracketed pastes (a terminal wraps pastes only then). */
  get bracketedPaste(): boolean {
    return this.mirror.bracketedPaste;
  }

  /** Bytes from the daemon itself on the owner's behalf (an accepted suggestion). */
  writeRaw(data: string): boolean {
    if (this.state !== 'running') return false;
    this.pty.write(data);
    return true;
  }

  /**
   * Pastes `text` on the owner's behalf, followed by Enter, the way a terminal does: wrapped in the paste brackets
   * when the program asked for bracketed pastes. Returns false when the session has ended.
   *
   * Whether the program asked is parser state of the mirror, and the mirror parses asynchronously. Deciding at once
   * could miss a mode the program had already switched on (its output received, not yet parsed): the paste would go
   * in unbracketed, and a suggestion of several lines would be submitted line by line. So the output received so far
   * is handed to the mirror, and the decision waits until the mirror has parsed it.
   */
  paste(text: string): boolean {
    if (this.state !== 'running') return false;
    this.flushOutput();
    void this.mirror.drained().then(() => {
      const data = this.mirror.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text;
      if (!this.writeRaw(data)) return;
      // Enter as its own keystroke a moment later: some TUIs treat an Enter inside the same read as part of the paste.
      setTimeout(() => this.writeRaw('\r'), PASTE_ENTER_DELAY_MS).unref?.();
    });
    return true;
  }

  /** The owner's viewport of channel `key` changed (window resize / SIGWINCH). Ignored for channels not attached. */
  ownerViewport(key: string, cols: number, rows: number): void {
    const viewer = this.viewers.get(key);
    if (!viewer || viewer.userId !== this.ownerUserId) return;
    viewer.cols = cols;
    viewer.rows = rows;
    this.touch(viewer);
    this.applyResizePolicy();
  }

  /** Returns true when the size driver changed. Monotonic counter, not time: ties inside 1 ms are common. */
  private touch(viewer: Viewer): boolean {
    const previous = this.driver();
    viewer.lastActive = ++this.activity;
    return previous !== viewer;
  }

  private driver(): Viewer | undefined {
    let best: Viewer | undefined;
    for (const viewer of this.viewers.values()) {
      if (viewer.userId !== this.ownerUserId || viewer.cols === null || viewer.rows === null) continue;
      if (!best || viewer.lastActive > best.lastActive) best = viewer;
    }
    return best;
  }

  /** Policy `owner`: no owner viewer attached ⇒ keep the size (viewers never shrink the owner's session). */
  private applyResizePolicy(): void {
    if (this.state !== 'running' || this.disposed) return;
    const driver = this.driver();
    if (!driver || driver.cols === null || driver.rows === null) return;
    const { cols, rows } = clampSize(driver.cols, driver.rows);
    if (cols === this.currentCols && rows === this.currentRows) return;
    this.flushOutput(); // output produced at the old size reaches everyone before the resize
    try {
      this.pty.resize(cols, rows);
    } catch (err) {
      this.log.warn('pty resize failed', { error: err instanceof Error ? err.name : 'unknown' });
      return;
    }
    this.mirror.resize(cols, rows);
    this.currentCols = cols;
    this.currentRows = rows;
    this.lastResizeOffset = this.tail.end;
    this.resizeGen++;
    for (const viewer of this.viewers.values()) {
      // Ready viewers only (V2): a pending one gets the size inside its snapshot or at commit.
      if (viewer.ready) viewer.sink.resize(cols, rows);
    }
    this.onResize?.(cols, rows);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------------------------------------------

  /** SIGHUP to the direct child only (our own). Tree kills are the SessionManager's job (kill-tree.ts). */
  hangup(): void {
    if (this.state !== 'running') return;
    try {
      this.pty.kill('SIGHUP');
    } catch {
      // already gone
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.outTimer !== undefined) clearTimeout(this.outTimer);
    if (this.pauseTimer !== undefined) clearTimeout(this.pauseTimer);
    this.hangup();
    this.viewers.clear();
    this.mirror.dispose();
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }
}
