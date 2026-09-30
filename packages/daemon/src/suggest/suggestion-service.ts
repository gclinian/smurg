// SuggestionService (SPEC R6, D2; ARCHITECTURE §5.6). Anyone who may suggest (editor, runner, host) proposes text for
// SOMEONE ELSE's session; only that session's owner can accept it (optionally edited: accepted-modified) or reject it.
//
// THE INVARIANT (R6.1): before the owner accepts, not one byte of a suggestion reaches the session. The text lives
// in this service and in suggestions.json, nowhere near a PTY. There is exactly one call of
// SessionManager.pasteSuggestion() in the whole daemon: in accept() below, after the ownership and pending checks,
// with the sanitised text (sanitize.ts). There is no auto-accept path and no setting for one.
//
// R6.3: every step is audited with the author, the content (`text` / `finalText` are kept whole through
// AuditInput.fullText), the outcome and the time.
import {
  LIST_MAX_ITEMS,
  SmurgError,
  can,
  suggestionSourceSchema,
  suggestionTextSchema,
  type PayloadOf,
  type SessionInfo,
  type Suggestion,
} from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError } from '../core/errors.ts';
import type { MemberRecord, PersistentDocument, Principal, SuggestionService, UserId } from '../core/interfaces.ts';
import { DisposableStack, newId, type Disposable } from '../core/lifecycle.ts';
import { SYSTEM_ACTOR, isHostPrincipal, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import { sanitizeSuggestionForPaste } from './sanitize.ts';
import {
  SUGGESTIONS_DOCUMENT,
  initialSuggestionsDocument,
  suggestionsDocumentSchema,
  toSuggestion,
  type StoredSuggestion,
  type SuggestionsDocument,
} from './store.ts';

export interface SuggestionLimits {
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
  maxPendingPerAuthor: 20,
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
 * SEC-D-01: suggest.accept names the suggestion, not the text the owner reviewed, and the author may edit a pending
 * suggestion at any time. An accept that carries `text` pastes exactly that text (what the owner saw or typed); an
 * accept WITHOUT text within this long after an edit is refused (`conflict` / `suggestion-changed`): it may have been
 * clicked on the previous version, and the new one would be typed into the owner's session unseen.
 */
export const ACCEPT_AFTER_EDIT_MS = 10_000;

const NOT_FOUND = (): SmurgError => new SmurgError('not_found', '找不到這則建議', { reason: 'unknown-suggestion' });
const NOT_PENDING = (status: string): SmurgError => new SmurgError('conflict', '這則建議已經處理過了', { reason: 'not-pending', status });
const SESSION_ENDED_REASON = '這個 session 已結束';

function textChars(stored: StoredSuggestion): number {
  return stored.text.length + (stored.finalText?.length ?? 0);
}

/** Validates suggestion text again inside the service (fail closed even for a caller that skipped the router). */
function validText(text: unknown): string {
  const parsed = suggestionTextSchema.safeParse(text);
  if (!parsed.success) throw new SmurgError('bad_request', '建議內容不正確（不能是空白，也不能包含控制字元）', { reason: 'invalid-text' });
  return parsed.data;
}

export class SuggestionServiceImpl implements SuggestionService {
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

  /** Bus wiring: sessions that end, members who are kicked or lose the right to suggest. */
  attach(): Disposable {
    const stack = new DisposableStack();
    const bus = this.ctx.bus;
    stack.add(
      bus.on('session.exited', (event) => {
        for (const item of this.stored()) if (item.status === 'pending' && item.sessionId === event.session.id) this.closeBySystem(item.id, 'rejected', 'session-ended');
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

  async create(input: PayloadOf<'suggest.create'>, principal: Principal): Promise<Suggestion> {
    const author = this.memberOf(principal);
    if (!principalCan(principal, 'suggest.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const text = validText(input.text);
    let source: StoredSuggestion['source'];
    if (input.source !== undefined) {
      const parsed = suggestionSourceSchema.safeParse(input.source);
      if (!parsed.success) throw new SmurgError('bad_request', undefined, { reason: 'invalid-source' });
      source = parsed.data;
    }
    const session = this.requireRunningSession(input.sessionId);
    // target-session-not-own: your own session takes your own keystrokes; suggestions are for someone else's agent.
    if (session.ownerUserId === author.userId) {
      throw new AuthorizationError('不能對自己的 session 提建議，請直接在自己的 session 輸入', { reason: 'target-session-not-own' });
    }
    this.checkPendingBudget({ authorUserId: author.userId, sessionId: session.id, addChars: text.length, removeChars: 0 });
    const stored: StoredSuggestion = {
      id: newId('sug'),
      sessionId: session.id,
      author: { userId: author.userId, displayName: author.displayName },
      text,
      ...(source !== undefined ? { source } : {}),
      status: 'pending',
      createdAt: this.ctx.clock.now(),
      sessionOwnerUserId: session.ownerUserId,
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
        ...(source !== undefined ? { source: { root: source.file.root, path: source.file.path, startLine: source.startLine, endLine: source.endLine } } : {}),
      },
      fullText: ['text'],
    });
    this.publish(stored, null);
    await this.persist();
    return toSuggestion(stored);
  }

  async edit(input: PayloadOf<'suggest.edit'>, principal: Principal): Promise<Suggestion> {
    const stored = this.requireStored(input.suggestionId);
    this.requireAuthor(stored, principal);
    if (stored.status !== 'pending') throw NOT_PENDING(stored.status);
    if (!principalCan(principal, 'suggest.create')) throw new AuthorizationError(undefined, { reason: 'capability' });
    const text = validText(input.text);
    this.checkPendingBudget({ authorUserId: stored.author.userId, sessionId: stored.sessionId, addChars: text.length, removeChars: stored.text.length, editing: true });
    const editedAt = this.ctx.clock.now();
    const updated = this.update(stored.id, (draft) => {
      draft.text = text;
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
    if (stored.status !== 'pending') throw NOT_PENDING(stored.status);
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
    // suggestion-session-owner: nobody but the session's owner, and only while the suggestion is pending.
    this.requireSessionOwner(stored, principal);
    if (stored.status !== 'pending') throw NOT_PENDING(stored.status);
    const session = this.requireRunningSession(stored.sessionId);
    if (session.ownerUserId !== principal.userId) throw new AuthorizationError(undefined, { reason: 'not-owner:session' });
    // `text` is what the owner saw (or typed): exactly that is pasted. Equal to the current text, it is a plain accept.
    const modified = input.text !== undefined && input.text !== stored.text;
    if (input.text === undefined && stored.editedAt !== undefined && this.ctx.clock.now() - stored.editedAt < this.acceptAfterEditMs) {
      this.ctx.audit.record({
        actor: principal.actor,
        action: 'suggest.accept',
        outcome: 'denied',
        target: stored.id,
        detail: { suggestionId: stored.id, sessionId: stored.sessionId, reason: 'suggestion-changed', editedAt: stored.editedAt },
      });
      throw new SmurgError('conflict', '提出者剛修改了這則建議，請確認新的內容後再採用', { reason: 'suggestion-changed', suggestionId: stored.id, editedAt: stored.editedAt });
    }
    const finalText = sanitizeSuggestionForPaste(validText(input.text ?? stored.text));
    // From here to the state update nothing awaits: a second accept of the same suggestion cannot interleave.
    // THE ONLY PATH OF SUGGESTION TEXT INTO A PTY (bracketed paste + Enter, as the owner).
    try {
      this.ctx.services.sessions.pasteSuggestion(stored.sessionId, finalText, principal);
    } catch (err) {
      if (!(err instanceof AuthorizationError)) {
        this.ctx.audit.record({
          actor: principal.actor,
          action: 'suggest.accept',
          outcome: 'error',
          target: stored.id,
          detail: { suggestionId: stored.id, sessionId: stored.sessionId, reason: err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.code) : 'paste-failed' },
        });
      }
      throw err;
    }
    const updated = this.update(stored.id, (draft) => {
      draft.status = modified ? 'accepted-modified' : 'accepted';
      draft.resolvedAt = this.ctx.clock.now();
      draft.finalText = finalText;
    });
    this.auditOutcome(principal.actor, 'suggest.accept', updated, {});
    this.publish(updated, stored);
    await this.persist();
    return toSuggestion(updated);
  }

  async reject(input: PayloadOf<'suggest.reject'>, principal: Principal): Promise<Suggestion> {
    const stored = this.requireStored(input.suggestionId);
    this.requireSessionOwner(stored, principal);
    if (stored.status !== 'pending') throw NOT_PENDING(stored.status);
    const updated = this.update(stored.id, (draft) => {
      draft.status = 'rejected';
      draft.resolvedAt = this.ctx.clock.now();
      if (input.reason !== undefined && input.reason.length > 0) draft.rejectReason = input.reason;
    });
    this.auditOutcome(principal.actor, 'suggest.reject', updated, {});
    this.publish(updated, stored);
    await this.persist();
    return toSuggestion(updated);
  }

  /** Suggestions the caller is a party of (author, session owner; the host sees all), newest first. */
  list(input: PayloadOf<'suggest.list'>, principal: Principal): Suggestion[] {
    const host = isHostPrincipal(principal);
    const userId = principal.userId;
    return this.stored()
      .filter((item) => input.sessionId === undefined || item.sessionId === input.sessionId)
      .filter((item) => host || (userId !== null && (item.author.userId === userId || item.sessionOwnerUserId === userId)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, LIST_MAX_ITEMS)
      .map(toSuggestion);
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

  /** A suggestion closed by the daemon itself (its session ended, its author was kicked or demoted). */
  private closeBySystem(id: string, status: 'rejected' | 'withdrawn', reason: 'session-ended' | 'author-kicked' | 'author-demoted'): void {
    const before = this.stored().find((item) => item.id === id);
    if (!before || before.status !== 'pending') return;
    const updated = this.update(id, (draft) => {
      draft.status = status;
      draft.resolvedAt = this.ctx.clock.now();
      if (status === 'rejected') draft.rejectReason = SESSION_ENDED_REASON;
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

  /** suggest.updated to the session owner, the author and the host (recipients:suggestion-parties). */
  private publish(item: StoredSuggestion, previous: StoredSuggestion | null): void {
    const suggestion = toSuggestion(item);
    this.ctx.bus.emit('suggestion.changed', { suggestion, previous: previous ? toSuggestion(previous) : null });
    const parties = new Set<UserId>([item.sessionOwnerUserId, item.author.userId, this.ctx.members.hostUserId()]);
    for (const userId of parties) this.ctx.hub.sendToUser(userId, 'suggest.updated', { suggestion });
  }

  private checkPendingBudget(input: { readonly authorUserId: UserId; readonly sessionId: string; readonly addChars: number; readonly removeChars: number; readonly editing?: boolean }): void {
    const pending = this.stored().filter((item) => item.status === 'pending');
    const extra = input.editing ? 0 : 1;
    if (pending.length + extra > this.limits.maxPendingTotal) throw this.queueFull('queue');
    if (pending.filter((item) => item.author.userId === input.authorUserId).length + extra > this.limits.maxPendingPerAuthor) throw this.queueFull('author');
    if (pending.filter((item) => item.sessionId === input.sessionId).length + extra > this.limits.maxPendingPerSession) throw this.queueFull('session');
    const chars = pending.reduce((sum, item) => sum + item.text.length, 0) - input.removeChars + input.addChars;
    if (chars > this.limits.maxPendingChars) throw this.queueFull('size');
  }

  private queueFull(which: 'queue' | 'author' | 'session' | 'size'): SmurgError {
    return new SmurgError('too_large', '待處理的建議太多了，請等擁有者處理後再提出', { reason: 'suggestion-queue-full', limit: which });
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

  private requireSessionOwner(stored: StoredSuggestion, principal: Principal): void {
    if (principal.userId === null || principal.userId !== stored.sessionOwnerUserId) {
      throw new AuthorizationError('只有 session 的擁有者可以處理這則建議', { reason: 'not-owner:session' });
    }
  }

  private requireAuthor(stored: StoredSuggestion, principal: Principal): void {
    if (principal.userId === null || principal.userId !== stored.author.userId) {
      throw new AuthorizationError('只有提出者可以修改或撤回這則建議', { reason: 'not-author:suggestion' });
    }
  }

  private requireRunningSession(sessionId: string): SessionInfo {
    const session = this.ctx.services.sessions.get(sessionId);
    if (!session) throw new SmurgError('not_found', '找不到這個 session', { reason: 'unknown-session' });
    if (session.status === 'exited') throw new SmurgError('conflict', SESSION_ENDED_REASON, { reason: 'session-ended' });
    return session;
  }

  private sessionRunning(sessionId: string): boolean {
    const session = this.ctx.services.sessions.get(sessionId);
    return session !== null && session.status !== 'exited';
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
   * suggestion is already in the PTY, which no error could undo.
   */
  private async persist(): Promise<void> {
    try {
      await this.requireDoc().flush();
    } catch (err) {
      this.ctx.log.error('suggestions.json write failed', { module: 'suggest', error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private requireDoc(): PersistentDocument<SuggestionsDocument> {
    if (!this.doc) throw new SmurgError('internal', '建議功能尚未就緒', { reason: 'not-started' });
    return this.doc;
  }
}
