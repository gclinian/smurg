// Sequencing, outbox and de-duplication of the interactive channel (ARCHITECTURE §4 "Resume"). Pure bookkeeping, no
// I/O: the engine decides when to transmit.
//
// The contract with the daemon (it implements the mirror image):
//  1. A logical channel is named by Welcome.channelId and has two independent seq spaces (client→daemon and
//     daemon→client). A new logical channel starts both at 1.
//  2. Every Envelope consumes the next seq of its direction, EXCEPT `channel.ack`, which is unsequenced: it carries
//     seq 0 and is never stored, replayed, acknowledged or de-duplicated.
//  3. Seqs are strictly increasing but may have gaps (a queued message cancelled before it was sent never reaches the
//     peer), so a receiver must never treat a gap as an error. It drops seq ≤ the last seq it processed as a duplicate.
//  4. The receiver acknowledges with `channel.ack { upTo }` = the last seq it processed; the sender then trims its
//     outbox. ClientHello.resume.lastSeq carries the same value across a reconnect.
//  5. After a reconnect with Welcome.resumed = true the sender re-sends every unacknowledged Envelope with its
//     original seq, in order, before anything new; the receiver's rule 3 removes what it already processed.
//  6. Welcome.resumed = false: both seq spaces restart at 1 under the new channelId. Messages that were already sent
//     may or may not have been processed (requests fail with 'connection-lost'); queued requests that were never sent
//     are renumbered and sent; queued one-way messages are dropped because the application resyncs anyway (except
//     before the very first channel, when nothing is being replaced).
import type { ResumeState } from './storage.ts';
import { ClientRequestError } from './errors.ts';

/**
 * Seqs a restored client skips after loading a persisted position: a seq assigned after the last save may already
 * have been processed by the daemon, and a reused one would be dropped as a duplicate (rule 3 allows the gap).
 */
export const RESUME_SEQ_SKIP = 1_000_000;

export interface OutboxEntry {
  readonly id: string;
  readonly type: string;
  /** Expects `X.ok` / `error`. */
  readonly request: boolean;
  seq: number;
  bytes: Uint8Array;
  /** Transmitted on the channel that is (or was last) established. Reset when a resumed channel must re-send it. */
  sent: boolean;
  /** Encodes the same Envelope under another seq (renumbering after a non-resumed re-establishment). */
  readonly encode: (seq: number) => Uint8Array;
}

export interface EstablishResult {
  /** Entries that left the outbox: already sent (fate unknown), or one-way messages dropped by the resync. */
  readonly lost: readonly OutboxEntry[];
}

