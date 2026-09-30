// The byte-exact feed of one terminal viewer (pty-packaging.md §6.1/§6.2, ARCHITECTURE §5.5): session.attach gives a
// snapshot (or a raw delta since `haveOffset`), then live exec.output continues at `nextOffset`. Output is addressed by
// absolute byte offset, so every chunk is placed exactly: a chunk that ends at or before what is already rendered is a
// duplicate and dropped, an overlapping one is trimmed, and a chunk that starts beyond it means bytes are missing — the
// feed then attaches again from the last rendered offset (no gap, no duplicate).
//
// Which events belong to which attachment. The daemon marks a viewer live only AFTER its attach reply went out, so on
// one logical channel every exec.output / exec.resize of the NEW attachment follows the reply. Events of an EARLIER
// attachment of the same channel (a detach that raced in-flight output, or a live attachment being replaced for a
// resync) precede the reply — but the client cannot see where the reply sits among the events: the SDK may dispatch
// several envelopes in one go before the attach promise's continuation runs. Offsets settle it for output, not for
// resizes (they carry no offset). So before attaching again on a channel that already had an attachment, the feed
// detaches and waits for a FENCE — any request's reply: it is ordered after every event of the old attachment, which
// are ignored meanwhile. After that, whatever arrives while the attach is pending is post-reply and is applied in
// order. A fresh channel (full resync, `channelReset()`) cannot carry the old attachment's events, so no fence.
import type { PayloadOf, ResultOf } from '@smurg/protocol';

export type AttachResult = ResultOf<'session.attach'>;
export type ExecOutputEvent = PayloadOf<'exec.output'>;
export type ExecResizeEvent = PayloadOf<'exec.resize'>;

/** Where the feed paints (the xterm viewer). All calls are in stream order. */
export interface FeedSink {
  /** Reset, set the PTY size, paint the serialized state. */
  snapshot(data: Uint8Array, cols: number, rows: number): void;
  write(data: Uint8Array): void;
  /** In stream order with the output (the viewer applies it between the right bytes). */
  resize(cols: number, rows: number): void;
}

export interface FeedTransport {
  /** session.attach with the given `haveOffset` (the caller adds the session id and, for the owner, the viewport). */
  attach(haveOffset: number | undefined): Promise<AttachResult>;
  /** session.detach (one-way; dropped while disconnected). */
  detach(): void;
  /** Any cheap request: its reply orders after every event the daemon sent before it (see above). */
  fence(): Promise<unknown>;
}

export interface FeedHooks {
  /** Every attach result (the caller may upsert result.session). */
  onAttached?(result: AttachResult): void;
  /** The feed is live (after every successful attach, including the ones it starts itself to fill a gap). */
  onLive?(): void;
  /** A failed attach (the feed is detached afterwards; call attach() to retry). */
  onError?(error: unknown): void;
}

export type FeedPhase = 'detached' | 'fencing' | 'attaching' | 'live';

/** Output buffered while an attach is pending; beyond this the feed simply attaches again from its offset. */
export const FEED_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

type Buffered = { readonly kind: 'output'; readonly event: ExecOutputEvent } | { readonly kind: 'resize'; readonly event: ExecResizeEvent };

export class TerminalFeed {
  private readonly sink: FeedSink;
  private readonly transport: FeedTransport;
  private readonly hooks: FeedHooks;
  private phaseValue: FeedPhase = 'detached';
  /** Next byte offset to render; everything before it is on screen. Null until the first attach. */
  private offsetValue: number | null = null;
  /** An earlier attachment on the current channel may still have events in flight (fence before attaching). */
  private dirty = false;
  /** Bumped by attach/detach/reset: an older attempt's continuation must not touch the feed. */
  private attempt = 0;
  private buffered: Buffered[] = [];
  private bufferedBytes = 0;
  private overflow = false;
  private resyncs = 0;

  constructor(sink: FeedSink, transport: FeedTransport, hooks: FeedHooks = {}) {
    this.sink = sink;
    this.transport = transport;
    this.hooks = hooks;
  }

  get phase(): FeedPhase {
    return this.phaseValue;
  }

  /** The offset rendered up to (what a reconnect passes as `haveOffset`). */
  get offset(): number | null {
    return this.offsetValue;
  }

  /** How many times the feed had to attach again because bytes were missing (tests, diagnostics). */
  get resyncCount(): number {
    return this.resyncs;
  }

