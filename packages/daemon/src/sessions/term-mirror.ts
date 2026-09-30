// The daemon-side terminal mirror of one PTY (ARCHITECTURE §7.6, pty-packaging.md §6.2): an @xterm/headless Terminal
// fed with every output byte. It is
//  - the source of re-attach snapshots (full scrollback, serialized exactly at a known byte offset),
//  - the ONLY responder to terminal queries (DA1/DA2/CPR/DSR/DECRQM): its replies go back into the PTY once, however
//    many viewers are attached (viewers swallow queries, `smurg attach` strips them),
//  - the tracker of the state SerializeAddon 0.14 does not restore (cursor visibility, mouse encoding, DECSTBM, cursor
//    style), which it re-emits after the serialized buffer.
// Ported from the verified spike (pty-packaging-verify/src/term-mirror.ts) with the verifier's origin-mode fix (V7):
// with DECOM on, the re-emitted CUP is relative to the top margin.
import serializeAddon from '@xterm/addon-serialize';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;
type HeadlessTerminal = InstanceType<typeof Terminal>;
type Serializer = InstanceType<typeof SerializeAddon>;

export interface MirrorSnapshot {
  /** Serialized state: write it into a RESET terminal of cols × rows. UTF-8. */
  readonly data: Uint8Array;
  /** Absolute output offset the snapshot corresponds to exactly. */
  readonly offset: number;
  readonly cols: number;
  readonly rows: number;
  /** Scrollback lines included (fewer than asked when the full history would not fit `maxBytes`). */
  readonly scrollbackLines: number;
}

type Params = (number | number[])[];

/** Scrollback lines of the probe that estimates how many lines fit a snapshot's byte limit. */
const PROBE_LINES = 200;
/** Serializations after the probes before a snapshot falls back to the screen alone (bounded work per attach). */
const FIT_ATTEMPTS = 3;

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function flat(params: Params): number[] {
  return params.map((value) => (Array.isArray(value) ? (value[0] ?? 0) : value));
}

export class TermMirror {
  readonly term: HeadlessTerminal;
  private readonly serializer: Serializer;
  /** Absolute byte offset of everything handed to write(). */
  private enqueued = 0;
  /** Bytes handed to xterm that its parser has not processed yet (flow control). */
  pendingBytes = 0;
  private cursorHidden = false;
  private originMode = false;
  private readonly mouseEncoding = new Set<number>();
  private scrollRegion: [number, number] | null = null;
  private cursorStyle: number | null = null;
  private replies: ((data: string) => void) | null;
  private disposed = false;
  /** Settles snapshot / drain promises still waiting for the parser when the mirror is disposed. */
  private readonly waiting = new Set<() => void>();
  /**
   * The last snapshot and what it was taken of: nothing but output (a new offset) and resizes change the mirror, so
   * repeated or concurrent attaches of an idle terminal reuse it instead of serializing again (review REL-12).
   */
  private cached: { readonly offset: number; readonly cols: number; readonly rows: number; readonly asked: number; readonly maxBytes: number; readonly snapshot: MirrorSnapshot } | null = null;

