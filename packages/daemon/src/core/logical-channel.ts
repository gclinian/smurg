// The daemon half of the resume contract (ARCHITECTURE §4 "Resume"; the client half is
// @smurg/protocol/client outbox.ts, and its FakeDaemon is the executable reference):
//  1. A logical channel (Welcome.channelId) has two seq spaces, both starting at 1.
//  2. Every d→c Envelope takes the next seq, EXCEPT channel.ack (seq 0, never stored, replayed or acknowledged).
//  3. c→d: a seq ≤ the last one processed is a duplicate and dropped; gaps are normal and never an error.
//  4. The client's channel.ack{upTo} trims the outbox; ClientHello.resume.lastSeq does the same across a reconnect.
//  5. Resume with lastSeq in [droppedUpTo, d2cSeq] ⇒ resumed = true and every entry with seq > lastSeq is re-sent in
//     order before anything new. Anything else ⇒ a new logical channel, resumed = false (the client resyncs).
// The outbox is bounded: overflow drops the oldest entries and raises droppedUpTo, so a resume from below it fails
// (resumed = false) instead of silently skipping messages.

export interface OutboxEntry {
  readonly seq: number;
  readonly bytes: Uint8Array;
}

export interface LogicalChannelLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export class LogicalChannel {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly createdAt: number;
  /** Last d→c seq assigned. */
  d2cSeq = 0;
  /** Last c→d seq processed. */
  c2dLast = 0;
  /** Outbox entries up to this seq were discarded without an ack. */
  droppedUpTo = 0;
  /** When the last connection went away (null while connected). */
  disconnectedAt: number | null = null;
  private readonly entries: OutboxEntry[] = [];
  private bytes = 0;
  private readonly limits: LogicalChannelLimits;

  constructor(id: string, userId: string, deviceId: string, createdAt: number, limits: LogicalChannelLimits) {
    this.id = id;
    this.userId = userId;
    this.deviceId = deviceId;
    this.createdAt = createdAt;
    this.limits = limits;
  }

  get outboxLength(): number {
    return this.entries.length;
  }

  get outboxBytes(): number {
    return this.bytes;
  }

  /** Reserves the next d→c seq (encode the Envelope with it, then push()). */
  nextSeq(): number {
    this.d2cSeq += 1;
    return this.d2cSeq;
  }

  /** Keeps an encoded Envelope until the client acknowledges it. */
  push(seq: number, bytes: Uint8Array): void {
    this.entries.push({ seq, bytes });
    this.bytes += bytes.byteLength;
    while (this.entries.length > this.limits.maxEntries || (this.bytes > this.limits.maxBytes && this.entries.length > 1)) {
      const dropped = this.entries.shift() as OutboxEntry;
      this.bytes -= dropped.bytes.byteLength;
      this.droppedUpTo = Math.max(this.droppedUpTo, dropped.seq);
    }
  }

  /** channel.ack{upTo}: the client processed everything up to `upTo`. Values beyond what was sent are clamped. */
  trim(upTo: number): void {
    const limit = Math.min(upTo, this.d2cSeq);
    while (this.entries.length > 0 && (this.entries[0] as OutboxEntry).seq <= limit) {
      const entry = this.entries.shift() as OutboxEntry;
      this.bytes -= entry.bytes.byteLength;
    }
  }

  /** Rule 3: true when `seq` is new (and records it), false for a duplicate. seq 0 is unsequenced and always new. */
  acceptInbound(seq: number): boolean {
    if (seq === 0) return true;
    if (seq <= this.c2dLast) return false;
    this.c2dLast = seq;
    return true;
  }

  /** Rule 5: whether a client that processed up to `lastSeq` can continue this channel. */
  canResumeFrom(lastSeq: number): boolean {
    return Number.isSafeInteger(lastSeq) && lastSeq >= this.droppedUpTo && lastSeq <= this.d2cSeq;
  }

  /** Entries the client has not processed yet, in order. */
  pendingAfter(lastSeq: number): readonly OutboxEntry[] {
    return this.entries.filter((entry) => entry.seq > lastSeq);
  }
}
