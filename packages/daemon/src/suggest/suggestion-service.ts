// SuggestionService (SPEC R6, D2; ARCHITECTURE §5.6, §11 D-15). Anyone who may suggest (editor, Agent access, host)
// proposes text for an AGENT session (never a terminal); a member who may drive sessions (`session.drive`: the host,
// Agent access) accepts it (optionally edited: accepted-modified) or rejects it, on any agent session.
//
// THE INVARIANT (R6.1): before such a member accepts, not one byte of a suggestion reaches the agent. The text lives
// in this service and in suggestions.json. There is exactly one call of AgentSessions.send() in this module: in
// accept() below, after the capability and pending checks. There is no auto-accept path and no setting for one.
//
// Text a person wrote is cleaned once, here, with the shared agentText() (invisible characters and controls removed,
// header-like lines quoted): what is stored, shown on the card and sent is the same string.
//
// R6.3: every step is audited with the author, the content (`text` / `finalText` are kept whole through
// AuditInput.fullText), the outcome and the time.
//
// A suggestion is a CARD of the session's conversation (a `card` event where it appeared; the entity in
// session.watch / history / cards.get and in `suggest.updated`): every member who can read the conversation reads it.
// `suggest.updated` goes to the watchers of the session, to the author and to the members whose inbox holds it
// (routing.ts `suggestionRecipients`). What the author learns of a decision: the card's new state, and for a
// rejection or an edited accept a stored `result` in their inbox (InboxService.addResult).
import {
  LIST_MAX_ITEMS,
  SUGGESTIONS_PENDING_PER_AUTHOR_MAX,
  SmurgError,
  can,
  SUGGESTION_TEXT_MAX_CHARS,
  agentTextWithin,
  settledError,
  suggestionRecipients,
  suggestionSourceSchema,
  suggestionTextSchema,
  type PayloadOf,
  type ResultInputOf,
  type Suggestion,
  isSessionOver,
  takeListPage,
  takeWithinBytes,
  type AgentSession,
  type CardRef,
  type MessageOrigin,
  type SessionEndReason,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { MemberRecord, PersistentDocument, Principal, SuggestionService, UserId } from '../core/interfaces.ts';
import { DisposableStack, newId, type Disposable } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
// The one mention rule of every request that carries `mentions` (a pure helper of the conversation module).
import { clipExcerpt, keptMentions, storeMentions, takeMentionTokens } from '../conversation/mentions.ts';
import {
  SUGGESTIONS_DOCUMENT,
  initialSuggestionsDocument,
  suggestionsDocumentSchema,
  toSuggestion,
  type StoredSuggestion,
  type SuggestionsDocument,
} from './store.ts';

export interface SuggestionLimits {
  /** Pending suggestions of one author in one session (`suggest.tooManyPending`); the wire's constant. */
  readonly maxPendingPerAuthorAndSession: number;
  /** Pending suggestions of one author in all sessions together. */
  readonly maxPendingPerAuthor: number;
  readonly maxPendingPerSession: number;
  readonly maxPendingTotal: number;
  /** Characters of all pending suggestions together (each is at most SUGGESTION_TEXT_MAX_CHARS). */
  readonly maxPendingChars: number;
  /** Decided suggestions kept in suggestions.json (the audit log keeps every one, with its text). */
  readonly maxResolved: number;
  /**
   * Characters of everything kept. suggestions.json is validated and rewritten whole on every change, so its size is
   * bounded to keep that work small on the daemon's event loop (§0 rule 5); decided ones go first.
   */
  readonly maxStoredChars: number;
}

export const DEFAULT_SUGGESTION_LIMITS: SuggestionLimits = Object.freeze({
  maxPendingPerAuthorAndSession: SUGGESTIONS_PENDING_PER_AUTHOR_MAX,
  maxPendingPerAuthor: 100,
  maxPendingPerSession: 50,
  maxPendingTotal: 200,
  maxPendingChars: 1_048_576,
  maxResolved: 200,
  maxStoredChars: 2_097_152,
});

export interface SuggestionModuleOptions {
  readonly limits?: Partial<SuggestionLimits>;
  /** How long after an edit a plain accept (one that does not say which text it accepts) is refused. */
  readonly acceptAfterEditMs?: number;
}

/**
 * suggest.accept names the suggestion, not the text the member reviewed, and the author may edit a pending
 * suggestion at any time. An accept that carries `text` sends exactly that text (what the member saw or typed); an
 * accept WITHOUT text within this long after an edit is refused (`conflict` / `suggestion-changed`): it may have been
 * clicked on the previous version, and the new one would reach the agent unseen.
 */
export const ACCEPT_AFTER_EDIT_MS = 10_000;

const NOT_FOUND = (): SmurgError => new SmurgError('not_found', msg('suggest.notFound'), { reason: 'unknown-suggestion' });
/** The refusal every late edit, withdrawal, accept and reject gets: which card, how it ended, who did it (never the card). */
const NOT_PENDING = (item: Pick<StoredSuggestion, 'id' | 'sessionId' | 'status' | 'decidedBy'>): SmurgError =>
  settledError(
    { card: { kind: 'suggestion', id: item.id }, sessionId: item.sessionId, status: item.status === 'pending' ? 'accepted' : item.status, ...(item.decidedBy === undefined ? {} : { by: item.decidedBy }) },
    msg('suggest.notPending'),
  );

/** Why the daemon closes the pending suggestions of a session that ended. */
function closedReasonOf(reason: SessionEndReason): 'session-ended' | 'topic-archived' {
  return reason === 'archived' ? 'topic-archived' : 'session-ended';
}

function textChars(stored: StoredSuggestion): number {
  return stored.text.length + (stored.finalText?.length ?? 0);
}

/**
 * Validates suggestion text again inside the service (fail closed even for a caller that skipped the router) and
 * cleans it for an agent: the one place a suggestion's text passes agentText().
 */
function cleanText(text: unknown): { readonly text: string; readonly cleaned: boolean } {
  const parsed = suggestionTextSchema.safeParse(text);
  if (!parsed.success) throw new SmurgError('bad_request', msg('suggest.invalidText'), { reason: 'invalid-text' });
  const within = agentTextWithin(parsed.data, SUGGESTION_TEXT_MAX_CHARS);
  if (!within.ok) throw new SmurgError('bad_request', msg('suggest.invalidText'), { reason: 'invalid-text' });
  return within;
}

export class SuggestionServiceImpl implements SuggestionService {
  /** Suggestions whose accept is on its way to the agent (a second accept must not send the text twice). */
  private readonly accepting = new Set<string>();
  private readonly ctx: DaemonContext;
  readonly limits: SuggestionLimits;
  private readonly acceptAfterEditMs: number;
  private doc: PersistentDocument<SuggestionsDocument> | null = null;

  constructor(ctx: DaemonContext, options: SuggestionModuleOptions = {}) {
    this.ctx = ctx;
    this.limits = Object.freeze({ ...DEFAULT_SUGGESTION_LIMITS, ...options.limits });
    this.acceptAfterEditMs = options.acceptAfterEditMs ?? ACCEPT_AFTER_EDIT_MS;
  }

  // =================================================================================================================
  // Lifecycle
  // =================================================================================================================

  /** Opens suggestions.json, then closes pending suggestions whose session is gone (sessions end with the daemon). */
  async start(): Promise<void> {
    this.doc = await this.ctx.state.document(SUGGESTIONS_DOCUMENT, suggestionsDocumentSchema, initialSuggestionsDocument);
    const sessions = this.ctx.services.sessions;
    if (isStubService(sessions)) return;
    const orphaned = this.doc
      .get()
      .suggestions.filter((item) => item.status === 'pending' && !this.sessionRunning(item.sessionId))
      .map((item) => item.id);
    for (const id of orphaned) this.closeBySystem(id, 'rejected', 'session-ended');
    await this.doc.flush();
  }

  async stop(): Promise<void> {
    await this.doc?.flush().catch(() => {});
  }

  /** Bus wiring: sessions that end, topics that are archived or deleted, members who are kicked or lose the right to suggest. */
  attach(): Disposable {
    const stack = new DisposableStack();
    const bus = this.ctx.bus;
    stack.add(
      bus.on('session.exited', (event) => {
        // Archiving a topic ends its sessions with the reason `archived`: the card then says so.
        const reason = closedReasonOf(event.reason);
        for (const item of this.stored()) if (item.status === 'pending' && item.sessionId === event.session.id) this.closeBySystem(item.id, 'rejected', reason);
      }),
    );
    stack.add(
      bus.on('topic.removed', (event) => {
        // The topic was deleted: the suggestions of its sessions go with their conversations (before the transcripts do).
        const gone = new Set(event.sessionIds);
        if (this.doc === null || !this.stored().some((item) => gone.has(item.sessionId))) return;
        this.doc.update((draft) => {
          draft.suggestions = draft.suggestions.filter((item) => !gone.has(item.sessionId));
        });
        void this.persist();
      }),
    );
    stack.add(
      bus.on('member.kicked', (event) => {
        for (const item of this.stored()) if (item.status === 'pending' && item.author.userId === event.userId) this.closeBySystem(item.id, 'withdrawn', 'author-kicked');
      }),
    );
    stack.add(
      bus.on('member.role-changed', (event) => {
        if (can(event.to, 'suggest.create')) return;
        for (const item of this.stored()) if (item.status === 'pending' && item.author.userId === event.userId) this.closeBySystem(item.id, 'withdrawn', 'author-demoted');
      }),
    );
    return stack;
  }

  // =================================================================================================================
  // SuggestionService
  // =================================================================================================================

  async create(input: PayloadOf<'suggest.create'> & { readonly origin?: MessageOrigin; readonly topicId?: string; readonly itemId?: string; readonly cleaned?: boolean }, principal: Principal): Promise<Suggestion> {
    const author = this.memberOf(principal);
    if (!principalCan(principal, 'suggest.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const own = cleanText(input.text);
    const text = own.text;
    // `input.cleaned`: the caller (ConversationService.sendAs) composed and cleaned the text already and something went.
    const cleaned = own.cleaned || input.cleaned === true;
    let source: StoredSuggestion['source'];
    if (input.source !== undefined) {
      const parsed = suggestionSourceSchema.safeParse(input.source);
      if (!parsed.success) throw new SmurgError('bad_request', undefined, { reason: 'invalid-source' });
      source = parsed.data;
    }
    // agent-session: suggestions go to agent sessions, the author's own included (what matters is who may drive).
    const session = this.requireRunningSession(input.sessionId);
    this.checkPendingBudget({ authorUserId: author.userId, sessionId: session.id, addChars: text.length, removeChars: 0 });
    // mentions-checked: only active members the text names count; one `mention` token each, before anything is stored.
    const mentioned = keptMentions(this.ctx, text, input.mentions, author.userId);
    takeMentionTokens(this.ctx, author.userId, mentioned.length);
    const stored: StoredSuggestion = {
      id: newId('sug'),
      sessionId: session.id,
      author: { userId: author.userId, displayName: author.displayName },
      text,
      ...(cleaned ? { cleaned: true as const } : {}),
      origin: input.origin ?? (source !== undefined ? 'selection' : 'composer'),
      ...(input.topicId !== undefined ? { topicId: input.topicId } : session.topicId !== undefined ? { topicId: session.topicId } : {}),
      ...(input.itemId !== undefined ? { itemId: input.itemId } : session.itemId !== undefined ? { itemId: session.itemId } : {}),
      ...(mentioned.length > 0 ? { mentions: mentioned.map((member) => member.userId) } : {}),
      ...(source !== undefined ? { source } : {}),
      status: 'pending',
      createdAt: this.ctx.clock.now(),
      sessionOwnerUserId: session.openedBy.userId,
    };
    this.requireDoc().update((draft) => {
      draft.suggestions.push(stored);
      this.prune(draft);
    });
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'suggest.create',
      outcome: 'ok',
      target: stored.id,
      detail: {
        suggestionId: stored.id,
        sessionId: stored.sessionId,
        sessionOwnerUserId: stored.sessionOwnerUserId,
        authorUserId: author.userId,
        authorName: author.displayName,
        text,
        createdAt: stored.createdAt,
        origin: stored.origin,
        ...(stored.topicId !== undefined ? { topicId: stored.topicId } : {}),
        ...(stored.itemId !== undefined ? { itemId: stored.itemId } : {}),
        ...(source !== undefined ? { source: { root: source.file.root, path: source.file.path, startLine: source.startLine, endLine: source.endLine } } : {}),
      },
      fullText: ['text'],
    });
    // Where the card appeared in the conversation, then the card itself.
    this.appendCard(stored);
    this.publish(stored, null);
    storeMentions(this.ctx, { from: principal, kept: mentioned, target: { kind: 'session', sessionId: stored.sessionId }, anchor: { cardId: stored.id }, text });
    await this.persist();
    return toSuggestion(stored);
  }

  async edit(input: PayloadOf<'suggest.edit'>, principal: Principal): Promise<Suggestion> {
    const stored = this.requireStored(input.suggestionId);
    this.requireAuthor(stored, principal);
    if (stored.status !== 'pending') throw NOT_PENDING(stored);
    if (!principalCan(principal, 'suggest.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const { text, cleaned } = cleanText(input.text);
    this.checkPendingBudget({ authorUserId: stored.author.userId, sessionId: stored.sessionId, addChars: text.length, removeChars: stored.text.length, editing: true });
    const editedAt = this.ctx.clock.now();
    const updated = this.update(stored.id, (draft) => {
      draft.text = text;
      if (cleaned) draft.cleaned = true;
      else delete draft.cleaned;
      draft.editedAt = editedAt;
    });
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'suggest.edit',
      outcome: 'ok',
      target: stored.id,
      detail: { suggestionId: stored.id, sessionId: stored.sessionId, authorUserId: stored.author.userId, text, editedAt },
      fullText: ['text'],
    });
    this.publish(updated, stored);
    await this.persist();
    return toSuggestion(updated);
  }

  async withdraw(input: PayloadOf<'suggest.withdraw'>, principal: Principal): Promise<Suggestion> {
    const stored = this.requireStored(input.suggestionId);
    this.requireAuthor(stored, principal);
    if (stored.status !== 'pending') throw NOT_PENDING(stored);
    const updated = this.update(stored.id, (draft) => {
      draft.status = 'withdrawn';
      draft.resolvedAt = this.ctx.clock.now();
    });
    this.auditOutcome(principal.actor, 'suggest.withdraw', updated, {});
    this.publish(updated, stored);
    await this.persist();
    return toSuggestion(updated);
  }

  async accept(input: PayloadOf<'suggest.accept'>, principal: Principal): Promise<Suggestion> {
    const stored = this.requireStored(input.suggestionId);
    // session.drive (any session), and only while the suggestion is pending.
    this.requireDriver(principal);
    if (stored.status !== 'pending') throw NOT_PENDING(stored);
    this.requireRunningSession(stored.sessionId);
    // `text` is what the member saw (or typed): exactly that is sent. Equal to the current text, it is a plain accept.
    const accepted = input.text === undefined ? { text: stored.text, cleaned: false } : cleanText(input.text);
    const modified = accepted.text !== stored.text;
    if (input.text === undefined && stored.editedAt !== undefined && this.ctx.clock.now() - stored.editedAt < this.acceptAfterEditMs) {
      this.ctx.audit.record({
        actor: principal.actor,
        action: 'suggest.accept',
        outcome: 'denied',
        target: stored.id,
        detail: { suggestionId: stored.id, sessionId: stored.sessionId, reason: 'suggestion-changed', editedAt: stored.editedAt },
      });
      throw new SmurgError('conflict', msg('suggest.changed'), { reason: 'suggestion-changed', suggestionId: stored.id, editedAt: stored.editedAt });
    }
    const finalText = accepted.text;
    if (this.accepting.has(stored.id)) throw NOT_PENDING(stored);
    this.accepting.add(stored.id);
    // THE ONLY PATH OF SUGGESTION TEXT TO AN AGENT: a message of its author, under a header that names who accepted it.
    try {
      const author = this.ctx.members.principalOf(stored.author.userId) ?? { kind: 'user' as const, actor: { kind: 'user' as const, ...stored.author }, userId: stored.author.userId, role: 'editor' as const };
      await this.ctx.services.agents.send(stored.sessionId, {
        kind: 'person',
        from: author,
        text: finalText,
        cleaned: stored.cleaned === true || accepted.cleaned,
        origin: stored.origin,
        suggestion: { id: stored.id, acceptedBy: { userId: principal.userId ?? stored.author.userId, displayName: principal.actor.kind === 'user' ? principal.actor.displayName : stored.author.displayName }, modified },
      });
    } catch (err) {
      this.accepting.delete(stored.id);
      if (!(err instanceof AuthorizationError)) {
        this.ctx.audit.record({
          actor: principal.actor,
          action: 'suggest.accept',
          outcome: 'error',
          target: stored.id,
          detail: { suggestionId: stored.id, sessionId: stored.sessionId, reason: err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.code) : 'send-failed' },
        });
      }
      throw err;
    }
    this.accepting.delete(stored.id);
    const updated = this.update(stored.id, (draft) => {
      draft.status = modified ? 'accepted-modified' : 'accepted';
      draft.resolvedAt = this.ctx.clock.now();
      draft.finalText = finalText;
      if (principal.actor.kind === 'user') draft.decidedBy = { userId: principal.actor.userId, displayName: principal.actor.displayName };
    });
    this.auditOutcome(principal.actor, 'suggest.accept', updated, {});
    this.publish(updated, stored);
    if (modified) this.tellAuthor(updated, principal, 'accepted-edited');
    await this.persist();
    return toSuggestion(updated);
  }

  async reject(input: PayloadOf<'suggest.reject'>, principal: Principal): Promise<Suggestion> {
    const stored = this.requireStored(input.suggestionId);
    this.requireDriver(principal);
    if (stored.status !== 'pending') throw NOT_PENDING(stored);
    const updated = this.update(stored.id, (draft) => {
      draft.status = 'rejected';
      draft.resolvedAt = this.ctx.clock.now();
      if (principal.actor.kind === 'user') draft.decidedBy = { userId: principal.actor.userId, displayName: principal.actor.displayName };
      if (input.reason !== undefined && input.reason.length > 0) draft.rejectReason = input.reason;
    });
    this.auditOutcome(principal.actor, 'suggest.reject', updated, {});
    this.publish(updated, stored);
    this.tellAuthor(updated, principal, 'rejected');
    await this.persist();
    return toSuggestion(updated);
  }

  /**
   * Every suggestion the daemon keeps (of one session with `sessionId`): a suggestion is a card of its session's
   * conversation, which every member holding `session.view` reads. Newest first; one page of THE list rule after
   * `input.after`.
   */
  list(input: PayloadOf<'suggest.list'>, principal: Principal): ResultInputOf<'suggest.list'> {
    if (!principalCan(principal, 'session.view')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const all = this.stored()
      .filter((item) => input.sessionId === undefined || item.sessionId === input.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toSuggestion);
    const page = takeListPage(all, input.after, (item) => item.id);
    return { suggestions: page.items, hasMore: page.hasMore };
  }

  pending(): Suggestion[] {
    return this.stored()
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, LIST_MAX_ITEMS)
      .map(toSuggestion);
  }

  /** The owner of a suggestion's session and its author (handlers audit ownership refusals with them). */
  parties(suggestionId: string): { readonly sessionOwnerUserId: UserId; readonly authorUserId: UserId } | null {
    const item = this.stored().find((entry) => entry.id === suggestionId);
    return item ? { sessionOwnerUserId: item.sessionOwnerUserId, authorUserId: item.author.userId } : null;
  }

  // =================================================================================================================
  // Internals
  // =================================================================================================================

  /** A suggestion closed by the daemon itself (its session ended, its topic was archived, its author was kicked or demoted). */
  private closeBySystem(id: string, status: 'rejected' | 'withdrawn', reason: NonNullable<StoredSuggestion['closedReason']>): void {
    const before = this.stored().find((item) => item.id === id);
    if (!before || before.status !== 'pending') return;
    const updated = this.update(id, (draft) => {
      draft.status = status;
      draft.resolvedAt = this.ctx.clock.now();
      // Nobody decided it: the reason is a code each client words itself (`rejectReason` is only a person's words).
      draft.closedReason = reason;
    });
    void this.persist();
    this.auditOutcome(SYSTEM_ACTOR, status === 'rejected' ? 'suggest.reject' : 'suggest.withdraw', updated, { reason });
    this.publish(updated, before);
  }

  private auditOutcome(actor: Principal['actor'], action: 'suggest.accept' | 'suggest.reject' | 'suggest.withdraw', item: StoredSuggestion, extra: Record<string, unknown>): void {
    this.ctx.audit.record({
      actor,
      action,
      outcome: 'ok',
      target: item.id,
      detail: {
        suggestionId: item.id,
        sessionId: item.sessionId,
        sessionOwnerUserId: item.sessionOwnerUserId,
        authorUserId: item.author.userId,
        authorName: item.author.displayName,
        outcome: item.status,
        ...(item.topicId !== undefined ? { topicId: item.topicId } : {}),
        ...(item.itemId !== undefined ? { itemId: item.itemId } : {}),
        text: item.text,
        ...(item.finalText !== undefined ? { finalText: item.finalText } : {}),
        ...(item.rejectReason !== undefined ? { rejectReason: item.rejectReason } : {}),
        createdAt: item.createdAt,
        ...(item.resolvedAt !== undefined ? { resolvedAt: item.resolvedAt } : {}),
        ...extra,
      },
      fullText: ['text', 'finalText'],
    });
  }

  /**
   * suggest.updated (recipients:suggestion-parties): to the members who watch the session, to the author, and to the
   * members whose inbox holds it (routing.ts: the responsible person when they may drive, else the host and every
   * member with agent access). One message per channel of each of them.
   */
  private publish(item: StoredSuggestion, previous: StoredSuggestion | null): void {
    const suggestion = toSuggestion(item);
    this.ctx.bus.emit('suggestion.changed', { suggestion, previous: previous ? toSuggestion(previous) : null });
    const parties = new Set<UserId>([item.author.userId]);
    const agents = this.ctx.services.agents;
    let responsible: UserId | null = null;
    if (!isStubService(agents)) {
      try {
        for (const userId of agents.watchers(item.sessionId)) parties.add(userId);
        responsible = agents.get(item.sessionId)?.responsible?.userId ?? null;
      } catch {
        // The session is gone: the author and the members who may decide still learn of it.
      }
    }
    for (const userId of suggestionRecipients({ responsible }, this.ctx.members.routing())) parties.add(userId);
    for (const userId of parties) this.ctx.hub.sendToUser(userId, 'suggest.updated', { suggestion });
  }

  /** The `card` event: where the suggestion appeared in its session's conversation. */
  private appendCard(item: StoredSuggestion): void {
    try {
      this.ctx.services.agents.append(item.sessionId, { kind: 'card', card: 'suggestion', id: item.id });
    } catch (err) {
      this.ctx.log.error('the card event of a suggestion was not appended', { module: 'suggest', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /**
   * A person decided against the author's text as it was (rejected, or accepted after an edit): a stored result in
   * the author's inbox. A plain accept needs none (the card says it), and nobody tells themselves.
   */
  private tellAuthor(item: StoredSuggestion, by: Principal, outcome: 'rejected' | 'accepted-edited'): void {
    if (isStubService(this.ctx.services.inbox) || by.userId === item.author.userId) return;
    try {
      this.ctx.services.inbox.addResult({ userId: item.author.userId, from: by.actor, suggestionId: item.id, sessionId: item.sessionId, outcome, excerpt: clipExcerpt(item.text) });
    } catch (err) {
      this.ctx.log.error('storing the result of a suggestion failed', { module: 'suggest', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private checkPendingBudget(input: { readonly authorUserId: UserId; readonly sessionId: string; readonly addChars: number; readonly removeChars: number; readonly editing?: boolean }): void {
    const pending = this.stored().filter((item) => item.status === 'pending');
    const extra = input.editing ? 0 : 1;
    // suggestion-limit: what one author may have waiting in one session.
    const mineHere = pending.filter((item) => item.author.userId === input.authorUserId && item.sessionId === input.sessionId).length;
    if (mineHere + extra > this.limits.maxPendingPerAuthorAndSession) {
      throw new SmurgError('too_large', msg('suggest.tooManyPending', { max: this.limits.maxPendingPerAuthorAndSession }), { reason: 'too-many-pending' });
    }
    if (pending.length + extra > this.limits.maxPendingTotal) throw this.queueFull('queue');
    if (pending.filter((item) => item.author.userId === input.authorUserId).length + extra > this.limits.maxPendingPerAuthor) throw this.queueFull('author');
    if (pending.filter((item) => item.sessionId === input.sessionId).length + extra > this.limits.maxPendingPerSession) throw this.queueFull('session');
    const chars = pending.reduce((sum, item) => sum + item.text.length, 0) - input.removeChars + input.addChars;
    if (chars > this.limits.maxPendingChars) throw this.queueFull('size');
  }

  private queueFull(which: 'queue' | 'author' | 'session' | 'size'): SmurgError {
    return new SmurgError('too_large', msg('suggest.queueFull'), { reason: 'suggestion-queue-full', limit: which });
  }

  /** Keeps every pending suggestion; decided ones beyond the limits go, oldest decision first. */
  private prune(draft: SuggestionsDocument): void {
    const decided = draft.suggestions.filter((item) => item.status !== 'pending').sort((a, b) => (a.resolvedAt ?? a.createdAt) - (b.resolvedAt ?? b.createdAt));
    const drop = new Set<string>();
    let total = draft.suggestions.reduce((sum, item) => sum + textChars(item), 0);
    let count = decided.length;
    for (const item of decided) {
      if (count <= this.limits.maxResolved && total <= this.limits.maxStoredChars) break;
      drop.add(item.id);
      count -= 1;
      total -= textChars(item);
    }
    if (drop.size > 0) draft.suggestions = draft.suggestions.filter((item) => !drop.has(item.id));
  }

  private update(id: string, mutate: (draft: StoredSuggestion) => void): StoredSuggestion {
    this.requireDoc().update((draft) => {
      const item = draft.suggestions.find((entry) => entry.id === id);
      if (item) mutate(item);
      this.prune(draft);
    });
    const updated = this.stored().find((entry) => entry.id === id);
    if (!updated) throw NOT_FOUND();
    return updated;
  }

  /** session.drive (the host, Agent access): may decide suggestions on any session (§11 D-15). */
  private requireDriver(principal: Principal): void {
    if (principal.userId === null || !principalCan(principal, 'session.drive')) {
      throw new AuthorizationError(msg('suggest.decideNeedsDrive'), { reason: 'capability' });
    }
  }

  private requireAuthor(stored: StoredSuggestion, principal: Principal): void {
    if (principal.userId === null || principal.userId !== stored.author.userId) {
      throw new AuthorizationError(msg('suggest.authorOnly'), { reason: 'not-author:suggestion' });
    }
  }

  /**
   * session-open: an agent session (`suggest.terminal` for a terminal: its opener types into it) that has not ended
   * (`conflict`, reason `ended`) and whose topic is not archived (`archived`).
   */
  private requireRunningSession(sessionId: string): AgentSession {
    const session = this.ctx.services.sessions.get(sessionId);
    if (!session) throw new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' });
    if (session.kind !== 'agent') throw new SmurgError('bad_request', msg('suggest.terminal'), { reason: 'not-an-agent' });
    const topics = this.ctx.services.topics;
    const archived = session.endReason === 'archived' || (session.topicId !== undefined && !isStubService(topics) && topics.get(session.topicId)?.archived === true);
    if (archived) throw new SmurgError('conflict', msg('topic.archived'), { reason: 'archived' });
    if (isSessionOver(session)) throw new SmurgError('conflict', msg('suggest.sessionEnded'), { reason: 'ended' });
    return session;
  }

  private sessionRunning(sessionId: string): boolean {
    const session = this.ctx.services.sessions.get(sessionId);
    return session !== null && !isSessionOver(session);
  }

  /** The suggestion cards `refs` name, plus (with `includeOpen`) the pending ones of the session, by the page rule. */
  cards(sessionId: string, refs: readonly CardRef[], options: { readonly includeOpen: boolean; readonly budgetBytes: number; readonly atLeastOne?: boolean }): { readonly suggestions: Suggestion[]; readonly more: CardRef[]; readonly bytes: number } {
    const wanted = new Set(refs.filter((ref) => ref.kind === 'suggestion').map((ref) => ref.id));
    const candidates = this.stored()
      .filter((item) => item.sessionId === sessionId && (wanted.has(item.id) || (options.includeOpen && item.status === 'pending')))
      .map(toSuggestion);
    const page = takeWithinBytes(candidates, options.budgetBytes, options.atLeastOne === true ? { atLeastOne: true } : {});
    return { suggestions: page.taken, more: page.rest.map((suggestion) => ({ kind: 'suggestion' as const, id: suggestion.id })), bytes: page.bytes };
  }

  private memberOf(principal: Principal): MemberRecord {
    const member = principal.kind === 'user' && principal.userId !== null ? this.ctx.members.active(principal.userId) : null;
    if (!member) throw new AuthorizationError(undefined, { reason: 'not-a-member' });
    return member;
  }

  private requireStored(id: string): StoredSuggestion {
    const item = this.stored().find((entry) => entry.id === id);
    if (!item) throw NOT_FOUND();
    return item;
  }

  private stored(): readonly StoredSuggestion[] {
    return this.doc?.get().suggestions ?? [];
  }

  /**
   * Writes suggestions.json. Every change is audited and published BEFORE this runs, and a failed write is logged, not
   * thrown: the in-memory document stays authoritative (the next change rewrites the whole file), and an accepted
   * suggestion is already with the agent, which no error could undo.
   */
  private async persist(): Promise<void> {
    try {
      await this.requireDoc().flush();
    } catch (err) {
      this.ctx.log.error('suggestions.json write failed', { module: 'suggest', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private requireDoc(): PersistentDocument<SuggestionsDocument> {
    if (!this.doc) throw new SmurgError('internal', msg('suggest.notStarted'), { reason: 'not-started' });
    return this.doc;
  }
}