  /**
   * Attaches (again): `haveOffset` = the rendered offset, so the daemon can answer a raw delta. Resolves when the feed
   * is live, or when this attempt was superseded (detach, a newer attach, a channel reset). Rejects when the attach
   * request fails; the feed is then detached.
   */
  async attach(): Promise<void> {
    const token = ++this.attempt;
    const wasAttached = this.phaseValue !== 'detached';
    this.clearBuffer();
    if (this.dirty) {
      this.phaseValue = 'fencing';
      if (wasAttached) this.transport.detach();
      try {
        await this.transport.fence();
      } catch (error) {
        if (token !== this.attempt) return;
        this.phaseValue = 'detached';
        this.hooks.onError?.(error);
        throw error;
      }
      if (token !== this.attempt) return;
      this.dirty = false;
    }
    this.phaseValue = 'attaching';
    // From here on this channel has an attachment (pending or live) whose events may arrive.
    this.dirty = true;
    const haveOffset = this.offsetValue ?? undefined;
    let result: AttachResult;
    try {
      result = await this.transport.attach(haveOffset);
    } catch (error) {
      if (token !== this.attempt) return;
      this.phaseValue = 'detached';
      this.clearBuffer();
      this.hooks.onError?.(error);
      throw error;
    }
    if (token !== this.attempt) return;
    this.hooks.onAttached?.(result);
    if (result.mode === 'delta') {
      // A delta is the raw bytes [haveOffset, nextOffset). Anything else cannot be placed: start over from a snapshot.
      if (haveOffset === undefined || haveOffset + result.data.byteLength !== result.nextOffset) {
        this.offsetValue = null;
        return this.resync();
      }
      this.sink.resize(result.cols, result.rows);
      if (result.data.byteLength > 0) this.sink.write(result.data);
    } else {
      this.sink.snapshot(result.data, result.cols, result.rows);
    }
    this.offsetValue = result.nextOffset;
    this.phaseValue = 'live';
    this.hooks.onLive?.();
    const pending = this.buffered;
    const overflowed = this.overflow;
    this.clearBuffer();
    if (overflowed) return this.resync();
    for (const item of pending) {
      if (this.phaseValue !== 'live' || token !== this.attempt) return;
      if (item.kind === 'output') this.place(item.event);
      else this.sink.resize(item.event.cols, item.event.rows);
    }
  }

  /** Stops receiving (hide): session.detach; the rendered offset is kept for a later delta. */
  detach(): void {
    this.attempt++;
    const wasAttached = this.phaseValue !== 'detached';
    this.phaseValue = 'detached';
    this.clearBuffer();
    if (wasAttached) this.transport.detach();
  }

  /**
   * A new logical channel (a non-resumed Welcome): the daemon forgot the attachment and nothing of the old channel can
   * arrive any more. The rendered offset is kept, so the next attach can still get a delta.
   */
  channelReset(): void {
    this.attempt++;
    this.phaseValue = 'detached';
    this.dirty = false;
    this.clearBuffer();
  }

  /** Forget the rendered state (the viewer was recreated): the next attach gets a snapshot. */
  forgetOffset(): void {
    this.offsetValue = null;
  }

  /** exec.output of this session. */
  output(event: ExecOutputEvent): void {
    switch (this.phaseValue) {
      case 'attaching':
        this.bufferedBytes += event.data.byteLength;
        if (this.bufferedBytes > FEED_BUFFER_MAX_BYTES) {
          // Too much while waiting: drop it and attach again from the offset afterwards.
          this.buffered = [];
          this.overflow = true;
          return;
        }
        if (!this.overflow) this.buffered.push({ kind: 'output', event });
        return;
      case 'live':
        this.place(event);
        return;
      default:
        // detached or fencing: an old attachment's bytes; a later attach re-sends whatever is missing.
        return;
    }
  }

  /** exec.resize of this session. */
  resize(event: ExecResizeEvent): void {
    if (this.phaseValue === 'attaching') {
      if (!this.overflow) this.buffered.push({ kind: 'resize', event });
      return;
    }
    if (this.phaseValue === 'live') this.sink.resize(event.cols, event.rows);
  }

  private place(event: ExecOutputEvent): void {
    const expected = this.offsetValue;
    if (expected === null) return;
    const end = event.offset + event.data.byteLength;
    if (end <= expected) return; // already rendered
    if (event.offset > expected) {
      // Bytes [expected, event.offset) never arrived: attach again from what is on screen.
      void this.resync();
      return;
    }
    this.sink.write(event.offset < expected ? event.data.subarray(expected - event.offset) : event.data);
    this.offsetValue = end;
  }

  private resync(): Promise<void> {
    this.resyncs++;
    return this.attach().catch(() => {
      // reported through hooks.onError
    });
  }

  private clearBuffer(): void {
    this.buffered = [];
    this.bufferedBytes = 0;
    this.overflow = false;
  }
}