export class ReliableState {
  /** The logical channel of the current (or last) session; null before the first Welcome. */
  channelId: string | null = null;
  /** Last daemon seq processed (inbound). */
  lastSeq = 0;
  private nextSeqValue = 1;
  private ackedUpTo = 0;
  private readonly entries: OutboxEntry[] = [];
  private queuedBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0)) throw new RangeError('maxOutboxBytes must be a positive integer');
    this.maxBytes = maxBytes;
  }

  get nextSeq(): number {
    return this.nextSeqValue;
  }

  get outbox(): readonly OutboxEntry[] {
    return this.entries;
  }

  get outboxBytes(): number {
    return this.queuedBytes;
  }

  /** Continue a persisted logical channel (see RESUME_SEQ_SKIP). */
  restore(state: ResumeState): void {
    this.channelId = state.channelId;
    this.lastSeq = state.lastSeq;
    this.ackedUpTo = state.lastSeq;
    this.nextSeqValue = state.nextSeq + RESUME_SEQ_SKIP;
  }

  snapshot(): ResumeState | null {
    return this.channelId === null ? null : { channelId: this.channelId, lastSeq: this.lastSeq, nextSeq: this.nextSeqValue };
  }

  /** ClientHello.resume for the next handshake, or null on first contact. */
  resumeRequest(): { channelId: string; lastSeq: number } | null {
    return this.channelId === null ? null : { channelId: this.channelId, lastSeq: this.lastSeq };
  }

  /**
   * Assigns the next seq and queues the Envelope. `encode` may throw (invalid payload): then nothing is consumed.
   * Throws ClientRequestError('overflow') when the outbox would exceed its byte budget.
   */
  enqueue(input: { id: string; type: string; request: boolean; encode: (seq: number) => Uint8Array }): OutboxEntry {
    const seq = this.nextSeqValue;
    const bytes = input.encode(seq);
    if (this.queuedBytes + bytes.byteLength > this.maxBytes) throw new ClientRequestError('overflow');
    this.nextSeqValue = seq + 1;
    const entry: OutboxEntry = { id: input.id, type: input.type, request: input.request, seq, bytes, sent: false, encode: input.encode };
    this.entries.push(entry);
    this.queuedBytes += bytes.byteLength;
    return entry;
  }

  /** Removes an entry that was not transmitted on the current channel (a timed-out or cancelled request). */
  removeUnsent(entry: OutboxEntry): boolean {
    if (entry.sent) return false;
    return this.remove(entry);
  }

  /**
   * Removes an entry whether it was transmitted or not: a request whose caller was already told it failed (timeout,
   * cancelled) must never be re-sent, not even on a resumed channel (review REL-03: a retry would otherwise happen
   * twice). The daemon either has it already or never gets it; the seq gap is allowed (rule 3).
   */
  remove(entry: OutboxEntry): boolean {
    const index = this.entries.indexOf(entry);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.queuedBytes -= entry.bytes.byteLength;
    return true;
  }

  /** `channel.ack { upTo }` from the daemon: everything sent up to there was processed. Returns how many left. */
  trim(upTo: number): number {
    let removed = 0;
    for (let i = 0; i < this.entries.length; ) {
      const entry = this.entries[i] as OutboxEntry;
      if (entry.sent && entry.seq <= upTo) {
        this.entries.splice(i, 1);
        this.queuedBytes -= entry.bytes.byteLength;
        removed++;
      } else {
        i++;
      }
    }
    return removed;
  }

  /** Rule 3: true for a new daemon seq (and records it), false for a duplicate. Seq 0 is never passed here. */
  acceptInbound(seq: number): boolean {
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    return true;
  }

  /** The `upTo` to acknowledge, or null when the daemon already knows. */
  pendingAck(): number | null {
    return this.lastSeq > this.ackedUpTo ? this.lastSeq : null;
  }

  markAcked(upTo: number): void {
    if (upTo > this.ackedUpTo) this.ackedUpTo = upTo;
  }

  /** Entries to transmit now, in seq order. */
  unsent(): OutboxEntry[] {
    return this.entries.filter((entry) => !entry.sent);
  }

  /** A new session delivered its Welcome. Applies rules 5 and 6. */
  establish(channelId: string, resumed: boolean): EstablishResult {
    if (resumed && channelId === this.channelId) {
      for (const entry of this.entries) entry.sent = false;
      // ClientHello.resume.lastSeq already told the daemon everything we processed.
      this.ackedUpTo = this.lastSeq;
      return { lost: [] };
    }
    // The very first channel replaces nothing: whatever was queued before it goes out as is.
    const first = this.channelId === null;
    const lost: OutboxEntry[] = [];
    const keep: OutboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.sent || (!entry.request && !first)) lost.push(entry);
      else keep.push(entry);
    }
    this.channelId = channelId;
    this.lastSeq = 0;
    this.ackedUpTo = 0;
    this.nextSeqValue = 1;
    this.entries.length = 0;
    this.queuedBytes = 0;
    for (const entry of keep) {
      entry.seq = this.nextSeqValue++;
      entry.bytes = entry.encode(entry.seq);
      entry.sent = false;
      this.entries.push(entry);
      this.queuedBytes += entry.bytes.byteLength;
    }
    return { lost };
  }

  /** Drops everything (terminal close). */
  clear(): OutboxEntry[] {
    const all = this.entries.splice(0, this.entries.length);
    this.queuedBytes = 0;
    return all;
  }
}