  constructor(cols: number, rows: number, scrollback: number, reply: (data: string) => void) {
    this.replies = reply;
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as never);
    // Replies to DA1/DA2/CPR/DSR/DECRQM go back into the PTY: the mirror answers exactly once.
    this.term.onData((data) => this.replies?.(data));
    const parser = this.term.parser;
    const decset = (on: boolean) => (params: Params): boolean => {
      for (const mode of flat(params)) {
        if (mode === 25) this.cursorHidden = !on;
        if (mode === 6) this.originMode = on;
        if (mode === 1005 || mode === 1006 || mode === 1015 || mode === 1016) {
          if (on) this.mouseEncoding.add(mode);
          else this.mouseEncoding.delete(mode);
        }
      }
      return false; // xterm's own handler runs too
    };
    parser.registerCsiHandler({ prefix: '?', final: 'h' }, decset(true));
    parser.registerCsiHandler({ prefix: '?', final: 'l' }, decset(false));
    parser.registerCsiHandler({ final: 'r' }, (params) => {
      const [top, bottom] = flat(params);
      this.scrollRegion = top || bottom ? [top || 1, bottom || this.term.rows] : null;
      return false;
    });
    parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      this.cursorStyle = flat(params)[0] ?? 0;
      return false;
    });
  }

  /** Absolute offset after everything written so far. */
  get offset(): number {
    return this.enqueued;
  }

  get cols(): number {
    return this.term.cols;
  }

  /** The application enabled bracketed paste (DECSET 2004) as of the output parsed so far. */
  get bracketedPaste(): boolean {
    return !this.disposed && this.term.modes.bracketedPasteMode;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Feeds PTY output. Returns the new end offset. */
  write(chunk: Uint8Array): number {
    if (this.disposed) return this.enqueued;
    this.enqueued += chunk.length;
    this.pendingBytes += chunk.length;
    this.term.write(chunk, () => {
      this.pendingBytes -= chunk.length;
    });
    return this.enqueued;
  }

  /**
   * Resize IN STREAM ORDER (pty-packaging.md F18): xterm's write() is queued but resize() is immediate, so a bare
   * resize would apply the new size before still-queued output is parsed and the mirror would diverge from every
   * viewer. Queue it behind the pending writes.
   */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.write('', () => {
      this.term.resize(cols, rows);
      this.scrollRegion = null; // xterm resets the margins on resize
    });
  }

  /** Resolves once the parser has processed everything written so far. */
  drained(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        this.waiting.delete(done);
        resolve();
      };
      this.waiting.add(done);
      this.term.write('', done);
    });
  }

  /**
   * Serializes the state exactly at the current offset: xterm runs write callbacks synchronously right after that
   * chunk is parsed, so inside the callback the parser state corresponds to `offset`. When the full history would not
   * fit `maxBytes`, fewer scrollback lines are serialized rather than failing the attach. Serializing runs on the
   * daemon's event loop, so the work is bounded (review REL-12): the line count that fits is estimated from two small
   * probes instead of serializing the whole history and halving it again and again, and a snapshot of an unchanged
   * mirror is reused.
   */
  snapshot(scrollbackLines: number, maxBytes: number): Promise<MirrorSnapshot> {
    const offset = this.enqueued;
    if (this.disposed) return Promise.reject(new Error('mirror disposed'));
    return new Promise((resolve, reject) => {
      const abandon = (): void => reject(new Error('mirror disposed'));
      this.waiting.add(abandon);
      this.term.write('', () => {
        this.waiting.delete(abandon);
        const cols = this.term.cols;
        const rows = this.term.rows;
        const cached = this.cached;
        if (cached && cached.offset === offset && cached.cols === cols && cached.rows === rows && cached.asked === scrollbackLines && cached.maxBytes === maxBytes) {
          resolve(cached.snapshot);
          return;
        }
        const fitted = this.fit(scrollbackLines, maxBytes);
        const snapshot: MirrorSnapshot = { data: new TextEncoder().encode(fitted.text), offset, cols, rows, scrollbackLines: fitted.lines };
        this.cached = { offset, cols, rows, asked: scrollbackLines, maxBytes, snapshot };
        resolve(snapshot);
      });
    });
  }

  /** The serialized state with as much of `scrollbackLines` as fits `maxBytes`, in a bounded number of passes. */
  private fit(scrollbackLines: number, maxBytes: number): { readonly text: string; readonly lines: number } {
    let lines = scrollbackLines;
    const history = Math.max(0, this.term.buffer.active.length - this.term.rows);
    if (Math.min(history, scrollbackLines) > PROBE_LINES) {
      // The screen alone, then the screen and the newest PROBE_LINES lines: the cost per line of scrollback.
      const screen = utf8Length(this.serializeNow(0));
      const perLine = Math.max(1, (utf8Length(this.serializeNow(PROBE_LINES)) - screen) / PROBE_LINES);
      const wanted = Math.min(history, scrollbackLines);
      if (screen + perLine * wanted > maxBytes) lines = Math.max(0, Math.min(wanted, Math.floor(((maxBytes - screen) / perLine) * 0.9)));
    }
    let text = this.serializeNow(lines);
    for (let attempt = 1; lines > 0; attempt++) {
      const size = utf8Length(text);
      if (size <= maxBytes) break;
      // Older lines were denser than the probe: scale down by the overshoot; the last attempt keeps the screen only.
      lines = attempt >= FIT_ATTEMPTS ? 0 : Math.min(lines - 1, Math.floor(lines * (maxBytes / size) * 0.9));
      text = this.serializeNow(Math.max(0, lines));
    }
    return { text, lines: Math.max(0, lines) };
  }

  private serializeNow(scrollbackLines: number): string {
    let out = this.serializer.serialize({ scrollback: scrollbackLines });
    const buffer = this.term.buffer.active;
    if (this.scrollRegion) {
      const [top, bottom] = this.scrollRegion;
      // DECSTBM homes the cursor, so re-position afterwards; with origin mode on, CUP rows count from the top margin.
      const row = this.originMode ? buffer.cursorY + 1 - (top - 1) : buffer.cursorY + 1;
      out += `\x1b[${top};${bottom}r\x1b[${Math.max(1, row)};${buffer.cursorX + 1}H`;
    }
    for (const mode of this.mouseEncoding) out += `\x1b[?${mode}h`;
    if (this.cursorStyle !== null) out += `\x1b[${this.cursorStyle} q`;
    if (this.cursorHidden) out += '\x1b[?25l';
    return out;
  }

  /** Stops answering queries into the PTY (the session exited). */
  muteReplies(): void {
    this.replies = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cached = null;
    this.replies = null;
    for (const settle of [...this.waiting]) settle();
    this.waiting.clear();
    this.term.dispose();
  }
}
