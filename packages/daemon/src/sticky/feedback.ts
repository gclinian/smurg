// The feedback on sticky notes (DESIGN 0.8.0 D4): what anyone in the workspace, a Viewer too, writes about a note
// for Claude to work in. It is kept in `sticky.json` and shown to every member; it reaches NO agent here. The one way
// to an agent is accept.ts (a member with `session.drive` accepts it: one message to Claude for the sticky notes).
//
//   sticky.feedback.create    on a note the index holds; the text cleaned once with agentText (what is stored, shown
//                             and quoted is the same string); within the bounds of D4.5; audited with its full text
//   sticky.feedback.withdraw  its author, while it waits: removed at once (the audit log keeps it)
//   sticky.feedback.reject    a member with `session.drive`, while it waits: `rejected`; nothing is sent; its reason
//                             counts toward the stored bound as a text does
//   sticky.feedback.list      every entry kept, oldest first, by the list rule; a page after an entry that went
//                             meanwhile goes on after where that entry was
//   sticky.feedback.updated   one entry as it is now, or the id of one that went, to every member
//
// The bounds (D4.5): at most FEEDBACK_MAX entries and FEEDBACK_STORED_MAX_CHARS characters of text and reasons
// together. Waiting feedback is never dropped: a create, or a reject's reason, that does not fit once the oldest
// rejected entries, then the oldest accepted ones, are gone is refused (`feedback-full`). At most FEEDBACK_WAITING_PER_MEMBER_MAX waiting per
// member and FEEDBACK_WAITING_FROM_MEMBERS_MAX from members together (the outside budgets come with the sources).
// When a member is removed (kicked, or left), their waiting feedback is withdrawn by the system.
//
// Every change happens in one synchronous step of the event loop (a check and its write never interleave with
// another request's), so no serialization is needed here; an accept on its way to the agent is in `accepting`, and
// nothing else changes that entry meanwhile.
import {
  FEEDBACK_MAX,
  FEEDBACK_STORED_MAX_CHARS,
  FEEDBACK_TEXT_MAX_CHARS,
  FEEDBACK_WAITING_FROM_MEMBERS_MAX,
  FEEDBACK_WAITING_PER_MEMBER_MAX,
  SmurgError,
  agentTextWithin,
  feedbackInputTextSchema,
  feedbackStoredChars,
  takeListPage,
  type Feedback,
  type FeedbackAuthorForAgent,
  type PayloadOf,
  type ResultInputOf,
  type UserRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { PersistentDocument, Principal, UserId } from '../core/interfaces.ts';
import { DisposableStack, newId, type Disposable } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR, principalCan } from '../core/permissions.ts';
import type { NoteIndex } from './index.ts';
import type { StickyDocument } from './store.ts';

export interface FeedbackLimits {
  /** Waiting feedback of one member (`sticky.feedback.tooManyWaiting`). */
  readonly waitingPerMember: number;
  /** Waiting feedback of all members together (`sticky.feedback.full`). */
  readonly waitingFromMembers: number;
  /** Entries kept in sticky.json. */
  readonly maxEntries: number;
  /** Characters of the texts and reasons of every entry kept (`feedbackStoredChars`). */
  readonly maxStoredChars: number;
}

export const DEFAULT_FEEDBACK_LIMITS: FeedbackLimits = Object.freeze({
  waitingPerMember: FEEDBACK_WAITING_PER_MEMBER_MAX,
  waitingFromMembers: FEEDBACK_WAITING_FROM_MEMBERS_MAX,
  maxEntries: FEEDBACK_MAX,
  maxStoredChars: FEEDBACK_STORED_MAX_CHARS,
});

/** Why the system withdrew someone's waiting feedback (the audit's `reason`). */
export type SystemWithdrawReason = 'author-kicked' | 'author-left' | 'author-removed';

const NOT_FOUND = (): SmurgError => new SmurgError('not_found', msg('sticky.feedback.notFound'), { reason: 'unknown-feedback' });
/** The refusal every late withdraw, accept and reject gets: how it ended. */
export const NOT_WAITING = (entry: Pick<Feedback, 'id' | 'status'>): SmurgError =>
  new SmurgError('conflict', msg('sticky.feedback.notWaiting'), { reason: 'not-waiting', feedbackId: entry.id, status: entry.status });
