// The outside sources of the sticky notes (DESIGN 0.8.0 D6): the Slack channel and the Discord channel the host
// connected (`smurg connect`), read from the host's computer over HTTPS, at most once a minute each, never through the
// relay. Each message of a person becomes waiting feedback through the feedback service (feedback.ts createOutside),
// on the sticky note it names; no model reads it before a member with agent access accepts it.
//
//   what smurg host hands over   asked for every SOURCE_LOOK_MS (`ctx.outside.connectors()`); a source whose channel id
//                                or token fails its source's form is `failing` with its own text and NEVER fetched
//                                (D6.2: a file edited by hand or by an agent puts no other path into a URL that
//                                carries the token); nothing is fetched while no channel is connected
//   the first read of a channel  only keeps the newest message's position as the cursor: nothing from before the
//                                connection becomes feedback (another channel, or no cursor, starts from now too)
//   every later read             the messages after the cursor, oldest first; a person's message (not a bot's, not
//                                empty, not written before `connectedAt`) becomes feedback on the first `[[Name]]` that
//                                names a note of the index, else on Home; with no Home it is dropped and counted
//   the budgets (D4.5)           while 200 wait from outside, or the next message's writer has 20 waiting, the source
//                                stops reading there (`waiting-for-room`) and reads on once there is room
//   a wait asked for (429)       no request before it has passed (and never before the minute)
//
// The cursor is kept in sticky.json (`cursors`, per source, with its channel); it moves to the last message looked at,
// in the same write as the feedback made from the messages before it. A token is never on the wire, in sticky.json,
// in the audit log or in a log line: the log says the source and what went wrong (a status, a service's code).
import { NOTES_HOME, OUTSIDE_SOURCES, isOutsideBotToken, isOutsideChannelId, wikiLinks, type OutsideSource, type SourceState } from '@smurg/protocol';
import type { DaemonContext } from '../../core/context.ts';
import type { ConnectorEntry, PersistentDocument } from '../../core/interfaces.ts';
import { monotonicNow } from '../../core/lifecycle.ts';
import { outsideName, outsideText, type FeedbackService } from '../feedback.ts';
import type { NoteIndex } from '../index.ts';
import type { StickyDocument } from '../store.ts';
import { DISCORD_API_BASE, DiscordReader } from './discord.ts';
import { SourceFailed, SourceLimited, abortedBy, problemText, type SourceMessage, type SourceProblem, type SourceReader } from './request.ts';
import { SLACK_API_BASE, SlackReader } from './slack.ts';

/** One read per source per minute, never more often (D6.1). */
export const SOURCE_READ_INTERVAL_MS = 60_000;
/** How often the entry smurg host hands over is looked at (no request: a function call). */
export const SOURCE_LOOK_MS = 1_000;
/** The longest wait a service may ask for that is kept to. */
export const SOURCE_WAIT_MAX_MS = 3_600_000;
/**
 * The first read of an EMPTY channel keeps a position this long before the host's now: the service stamps messages
 * with its own clock, and one a little behind the host's would put a message written right after the connection
 * before the cursor. Nothing was in the channel then, so nothing from before the connection is taken by it.
 */
export const EMPTY_CHANNEL_MARGIN_MS = 60_000;

export interface OutsideSourcesOptions {
  readonly feedback: FeedbackService;
  readonly index: NoteIndex;
  readonly document: () => PersistentDocument<StickyDocument>;
  /** A source appeared, went, or its state changed: the service tells every member (`sticky.changed`). */
  readonly changed: () => void;
  /** TEST ONLY: the minute between two reads of a source (default SOURCE_READ_INTERVAL_MS). */
  readonly readIntervalMs?: number;
  /** TEST ONLY: how often the entry is looked at (default SOURCE_LOOK_MS). */
  readonly lookMs?: number;
}

/** What `take` made of one message: go on to the next, or stop because a budget is full. */
type Taken = { readonly full?: undefined } | { readonly full: 'outside' | 'person' | 'stored' };

interface Slot {
  readonly source: OutsideSource;
  /** What the entry was (compared with the next one; kept in memory only, never logged). */
  readonly key: string;
  readonly entry: ConnectorEntry;
  /** Null: the entry fails its form, and nothing is ever fetched for it. */
  readonly reader: SourceReader | null;
  state: SourceState;
  /** Monotonic ms before which no request is made. */
  nextAt: number;
  /** The writer whose budget stopped the last read (no read until they have room). */
  blockedBy: string | null;
  running: Promise<void> | null;
  /** Aborted when the entry changes or goes, and when the daemon stops. */
  readonly abort: AbortController;
}

