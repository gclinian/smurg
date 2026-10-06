// InboxService (ARCHITECTURE §5.11; DESIGN §3.8). A member's inbox is a VIEW: what waits for them, computed from what
// the other services hold right now, plus two kinds of stored notes (mentions, and what became of their own
// suggestions) and the marks of what they have looked at.
//
//   the other services ──(bus events)──▶ touch() ──▶ recompute() ──▶ per member: diff against what their clients
//   hold ──▶ `inbox.changed { upsert, remove }` to that member's own interactive channels (hub.sendToUser: never the
//   control socket)
//
// Nothing is ever "cleared" here: an item leaves because its thing left the world (answered, decided, reviewed,
// merged, the fact ended, another person became responsible), for every inbox that held it, at the same moment.
//
// Recomputing is cheap (every source is an in-memory getter) and coalesced: several events of one synchronous run of
// the daemon cause one recompute. `itemsOf` / `list` / `seen` / `dismiss` recompute first when something is pending, so
// they never answer from a stale view. A sweep on a real timer (`config.agents.escalationSweepMs`) recomputes as well:
// the owners of questions, permission requests and reports set `escalatedAt` and say so on the bus, and the sweep makes
// sure a missed event cannot leave an item in the wrong inbox for longer than that.
//
// Time: every stamp is `ctx.clock.now()`; nothing here waits on a timer per item.
import {
  INBOX_ITEMS_MAX,
  INBOX_NOTES_PER_MEMBER_MAX,
  LIST_MAX_ITEMS,
  LIST_REPLY_MAX_BYTES,
  SmurgError,
  encodedSize,
  inboxItemSchema,
  takeListPage,
  takeWithinBytes,
  type Actor,
  type ColumnTarget,
  type InboxItem,
  type PlanInfo,
  type SessionInfo,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { AttentionFact, AttentionSource, InboxService, PersistentDocument, Principal, Req, Res, UserId } from '../core/interfaces.ts';
import { DisposableStack, newId, type Disposable } from '../core/lifecycle.ts';
import { SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { attentionKey, deriveInbox, excerptOf, noteItem, type InboxWorld, type SessionView } from './derive.ts';
import { INBOX_DOCUMENT, emptyBox, inboxDocumentSchema, initialInboxDocument, noteKey, storedNoteSchema, type InboxDocument, type MemberBox, type StoredNote } from './store.ts';

const ATTENTION_SOURCES: readonly AttentionSource[] = ['topics', 'sessions', 'trust', 'host-rules'];
/** How long after a member went the inbox looks again (the per-member teardown is a matter of milliseconds). */
const TEARDOWN_RECHECK_MS = 300;

/** What a member's clients hold of one item. `stamp`: null for a stored note (it is unread while it exists). */
interface Entry {
  readonly item: InboxItem;
  /** The item as it was built, for the comparison with the next computation. */
  readonly json: string;
  readonly stamp: string | null;
}

function byKey(a: InboxItem, b: InboxItem): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * The `inbox.changed` payloads of one change: the removed keys with the first one, the upserts spread so that every
 * message keeps the size rule of a list (LIST_REPLY_MAX_BYTES, LIST_MAX_ITEMS; an item alone always goes).
 */
export function changePages(
  upsert: readonly InboxItem[],
  remove: readonly string[],
  limits: { readonly maxBytes?: number; readonly maxItems?: number } = {},
): { upsert: InboxItem[]; remove: string[] }[] {
  const maxBytes = limits.maxBytes ?? LIST_REPLY_MAX_BYTES;
  const maxItems = limits.maxItems ?? LIST_MAX_ITEMS;
  const pages: { upsert: InboxItem[]; remove: string[] }[] = [];
  let rest: readonly InboxItem[] = upsert;
  let removes: readonly string[] = remove;
  do {
    const page = takeWithinBytes(rest, maxBytes - encodedSize(removes), { atLeastOne: removes.length === 0, maxItems });
    pages.push({ upsert: page.taken, remove: [...removes] });
    rest = page.rest;
    removes = [];
  } while (rest.length > 0);
  return pages;
}

export class InboxServiceImpl implements InboxService {
  private readonly ctx: DaemonContext;
  private readonly doc: PersistentDocument<InboxDocument>;
  /** Per active member: the items of their inbox as their clients know them. */
  private readonly lists = new Map<UserId, Map<string, Entry>>();
  /** The attention facts as each source last gave them. */
  private readonly facts = new Map<AttentionSource, readonly AttentionFact[]>();
  /** Sources to ask again at the next recompute. */
  private readonly stale = new Set<AttentionSource>(ATTENTION_SOURCES);
  /** When each attention fact that is there now was first seen (its item keeps that time while the fact lasts). */
  private since = new Map<string, number>();
  /** What a source answered the last time it answered, for the recompute during which it throws. */
  private readonly lastGood = new Map<string, readonly unknown[]>();
  /** Sources, items and members already reported in the log (once each, until they are fine again). */
  private readonly reported = new Set<string>();
  /** Per agent session, what the inbox reads of it: `session.updated` matters only when this changed. */
  private readonly sessionFacts = new Map<string, string>();
  private dirty = true;
  private scheduled = false;
  private started = false;
  private stopped = false;
  private sweep: ReturnType<typeof setInterval> | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(ctx: DaemonContext, doc: PersistentDocument<InboxDocument>) {
    this.ctx = ctx;
    this.doc = doc;
  }

  /** Opens `inbox.json`. No other service is called here (they may not exist yet). */
  static async open(ctx: DaemonContext): Promise<InboxServiceImpl> {
    return new InboxServiceImpl(ctx, await ctx.state.document(INBOX_DOCUMENT, inboxDocumentSchema, initialInboxDocument));
  }

  // =================================================================================================================
  // Lifecycle
  // =================================================================================================================

  /** The bus events that can change somebody's inbox (ARCHITECTURE §7.3). */
  attach(): Disposable {
    const stack = new DisposableStack();
    const bus = this.ctx.bus;
    const touch = (): void => this.touch();
    stack.add(bus.on('question.changed', touch));
    stack.add(bus.on('permission.changed', touch));
    stack.add(bus.on('suggestion.changed', touch));
    stack.add(bus.on('report.changed', touch));
    stack.add(bus.on('merge.changed', touch));
    // A removed worktree takes its draft requests with it without a `merge.changed` (worktree-manager.ts): a
    // reviewed draft ("ready to merge") leaves the host's inbox on this event.
    stack.add(bus.on('worktree.changed', touch));
    stack.add(bus.on('plan.changed', touch));
    stack.add(bus.on('topic.changed', touch));
    // Who is responsible, what a session and its item are called, a session that ended.
    stack.add(bus.on('session.created', (event) => this.sessionChanged(event.session)));
    stack.add(bus.on('session.updated', (event) => this.sessionChanged(event.session)));
    stack.add(
      bus.on('session.exited', (event) => {
        this.sessionFacts.delete(event.session.id);
        this.touch();
      }),
    );
    // Who is a member, with which role, and who is online (`waitsForOffline`).
    stack.add(bus.on('member.joined', touch));
    stack.add(bus.on('member.left', () => this.memberWent()));
    stack.add(bus.on('member.role-changed', () => this.memberWent()));
    stack.add(bus.on('conn.opened', touch));
    stack.add(bus.on('conn.closed', touch));
    stack.add(this.ctx.members.onChange(touch));
    stack.add(bus.on('attention.changed', (event) => this.refresh(event.source)));
    stack.add(bus.on('account.changed', () => this.refresh('sessions')));
    stack.add(bus.on('trust.changed', () => this.refresh('trust')));
    stack.add(bus.on('topic.removed', (event) => this.topicRemoved(event.topicId, event.sessionIds)));
    stack.add(bus.on('member.kicked', (event) => this.memberKicked(event.userId)));
    // stop() began: what the other modules put away while they stop is not "settled". The view (and with it the
    // marks of what was looked at) stays as it was; channels are closed right after this.
    stack.add(
      bus.on('daemon.stopping', () => {
        this.stopped = true;
      }),
    );
    return stack;
  }

  /** After every module started: the first full view, then the sweep. */
  start(): void {
    this.started = true;
    for (const source of ATTENTION_SOURCES) this.stale.add(source);
    this.dirty = true;
    this.flush();
    this.sweep = setInterval(() => {
      for (const source of ATTENTION_SOURCES) this.stale.add(source);
      this.dirty = true;
      this.flush();
    }, this.ctx.config.agents.escalationSweepMs);
    this.sweep.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweep !== undefined) clearInterval(this.sweep);
    this.sweep = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.doc.flush();
  }

  // =================================================================================================================
  // InboxService
  // =================================================================================================================

  list(principal: Principal, input: Req<'inbox.list'> = {}): Res<'inbox.list'> {
    const userId = this.memberOf(principal);
    if (userId === null) return { items: [], hasMore: false };
    const items = this.itemsOf(userId);
    const after = input.after;
    // THE list rule over the items in key order. An `after` that left the box meanwhile continues after where it was
    // (keys are ordered), instead of starting over.
    const known = after === undefined || items.some((item) => item.key === after);
    const page = known ? takeListPage(items, after, (item) => item.key) : takeListPage(items.filter((item) => item.key > (after as string)), undefined, (item) => item.key);
    return { items: page.items, hasMore: page.hasMore };
  }

  seen(principal: Principal, keys: readonly string[]): void {
    const userId = this.memberOf(principal);
    if (userId === null) return;
    this.flush();
    const list = this.lists.get(userId);
    const box = this.doc.get().members[userId];
    const opened = new Set<string>();
    const marks = new Map<string, string>();
    for (const key of new Set(keys)) {
      // Opening a mention or a result removes it; anything else is only read.
      if (box?.notes.some((note) => noteKey(note) === key) === true) opened.add(key);
      else {
        const entry = list?.get(key);
        if (entry !== undefined && entry.stamp !== null && entry.item.unread) marks.set(key, entry.stamp);
      }
    }
    if (opened.size === 0 && marks.size === 0) return;
    this.doc.update((draft) => {
      const mine = (draft.members[userId] ??= emptyBox());
      mine.notes = mine.notes.filter((note) => !opened.has(noteKey(note)));
      for (const [key, stamp] of marks) mine.seen[key] = stamp;
      // Never more marks than an inbox has items: marks of items that left go first (they go at the next recompute anyway).
      if (Object.keys(mine.seen).length > INBOX_ITEMS_MAX) for (const key of Object.keys(mine.seen)) if (list?.has(key) !== true) delete mine.seen[key];
    });
    this.dirty = true;
    this.flush();
  }

  dismiss(principal: Principal, key: string): void {
    const userId = this.memberOf(principal);
    if (userId === null) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
    this.flush();
    if (this.doc.get().members[userId]?.notes.some((note) => noteKey(note) === key) === true) {
      this.doc.update((draft) => {
        const mine = draft.members[userId];
        if (mine !== undefined) mine.notes = mine.notes.filter((note) => noteKey(note) !== key);
      });
      this.dirty = true;
      this.flush();
      return;
    }
    // A thing that waits leaves when it is settled, never by dismissal.
    if (this.lists.get(userId)?.has(key) === true) throw new SmurgError('conflict', msg('inbox.notDismissable'), { reason: 'not-dismissable' });
    throw new SmurgError('not_found', msg('inbox.itemGone'), { reason: 'gone' });
  }

  addMention(input: { readonly userId: UserId; readonly from: Actor; readonly target: ColumnTarget; readonly anchor?: { readonly cardId?: string; readonly seq?: number }; readonly excerpt: string }): 'stored' | 'full' {
    // The caller keeps only active members (ARCHITECTURE §5.11); somebody who is not one has no inbox to fill.
    if (this.ctx.members.active(input.userId) === null) return 'stored';
    if (this.notesOf(input.userId).length >= this.noteLimit()) return 'full';
    const anchor = { ...(input.anchor?.cardId === undefined ? {} : { cardId: input.anchor.cardId }), ...(input.anchor?.seq === undefined ? {} : { seq: input.anchor.seq }) };
    this.keep(input.userId, {
      id: newId('nt'),
      kind: 'mention',
      at: this.ctx.clock.now(),
      from: input.from,
      target: input.target,
      ...(Object.keys(anchor).length === 0 ? {} : { anchor }),
      excerpt: excerptOf(input.excerpt),
    });
    return 'stored';
  }

  addResult(input: { readonly userId: UserId; readonly from: Actor; readonly suggestionId: string; readonly sessionId: string; readonly outcome: 'rejected' | 'accepted-edited'; readonly excerpt: string }): void {
    if (this.ctx.members.active(input.userId) === null) return;
    const notes = this.notesOf(input.userId);
    // One result per suggestion (it is decided once); an unopened note is never pushed out by a new one.
    if (notes.some((note) => note.kind === 'result' && note.suggestionId === input.suggestionId)) return;
    if (notes.length >= this.noteLimit()) {
      this.ctx.log.debug('inbox: a result was not stored, the member has too many unopened notes', { module: 'inbox' });
      return;
    }
    this.keep(input.userId, {
      id: newId('nt'),
      kind: 'result',
      at: this.ctx.clock.now(),
      from: input.from,
      sessionId: input.sessionId,
      suggestionId: input.suggestionId,
      outcome: input.outcome,
      excerpt: excerptOf(input.excerpt),
    });
  }

  /** The member's items right now, in key order. */
  itemsOf(userId: UserId): InboxItem[] {
    this.flush();
    return [...(this.lists.get(userId)?.values() ?? [])].map((entry) => structuredClone(entry.item)).sort(byKey);
  }

  // =================================================================================================================
  // Stored notes
  // =================================================================================================================

  private notesOf(userId: UserId): readonly StoredNote[] {
    return this.doc.get().members[userId]?.notes ?? [];
  }

  /** Stored notes per member: the daemon's setting, never more than the document (and the wire's bound) allows. */
  private noteLimit(): number {
    return Math.max(0, Math.min(this.ctx.config.agents.inboxNotesPerMember, INBOX_NOTES_PER_MEMBER_MAX));
  }

  /**
   * Stores a note. The request that caused it has done its work already (the message went to the agent, the
   * suggestion is decided): a note that is not valid for the wire is a bug of the caller, reported in the log, and
   * never a reason to fail that request.
   */
  private keep(userId: UserId, candidate: unknown): void {
    const note = storedNoteSchema.safeParse(candidate);
    if (!note.success) {
      this.ctx.log.error('inbox: a note was not stored, it is not valid', { module: 'inbox', issue: note.error.issues[0]?.path.map(String).join('.') ?? '' });
      return;
    }
    try {
      this.doc.update((draft) => {
        (draft.members[userId] ??= emptyBox()).notes.push(note.data);
      });
    } catch (err) {
      this.ctx.log.error('inbox: a note was not stored', { module: 'inbox', error: err instanceof Error ? err.name : 'unknown' });
      return;
    }
    this.touch();
  }

  /** A topic was deleted: the notes that point into it (its sessions, its spec, plan and reports) go with it. */
  private topicRemoved(topicId: string, sessionIds: readonly string[]): void {
    const sessions = new Set(sessionIds);
    for (const sessionId of sessionIds) this.sessionFacts.delete(sessionId);
    const pointsInto = (note: StoredNote): boolean => {
      if (note.kind === 'result') return sessions.has(note.sessionId);
      const target = note.target;
      if (target.kind === 'session') return sessions.has(target.sessionId);
      return (target.kind === 'spec' || target.kind === 'plan' || target.kind === 'report') && target.topicId === topicId;
    };
    if (Object.values(this.doc.get().members).some((box) => box.notes.some(pointsInto))) {
      this.doc.update((draft) => {
        for (const box of Object.values(draft.members)) box.notes = box.notes.filter((note) => !pointsInto(note));
      });
    }
    this.touch();
  }

  /** Kicked: their notes and marks go (ARCHITECTURE §7.3 `member.kicked`); their channels are closed already. */
  private memberKicked(userId: UserId): void {
    this.lists.delete(userId);
    if (this.doc.get().members[userId] !== undefined) {
      this.doc.update((draft) => {
        delete draft.members[userId];
      });
    }
    this.memberWent();
  }

  /**
   * A member was kicked, left or changed role. Who is a member with which role is in force now; the teardown of
   * ARCHITECTURE §3 "When a member goes" runs AFTER this event, and the last thing it clears (a session's fallback
   * decider) is announced by nobody: look again when it has had its time. (The sweep would find it too, later.)
   */
  private memberWent(): void {
    this.touch();
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.touch();
    }, TEARDOWN_RECHECK_MS);
    timer.unref();
    this.timers.add(timer);
  }

  // =================================================================================================================
  // Recomputing
  // =================================================================================================================

  private refresh(source: AttentionSource): void {
    this.stale.add(source);
    this.touch();
  }

  /**
   * `session.created` / `session.updated`. An agent session is updated with every event of its conversation; an inbox
   * depends only on who is responsible for it, who its fallback decider is, and what its topic and item are called.
   * A terminal is in nobody's inbox.
   */
  private sessionChanged(session: SessionInfo): void {
    if (session.kind !== 'agent') return;
    const facts = JSON.stringify(this.sessionView(session.id));
    if (this.sessionFacts.get(session.id) === facts) return;
    this.sessionFacts.set(session.id, facts);
    this.touch();
  }

  /** Something an inbox is derived from changed: recompute once this synchronous run of the daemon is over. */
  private touch(): void {
    this.dirty = true;
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.dirty || this.stopped) return;
    this.dirty = false;
    try {
      this.recompute();
    } catch (err) {
      // The view stays as it was; the next event or the sweep tries again.
      this.ctx.log.error('inbox: recompute failed', { module: 'inbox', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private recompute(): void {
    const world = this.world();
    const derived = deriveInbox(world);
    const doc = this.doc.get();
    const active = new Set(world.members.map((member) => member.userId));
    const markChanges = new Map<UserId, { readonly set: Map<string, string>; readonly drop: string[] }>();

    for (const userId of active) {
      const box: MemberBox | undefined = doc.members[userId];
      const seen = box?.seen ?? {};
      const next: { item: InboxItem; stamp: string | null }[] = [];
      const derivedKeys = new Set<string>();
      const set = new Map<string, string>();
      for (const { body, stamp } of derived.get(userId) ?? []) {
        if (derivedKeys.has(body.key)) continue;
        derivedKeys.add(body.key);
        const mark = seen[body.key];
        // Unread without a mark, and again when the stamp moved on to something (derive.ts "STAMPS").
        const unread = mark === undefined || (stamp !== '' && mark !== stamp);
        if (mark !== undefined && mark !== '' && stamp === '') set.set(body.key, '');
        next.push({ item: { ...body, unread }, stamp });
      }
      for (const note of box?.notes ?? []) next.push({ item: { ...noteItem(note, world), unread: true }, stamp: null });
      this.publish(userId, this.capped(userId, next));
      // A mark lives as long as its item is in this member's inbox. (Not before every source has started: their
      // items are not there yet, and a restart must not make everything unread again.)
      const drop = this.started ? Object.keys(seen).filter((key) => !derivedKeys.has(key)) : [];
      if (set.size > 0 || drop.length > 0) markChanges.set(userId, { set, drop });
    }
    // Whoever is no longer an active member has no inbox (their channels are closed: nothing is sent).
    for (const userId of [...this.lists.keys()]) if (!active.has(userId)) this.lists.delete(userId);

    if (markChanges.size > 0) {
      this.doc.update((draft) => {
        for (const [userId, change] of markChanges) {
          const mine = draft.members[userId];
          if (mine === undefined) continue;
          for (const key of change.drop) delete mine.seen[key];
          for (const [key, stamp] of change.set) mine.seen[key] = stamp;
          if (mine.notes.length === 0 && Object.keys(mine.seen).length === 0) delete draft.members[userId];
        }
      });
    }
  }

  /** At most INBOX_ITEMS_MAX items: what an agent or a plan is stopped on first (oldest first), then the newest of the rest. */
  private capped(userId: UserId, items: { item: InboxItem; stamp: string | null }[]): { item: InboxItem; stamp: string | null }[] {
    const flag = `full ${userId}`;
    if (items.length <= INBOX_ITEMS_MAX) {
      this.reported.delete(flag);
      return items;
    }
    this.reportOnce(flag, 'inbox: a member has more items than an inbox holds; the oldest that do not stop work are left out', { items: items.length });
    return [...items].sort((a, b) => Number(b.item.waiting) - Number(a.item.waiting) || (a.item.waiting ? a.item.at - b.item.at : b.item.at - a.item.at) || byKey(a.item, b.item)).slice(0, INBOX_ITEMS_MAX);
  }

  /** Replaces what a member's inbox holds and tells their clients what changed. */
  private publish(userId: UserId, items: readonly { item: InboxItem; stamp: string | null }[]): void {
    const before = this.lists.get(userId) ?? new Map<string, Entry>();
    const after = new Map<string, Entry>();
    const upsert: InboxItem[] = [];
    for (const { item, stamp } of items) {
      const json = JSON.stringify(item);
      const old = before.get(item.key);
      if (old !== undefined && old.json === json) {
        after.set(item.key, old.stamp === stamp ? old : { ...old, stamp });
        continue;
      }
      // Every item is valid for its kind (INBOX_KIND_FIELDS) before it is anybody's: one bad item must not cost a
      // member the rest of their inbox.
      const parsed = inboxItemSchema.safeParse(item);
      const flag = `invalid ${item.key}`;
      if (!parsed.success) {
        this.reportOnce(flag, 'inbox: an item is not valid for the wire and was left out', { kind: item.kind, issue: parsed.error.issues[0]?.path.map(String).join('.') ?? '' });
        continue;
      }
      this.reported.delete(flag);
      after.set(item.key, { item: parsed.data, json, stamp });
      upsert.push(parsed.data);
    }
    const remove = [...before.keys()].filter((key) => !after.has(key));
    if (after.size === 0) this.lists.delete(userId);
    else this.lists.set(userId, after);
    if (upsert.length > 0 || remove.length > 0) this.send(userId, upsert, remove);
  }

  /** `inbox.changed` to the member's own interactive channels, in messages that each keep the size rule of a list. */
  private send(userId: UserId, upsert: readonly InboxItem[], remove: readonly string[]): void {
    try {
      for (const page of changePages(upsert, remove)) this.ctx.hub.sendToUser(userId, 'inbox.changed', page);
    } catch (err) {
      this.ctx.log.error('inbox: inbox.changed was not sent', { module: 'inbox', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  // =================================================================================================================
  // The world an inbox is derived from
  // =================================================================================================================

  private world(): InboxWorld {
    const services = this.ctx.services;
    const sessions = new Map<string, SessionView | null>();
    const plans = new Map<string, PlanInfo | null>();
    const topics = new Map<string, boolean>();
    return {
      members: this.ctx.members.routing(),
      userRef: (userId) => this.ctx.members.userRef(userId),
      isOnline: (userId) => this.ctx.hub.isOnline(userId),
      questions: this.read('questions', services.conversation, () => services.conversation.openQuestions()),
      permissions: this.read('permissions', services.conversation, () => services.conversation.openPermissions()),
      suggestions: this.read('suggestions', services.suggestions, () => services.suggestions.pending()),
      reports: this.read('reports', services.reports, () => services.reports.toReview()),
      merges: this.read('merges', services.worktrees, () => services.worktrees.listMerges(SYSTEM_PRINCIPAL)),
      attention: this.attention(),
      session: (sessionId) => {
        if (!sessions.has(sessionId)) sessions.set(sessionId, this.sessionView(sessionId));
        return sessions.get(sessionId) ?? null;
      },
      plan: (topicId) => {
        if (!plans.has(topicId)) plans.set(topicId, this.ask('plans', services.plans, () => services.plans.get(topicId), null));
        return plans.get(topicId) ?? null;
      },
      topicOpen: (topicId) => {
        // A topic nobody can tell about counts as open: better an item too many than something waiting unseen.
        if (!topics.has(topicId)) topics.set(topicId, this.ask('topics', services.topics, () => services.topics.get(topicId)?.archived === false, true));
        return topics.get(topicId) ?? true;
      },
    };
  }

  private sessionView(sessionId: string): SessionView | null {
    const agents = this.ctx.services.agents;
    return this.ask(
      'sessions',
      agents,
      () => {
        const session = agents.get(sessionId);
        if (session === null) return null;
        const facts = agents.facts(sessionId);
        return {
          responsible: session.responsible?.userId ?? null,
          fallbackDecider: facts?.fallbackDecider ?? null,
          ...(session.topicId === undefined ? {} : { topicId: session.topicId }),
          ...(session.itemId === undefined ? {} : { itemId: session.itemId }),
          ...(session.item === undefined ? {} : { item: session.item }),
        };
      },
      null,
    );
  }

  /** The attention facts of every source; a stale source is asked again (ARCHITECTURE §7.3 `attention.changed`). */
  private attention(): AttentionFact[] {
    const services = this.ctx.services;
    const sources: Readonly<Record<AttentionSource, { readonly service: unknown; readonly ask: () => AttentionFact[] }>> = {
      topics: { service: services.topics, ask: () => services.topics.attention() },
      sessions: { service: services.agents, ask: () => services.agents.attention() },
      trust: { service: services.projectTrust, ask: () => services.projectTrust.attention() },
      'host-rules': { service: services.hostRules, ask: () => services.hostRules.attention() },
    };
    for (const source of this.stale) {
      const { service, ask } = sources[source];
      if (isStubService(service)) this.facts.set(source, []);
      else {
        try {
          this.facts.set(source, ask());
          this.reported.delete(`source attention:${source}`);
        } catch (err) {
          // What the source said last stands until it answers again.
          this.reportOnce(`source attention:${source}`, 'inbox: an attention source failed', { source, error: err instanceof Error ? err.name : 'unknown' });
        }
      }
    }
    this.stale.clear();
    // A fact keeps the time it was first seen for as long as it lasts: its row does not grow younger when a source
    // is asked again.
    const since = new Map<string, number>();
    const out: AttentionFact[] = [];
    for (const source of ATTENTION_SOURCES) {
      for (const fact of this.facts.get(source) ?? []) {
        const key = attentionKey(fact.subject, fact.id);
        const at = this.since.get(key) ?? since.get(key) ?? fact.at;
        since.set(key, at);
        out.push(at === fact.at ? fact : { ...fact, at });
      }
    }
    this.since = since;
    return out;
  }

  /** A list from another service: empty while its module is not there; what it said last while it throws. */
  private read<T>(name: string, service: unknown, fn: () => readonly T[]): readonly T[] {
    if (isStubService(service)) return [];
    const flag = `source ${name}`;
    try {
      const value = fn();
      this.lastGood.set(name, value);
      this.reported.delete(flag);
      return value;
    } catch (err) {
      this.reportOnce(flag, 'inbox: a source failed', { source: name, error: err instanceof Error ? err.name : 'unknown' });
      return (this.lastGood.get(name) as readonly T[] | undefined) ?? [];
    }
  }

  /** One fact from another service, or `fallback` while its module is not there or it throws. */
  private ask<T>(name: string, service: unknown, fn: () => T, fallback: T): T {
    if (isStubService(service)) return fallback;
    const flag = `source ${name}`;
    try {
      const value = fn();
      this.reported.delete(flag);
      return value;
    } catch (err) {
      this.reportOnce(flag, 'inbox: a source failed', { source: name, error: err instanceof Error ? err.name : 'unknown' });
      return fallback;
    }
  }

  private reportOnce(flag: string, message: string, fields: Readonly<Record<string, string | number>>): void {
    if (this.reported.has(flag)) return;
    if (this.reported.size > 1_000) this.reported.clear();
    this.reported.add(flag);
    this.ctx.log.warn(message, { module: 'inbox', ...fields });
  }

  /** The active member a request is from; null for an agent, the system, and anybody who is not a member. */
  private memberOf(principal: Principal): UserId | null {
    if (principal.kind !== 'user' || principal.userId === null) return null;
    return this.ctx.members.active(principal.userId) === null ? null : principal.userId;
  }
}