/** An accept of this entry is on its way to the agent: nothing else may change it now. */
export const ACCEPTING = (entry: Pick<Feedback, 'id'>): SmurgError => new SmurgError('conflict', msg('sticky.feedback.accepting'), { reason: 'accepting', feedbackId: entry.id });

/** The author's user id of a member's feedback, else null (an outside author is nobody's). */
export function memberAuthorOf(entry: Feedback): UserId | null {
  return entry.author.kind === 'member' ? entry.author.user.userId : null;
}

/** How many entries that went (withdrawn, dropped at a bound) the list remembers the place of. */
const GONE_REMEMBERED = FEEDBACK_MAX;

export class FeedbackService {
  /** Accepts on their way to the agent (accept.ts): an entry here is changed by nothing else until it settles. */
  readonly accepting = new Set<string>();
  readonly limits: FeedbackLimits;
  /**
   * Each entry that went, and the id of the entry right before it then (null: it was the first). Entries are only ever
   * added at the end, so a page asked for after one of them goes on after where it was (`list`).
   */
  private readonly gone = new Map<string, string | null>();
  private readonly ctx: DaemonContext;
  private readonly index: NoteIndex;
  private readonly document: () => PersistentDocument<StickyDocument>;

  constructor(ctx: DaemonContext, deps: { readonly index: NoteIndex; readonly document: () => PersistentDocument<StickyDocument>; readonly limits?: Partial<FeedbackLimits> }) {
    this.ctx = ctx;
    this.index = deps.index;
    this.document = deps.document;
    this.limits = Object.freeze({ ...DEFAULT_FEEDBACK_LIMITS, ...deps.limits });
  }

  /** Bus wiring: a member who is removed takes their waiting feedback with them (D4.5), withdrawn by the system. */
  attach(): Disposable {
    const stack = new DisposableStack();
    stack.add(this.ctx.bus.on('member.kicked', (event) => this.withdrawAllBySystem(event.userId, 'author-kicked')));
    stack.add(this.ctx.bus.on('member.left', (event) => this.withdrawAllBySystem(event.userId, 'author-left')));
    return stack;
  }

  // =================================================================================================================
  // Requests
  // =================================================================================================================