/** The entry as smurg host handed it, when it has the shape of one (its values' form is checked by the slot). */
function entryOf(value: unknown): ConnectorEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry['token'] !== 'string' || typeof entry['channel'] !== 'string' || typeof entry['connectedAt'] !== 'number' || !Number.isFinite(entry['connectedAt'])) return null;
  return { token: entry['token'], channel: entry['channel'], connectedAt: entry['connectedAt'] };
}

export class OutsideSources {
  private readonly ctx: DaemonContext;
  private readonly options: OutsideSourcesOptions;
  private readonly interval: number;
  private readonly slots = new Map<OutsideSource, Slot>();
  /** When each source last made a request (monotonic ms): a new entry for it waits for the minute too. */
  private readonly lastRequest = new Map<OutsideSource, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private dropped = 0;

  constructor(ctx: DaemonContext, options: OutsideSourcesOptions) {
    this.ctx = ctx;
    this.options = options;
    this.interval = options.readIntervalMs ?? SOURCE_READ_INTERVAL_MS;
  }

  /** The module's start (after the index was listed): looks at the entry now, then every SOURCE_LOOK_MS. */
  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setInterval(() => this.look(), this.options.lookMs ?? SOURCE_LOOK_MS);
    this.timer.unref?.();
    this.look();
  }

  /** Nothing more is fetched; a read on its way is given up. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    const running = [...this.slots.values()].map((slot) => {
      slot.abort.abort();
      return slot.running;
    });
    await Promise.allSettled(running);
  }

  /** The connected sources as members see them (`sticky.list`, `sticky.changed`), Slack first. */
  states(): SourceState[] {
    return OUTSIDE_SOURCES.flatMap((source) => {
      const slot = this.slots.get(source);
      return slot === undefined ? [] : [slot.state];
    });
  }

  /** How many messages of a person were dropped because there was no sticky note Home (D6.3). */
  droppedWithoutHome(): number {
    return this.dropped;
  }

  /** The entry smurg host holds now: sources that came, went or changed are set up again; due ones are read. */
  private look(): void {
    if (this.stopped) return;
    let handed: unknown = null;
    try {
      handed = this.ctx.outside.connectors();
    } catch {
      handed = null;
    }
    let changed = false;
    for (const source of OUTSIDE_SOURCES) {
      const entry = handed === null || typeof handed !== 'object' ? null : entryOf((handed as Record<string, unknown>)[source]);
      const slot = this.slots.get(source);
      if (entry === null) {
        if (slot !== undefined) {
          slot.abort.abort();
          this.slots.delete(source);
          changed = true;
        }
        continue;
      }
      const key = `${entry.channel}\n${entry.connectedAt}\n${entry.token}`;
      if (slot?.key === key) continue;
      slot?.abort.abort();
      this.slots.set(source, this.slotOf(source, entry, key));
      changed = true;
    }
    if (changed) this.options.changed();
    for (const slot of this.slots.values()) this.due(slot);
  }

  private slotOf(source: OutsideSource, entry: ConnectorEntry, key: string): Slot {
    const problem: SourceProblem | null = !isOutsideChannelId(source, entry.channel) ? 'channel-invalid' : !isOutsideBotToken(source, entry.token) ? 'token-invalid' : null;
    if (problem !== null) this.ctx.log.warn('outside source not read', { module: 'sticky', source, problem });
    const base = this.ctx.outside.baseUrls[source];
    const reader =
      problem !== null
        ? null
        : source === 'slack'
          ? new SlackReader({ base: base ?? SLACK_API_BASE, token: entry.token, channel: entry.channel, now: () => this.ctx.clock.now() })
          : new DiscordReader({ base: base ?? DISCORD_API_BASE, token: entry.token, channel: entry.channel });
    const last = this.lastRequest.get(source);
    return {
      source,
      key,
      entry,
      reader,
      state: problem === null ? { source, state: 'reading' } : { source, state: 'failing', problem: problemText(problem) },
      nextAt: last === undefined ? 0 : last + this.interval,
      blockedBy: null,
      running: null,
      abort: new AbortController(),
    };
  }

  /** Reads `slot` when its minute has come and there is room for what it may bring. */
  private due(slot: Slot): void {
    if (this.stopped || slot.reader === null || slot.running !== null || monotonicNow(this.ctx.clock) < slot.nextAt) return;
    const blockedBy = slot.blockedBy;
    const room = this.options.feedback.outsideRoom(blockedBy === null ? undefined : { source: slot.source, externalId: blockedBy });
    if (room !== 'room') {
      this.setState(slot, { source: slot.source, state: 'waiting-for-room' });
      return;
    }
    slot.running = this.read(slot, slot.reader).finally(() => {
      slot.running = null;
    });
  }

  private async read(slot: Slot, reader: SourceReader): Promise<void> {
    const { source } = slot;
    const started = monotonicNow(this.ctx.clock);
    this.lastRequest.set(source, started);
    slot.nextAt = started + this.interval;
    slot.blockedBy = null;
    const signal = slot.abort.signal;
    try {
      const cursor = this.options.document().get().cursors[source];
      if (cursor === undefined || cursor.channel !== slot.entry.channel) {
        // The first read of this channel: only where it is now.
        const newest = await reader.newest(signal, this.ctx.clock.now() - EMPTY_CHANNEL_MARGIN_MS);
        if (signal.aborted) return;
        this.keepCursor(source, slot.entry.channel, newest);
        await this.options.feedback.flush();
        this.setState(slot, { source, state: 'reading' });
        return;
      }
      const { messages, skipped } = await reader.after(cursor.after, signal);
      if (signal.aborted) return;
      if (skipped) this.ctx.log.warn('outside messages older than one read takes were not read', { module: 'sticky', source });
      let kept = cursor.after;
      let full: 'outside' | 'person' | 'stored' | null = null;
      let failure: unknown = null;
      for (const message of messages) {
        if (reader.compare(message.position, kept) <= 0) continue;
        let taken: Taken;
        try {
          taken = await this.take(slot, reader, message, signal);
        } catch (err) {
          failure = err;
          break;
        }
        if (signal.aborted) return;
        if (taken.full !== undefined) {
          full = taken.full;
          slot.blockedBy = taken.full === 'person' ? message.author : null;
          break;
        }
        kept = message.position;
      }
      // What was looked at before a stop is not looked at again: the cursor goes with the feedback made from it.
      if (kept !== cursor.after) this.keepCursor(source, slot.entry.channel, kept);
      await this.options.feedback.flush();
      if (failure !== null) throw failure;
      this.setState(slot, { source, state: full === null ? 'reading' : 'waiting-for-room' });
    } catch (err) {
      if (signal.aborted || abortedBy(signal, err)) return;
      if (err instanceof SourceLimited) {
        const wait = Math.min(SOURCE_WAIT_MAX_MS, Math.max(this.interval, err.retryAfterMs));
        slot.nextAt = monotonicNow(this.ctx.clock) + wait;
        this.ctx.log.info('outside source asked to wait', { module: 'sticky', source, waitMs: wait });
        return;
      }
      if (err instanceof SourceFailed) {
        if (err.tooLarge) reader.fewer();
        this.ctx.log.warn('outside source not read', { module: 'sticky', source, problem: err.problem, why: err.why });
        this.setState(slot, { source, state: 'failing', problem: problemText(err.problem) });
        return;
      }
      this.ctx.log.error('outside source read failed', { module: 'sticky', source, error: err instanceof Error ? err.name : 'unknown' });
      this.setState(slot, { source, state: 'failing', problem: problemText('bad-answer') });
    }
  }

  /** One message looked at: a person's becomes feedback; any other is skipped. Throws what its name lookup throws. */
  private async take(slot: Slot, reader: SourceReader, message: SourceMessage, signal: AbortSignal): Promise<Taken> {
    const { source } = slot;
    const author = message.author;
    if (author === null || message.at < slot.entry.connectedAt) return {};
    const text = outsideText(message.text, source);
    if (text === null) return {};
    const note = this.noteOf(text.text);
    if (note === null) {
      this.dropped += 1;
      this.ctx.log.warn('an outside message was dropped: there is no sticky note Home', { module: 'sticky', source, dropped: this.dropped });
      return {};
    }
    // Before a name is asked for: a budget that is full stops the read here.
    const room = this.options.feedback.outsideRoom({ source, externalId: author });
    if (room !== 'room') return { full: room };
    const name = outsideName(message.name ?? (await reader.nameOf(author, signal)), source);
    if (signal.aborted) return {};
    const made = this.options.feedback.createOutside({ source, externalId: author, name, text, note });
    if ('full' in made) return { full: made.full };
    if ('invalid' in made) this.ctx.log.warn('an outside message was not kept: it makes no feedback entry', { module: 'sticky', source });
    return {};
  }

  /** The note a message is on: the first `[[Name]]` that names a note of the index, else Home; null without Home. */
  private noteOf(text: string): string | null {
    for (const name of wikiLinks(text)) {
      const note = this.options.index.find(name);
      if (note !== null) return note.name;
    }
    return this.options.index.find(NOTES_HOME)?.name ?? null;
  }

  private keepCursor(source: OutsideSource, channel: string, after: string): void {
    this.options.document().update((draft) => {
      if (source === 'slack') draft.cursors.slack = { channel, after };
      else draft.cursors.discord = { channel, after };
    });
  }

  private setState(slot: Slot, state: SourceState): void {
    if (this.slots.get(slot.source) !== slot) return;
    const before = slot.state;
    if (before.state === state.state && JSON.stringify(before.problem) === JSON.stringify(state.problem)) return;
    slot.state = state;
    this.options.changed();
  }
}