  /** `sticky.feedback.create` (D4.4, D4.5): `feedback.give`, on a note the index holds, within the bounds. */
  async create(input: PayloadOf<'sticky.feedback.create'>, principal: Principal): Promise<Feedback> {
    const author = this.memberOf(principal);
    if (!principalCan(principal, 'feedback.give')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const note = this.index.find(input.note);
    if (note === null) throw new SmurgError('not_found', msg('sticky.note.missing', { name: input.note }), { reason: 'unknown-note' });
    const { text, cleaned } = cleanText(input.text);
    const entry: Feedback = {
      id: newId('fb'),
      // The name on disk: Home and home are one note (D1.3).
      note: note.name,
      text,
      ...(cleaned ? { cleaned: true as const } : {}),
      author: { kind: 'member', user: author },
      status: 'waiting',
      createdAt: this.ctx.clock.now(),
    };
    const waiting = this.entries().filter((item) => item.status === 'waiting' && item.author.kind === 'member');
    if (waiting.filter((item) => memberAuthorOf(item) === author.userId).length >= this.limits.waitingPerMember) {
      throw new SmurgError('conflict', msg('sticky.feedback.tooManyWaiting', { max: this.limits.waitingPerMember }), { reason: 'feedback-full', bound: 'author' });
    }
    if (waiting.length >= this.limits.waitingFromMembers) throw fullError('members');
    const dropped = this.makeRoom({ entries: 1, chars: feedbackStoredChars(entry) });
    if (dropped === null) throw fullError('stored');
    this.forget(dropped);
    this.document().update((draft) => {
      const gone = new Set(dropped);
      draft.feedback = draft.feedback.filter((item) => !gone.has(item.id));
      draft.feedback.push(entry);
    });
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'sticky.feedback.create',
      outcome: 'ok',
      target: entry.id,
      detail: { feedbackId: entry.id, note: entry.note, authorUserId: author.userId, writtenBy: author.displayName, feedback: entry.text, createdAt: entry.createdAt, ...(cleaned ? { cleaned: true } : {}) },
      fullText: ['feedback'],
    });
    for (const id of dropped) this.ctx.hub.broadcast('sticky.feedback.updated', { removed: id });
    this.publish(entry);
    await this.persist();
    return entry;
  }

  /** `sticky.feedback.withdraw`: its author, while it waits. Removed at once; the reply says `withdrawn`. */
  async withdraw(input: PayloadOf<'sticky.feedback.withdraw'>, principal: Principal): Promise<Feedback> {
    const entry = this.require(input.feedbackId);
    const author = memberAuthorOf(entry);
    if (principal.userId === null || author === null || principal.userId !== author) {
      throw new AuthorizationError(msg('sticky.feedback.authorOnly'), { reason: 'not-author:feedback' });
    }
    if (entry.status !== 'waiting') throw NOT_WAITING(entry);
    if (this.accepting.has(entry.id)) throw ACCEPTING(entry);
    const withdrawn = this.remove(entry);
    this.auditOutcome(principal.actor, 'sticky.feedback.withdraw', withdrawn, {});
    await this.persist();
    return withdrawn;
  }

  /**
   * `sticky.feedback.reject` (D4.7): `session.drive`, while it waits. Nothing is sent to any agent. Its reason is
   * stored with it and counts toward the stored bound (D4.5): the oldest decided entries make room for it as for a new
   * text, each told as gone first; when they cannot (only waiting feedback is left), the reject is refused
   * (`feedback-full`) instead of storing over the bound. (With the real budgets that cannot happen: waiting texts fill
   * at most 500 × 4000 of the 2 Mi characters.)
   */
  async reject(input: PayloadOf<'sticky.feedback.reject'>, principal: Principal): Promise<Feedback> {
    const entry = this.require(input.feedbackId);
    const by = this.driverOf(principal);
    if (entry.status !== 'waiting') throw NOT_WAITING(entry);
    if (this.accepting.has(entry.id)) throw ACCEPTING(entry);
    const reason = input.reason !== undefined && input.reason.length > 0 ? input.reason : undefined;
    const dropped = this.makeRoom({ entries: 0, chars: reason?.length ?? 0 }, entry.id);
    if (dropped === null) throw fullError('stored');
    this.forget(dropped);
    const rejected = this.decide(
      entry.id,
      (draft) => {
        draft.status = 'rejected';
        draft.decidedBy = by;
        draft.decidedAt = this.ctx.clock.now();
        if (reason !== undefined) draft.rejectReason = reason;
      },
      dropped,
    );
    this.auditOutcome(principal.actor, 'sticky.feedback.reject', rejected, {});
    for (const id of dropped) this.ctx.hub.broadcast('sticky.feedback.updated', { removed: id });
    this.publish(rejected);
    await this.persist();
    return rejected;
  }

  /**
   * `sticky.feedback.list`: every entry kept, oldest first; one page of THE list rule after `after`. Entries go often
   * (withdrawn, dropped at a bound): an `after` that went meanwhile goes on after where it was, through the entries
   * that were before it, instead of starting over (a reader would get the first pages twice), as `inbox.list` does.
   * An `after` the list never had, or no longer remembers, starts from the first entry, as the list rule says.
   */
  list(input: PayloadOf<'sticky.feedback.list'>): ResultInputOf<'sticky.feedback.list'> {
    const entries = this.entries();
    const page = takeListPage(entries, this.placeOf(input.after, entries), (entry) => entry.id);
    return { feedback: page.items, hasMore: page.hasMore };
  }

  // =================================================================================================================
  // For accept.ts and the handlers
  // =================================================================================================================

  /** The entry, or null. */
  get(feedbackId: string): Feedback | null {
    return this.entries().find((entry) => entry.id === feedbackId) ?? null;
  }

  /** The entry, or `not_found`. */
  require(feedbackId: string): Feedback {
    const entry = this.get(feedbackId);
    if (entry === null) throw NOT_FOUND();
    return entry;
  }

  /** The member who decides (accept, reject): `session.drive`, and a member now; else `forbidden`. */
  driverOf(principal: Principal): UserRef {
    if (principal.userId === null || !principalCan(principal, 'session.drive')) throw new AuthorizationError(undefined, { reason: 'capability' });
    return this.memberOf(principal);
  }

  /**
   * Who wrote it, as `composeFeedback` names them: a member with their role NOW (as the notes view's members store
   * holds it), or the person outside the workspace as stored. Null: the member who wrote it is no longer one.
   */
  authorForAgent(entry: Feedback): FeedbackAuthorForAgent | null {
    if (entry.author.kind === 'outside') return { kind: 'outside', source: entry.author.source, name: entry.author.name, externalId: entry.author.externalId };
    const role = this.ctx.members.roleOf(entry.author.user.userId);
    if (role === null) return null;
    return { kind: 'member', userId: entry.author.user.userId, displayName: entry.author.user.displayName, role };
  }

  /** accept.ts, after its message was sent: `accepted`, by whom and when; audited and told to every member. */
  async markAccepted(feedbackId: string, by: UserRef, actor: Principal['actor'], sessionId: string): Promise<Feedback> {
    const accepted = this.decide(feedbackId, (draft) => {
      draft.status = 'accepted';
      draft.decidedBy = by;
      draft.decidedAt = this.ctx.clock.now();
    });
    this.auditOutcome(actor, 'sticky.feedback.accept', accepted, { sessionId });
    this.publish(accepted);
    await this.persist();
    return accepted;
  }

  /**
   * The system withdraws one waiting entry whose author is no longer a member (D4.5): removed, audited by the system,
   * told to every member. Not while an accept of it is on its way (that accept settles it).
   */
  withdrawBySystem(feedbackId: string, reason: SystemWithdrawReason): void {
    const entry = this.get(feedbackId);
    if (entry === null || entry.status !== 'waiting' || this.accepting.has(entry.id)) return;
    const withdrawn = this.remove(entry);
    this.auditOutcome(SYSTEM_ACTOR, 'sticky.feedback.withdraw', withdrawn, { reason });
    void this.persist();
  }

  /** After an accept whose send failed: an entry whose author went meanwhile is withdrawn now. */
  afterFailedAccept(feedbackId: string): void {
    const entry = this.get(feedbackId);
    if (entry !== null && entry.status === 'waiting' && entry.author.kind === 'member' && this.ctx.members.roleOf(entry.author.user.userId) === null) {
      this.withdrawBySystem(entry.id, 'author-removed');
    }
  }

  // =================================================================================================================
  // Internals
  // =================================================================================================================

  private withdrawAllBySystem(userId: UserId, reason: SystemWithdrawReason): void {
    for (const entry of this.entries()) if (entry.status === 'waiting' && memberAuthorOf(entry) === userId) this.withdrawBySystem(entry.id, reason);
  }

  /**
   * What must go so that `adding` (a new entry, or a reject's reason) fits the stored bounds: the ids of the oldest
   * rejected entries, then of the oldest accepted ones, as few as needed; never `keep` (the entry being decided), never
   * one an accept is on its way for. Null: it does not fit even then (waiting feedback is never dropped).
   */
  private makeRoom(adding: { readonly entries: number; readonly chars: number }, keep?: string): string[] | null {
    const kept = this.entries();
    let count = kept.length + adding.entries;
    let chars = kept.reduce((sum, item) => sum + feedbackStoredChars(item), 0) + adding.chars;
    const dropped: string[] = [];
    for (const status of ['rejected', 'accepted'] as const) {
      for (const item of kept) {
        if (count <= this.limits.maxEntries && chars <= this.limits.maxStoredChars) return dropped;
        if (item.status !== status || item.id === keep || this.accepting.has(item.id)) continue;
        dropped.push(item.id);
        count -= 1;
        chars -= feedbackStoredChars(item);
      }
    }
    return count <= this.limits.maxEntries && chars <= this.limits.maxStoredChars ? dropped : null;
  }

  /** Removes a waiting entry and returns it as `withdrawn` (D4.5: a withdrawn entry is not kept). */
  private remove(entry: Feedback): Feedback {
    this.forget([entry.id]);
    this.document().update((draft) => {
      draft.feedback = draft.feedback.filter((item) => item.id !== entry.id);
    });
    this.ctx.hub.broadcast('sticky.feedback.updated', { removed: entry.id });
    return { ...entry, status: 'withdrawn' };
  }

  /** Changes one entry; `dropped` (the room `makeRoom` made for the change) goes in the same update. */
  private decide(feedbackId: string, change: (draft: Feedback) => void, dropped: readonly string[] = []): Feedback {
    const next = this.document().update((draft) => {
      if (dropped.length > 0) {
        const gone = new Set(dropped);
        draft.feedback = draft.feedback.filter((item) => !gone.has(item.id));
      }
      const item = draft.feedback.find((candidate) => candidate.id === feedbackId);
      if (item !== undefined) change(item);
    });
    const updated = next.feedback.find((candidate) => candidate.id === feedbackId);
    if (updated === undefined) throw NOT_FOUND();
    return { ...updated };
  }

  private auditOutcome(actor: Principal['actor'], action: 'sticky.feedback.accept' | 'sticky.feedback.reject' | 'sticky.feedback.withdraw', entry: Feedback, extra: Record<string, unknown>): void {
    this.ctx.audit.record({
      actor,
      action,
      outcome: 'ok',
      target: entry.id,
      detail: {
        feedbackId: entry.id,
        note: entry.note,
        ...(entry.author.kind === 'member'
          ? { authorUserId: entry.author.user.userId, writtenBy: entry.author.user.displayName }
          : { outsideSource: entry.author.source, outsideId: entry.author.externalId, writtenBy: entry.author.name }),
        outcome: entry.status,
        feedback: entry.text,
        ...(entry.rejectReason !== undefined ? { rejectReason: entry.rejectReason } : {}),
        createdAt: entry.createdAt,
        ...(entry.decidedAt !== undefined ? { decidedAt: entry.decidedAt } : {}),
        ...extra,
      },
      // The detail keys of feedback are its own (the console names them: "Sticky note", "Written by", "Feedback").
      fullText: ['feedback'],
    });
  }

  /** `sticky.feedback.updated` to every member (every role holds `file.read`). */
  private publish(entry: Feedback): void {
    this.ctx.hub.broadcast('sticky.feedback.updated', { feedback: entry });
  }

  private memberOf(principal: Principal): UserRef {
    const member = principal.kind === 'user' && principal.userId !== null ? this.ctx.members.active(principal.userId) : null;
    if (member === null) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
    return { userId: member.userId, displayName: member.displayName };
  }

  private entries(): readonly Feedback[] {
    return this.document().get().feedback;
  }

  /** Remembers where each of `ids` was, just before they are removed (`list` goes on after them). */
  private forget(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const going = new Set(ids);
    const entries = this.entries();
    entries.forEach((item, index) => {
      if (!going.has(item.id)) return;
      this.gone.set(item.id, index === 0 ? null : (entries[index - 1] as Feedback).id);
      if (this.gone.size > GONE_REMEMBERED) this.gone.delete(this.gone.keys().next().value as string);
    });
  }

  /**
   * Where a page after `after` starts: `after` while it is kept; for one that went, the nearest entry before it that
   * is still kept (undefined when none is: every entry kept came after it); for an id never seen, or forgotten,
   * undefined (the list rule: from the first entry).
   */
  private placeOf(after: string | undefined, entries: readonly Feedback[]): string | undefined {
    if (after === undefined) return undefined;
    const kept = new Set(entries.map((entry) => entry.id));
    let id: string | null | undefined = after;
    for (let steps = 0; steps <= this.gone.size && typeof id === 'string'; steps++) {
      if (kept.has(id)) return id;
      id = this.gone.get(id);
    }
    return undefined;
  }

  private async persist(): Promise<void> {
    try {
      await this.document().flush();
    } catch (err) {
      this.ctx.log.error('sticky.json write failed', { module: 'sticky', error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}

/** Validates the text again inside the service (fail closed) and cleans it: the one place feedback passes agentText. */
function cleanText(text: unknown): { readonly text: string; readonly cleaned: boolean } {
  const parsed = feedbackInputTextSchema.safeParse(text);
  if (!parsed.success) throw new SmurgError('bad_request', msg('sticky.feedback.invalidText'), { reason: 'invalid-text' });
  const within = agentTextWithin(parsed.data, FEEDBACK_TEXT_MAX_CHARS);
  if (!within.ok) throw new SmurgError('bad_request', msg('sticky.feedback.invalidText'), { reason: 'invalid-text' });
  return within;
}

function fullError(bound: 'members' | 'stored'): SmurgError {
  return new SmurgError('conflict', msg('sticky.feedback.full'), { reason: 'feedback-full', bound });
}
