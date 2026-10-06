// TEST ONLY. In-memory InboxService: stored notes (mentions, results) are real and kept apart from the derived items,
// which are whatever a test puts with `setItems`. It derives nothing: the real derivation is the inbox module's own
// subject.
import { INBOX_NOTES_PER_MEMBER_MAX, SmurgError, takeListPage, type Actor, type ColumnTarget, type InboxItem } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { InboxService, Principal, Req, Res, UserId } from '../interfaces.ts';
import { CallLog, fakeId, type FakeEnv } from './env.ts';

export class FakeInboxService implements InboxService {
  readonly log = new CallLog();
  /** Every stored mention, as it was asked for. */
  readonly mentions: { userId: UserId; from: Actor; target: ColumnTarget; anchor?: { cardId?: string; seq?: number }; excerpt: string }[] = [];
  /** Every stored result. */
  readonly results: { userId: UserId; from: Actor; suggestionId: string; sessionId: string; outcome: 'rejected' | 'accepted-edited'; excerpt: string }[] = [];
  /** Members whose stored notes are full: `addMention` answers 'full' for them. */
  readonly full = new Set<UserId>();
  private readonly env: FakeEnv;
  /** Derived items (what `setItems` put) and stored notes (mentions, results), per member. */
  private readonly derived = new Map<UserId, Map<string, InboxItem>>();
  private readonly notes = new Map<UserId, Map<string, InboxItem>>();

  constructor(env: FakeEnv) {
    this.env = env;
  }

  /**
   * Replaces a member's DERIVED items (stored mentions and results stay) and tells their channels (`inbox.changed`)
   * when a hub is there.
   */
  setItems(userId: UserId, items: readonly InboxItem[]): void {
    const before = this.box(this.derived, userId);
    const next = new Map(items.map((item) => [item.key, item] as const));
    const remove = [...before.keys()].filter((key) => !next.has(key));
    this.derived.set(userId, next);
    this.env.hub?.sendToUser(userId, 'inbox.changed', { upsert: [...items], remove });
  }

  list(principal: Principal, input: Req<'inbox.list'> = {}): Res<'inbox.list'> {
    const page = takeListPage(this.itemsOf(principal.userId ?? ''), input.after, (item) => item.key);
    return { items: page.items, hasMore: page.hasMore };
  }

  seen(principal: Principal, keys: readonly string[]): void {
    this.log.record('seen', principal, keys);
    const userId = principal.userId ?? '';
    for (const key of keys) {
      // Opening a mention or a result removes it; anything else is only read.
      if (this.box(this.notes, userId).delete(key)) continue;
      const item = this.box(this.derived, userId).get(key);
      if (item) this.box(this.derived, userId).set(key, { ...item, unread: false });
    }
  }

  dismiss(principal: Principal, key: string): void {
    this.log.record('dismiss', principal, key);
    const userId = principal.userId ?? '';
    if (this.box(this.notes, userId).delete(key)) return;
    if (!this.box(this.derived, userId).has(key)) throw new SmurgError('not_found', msg('inbox.itemGone'));
    throw new SmurgError('conflict', msg('inbox.notDismissable'), { reason: 'not-dismissable' });
  }

  addMention(input: { readonly userId: UserId; readonly from: Actor; readonly target: ColumnTarget; readonly anchor?: { readonly cardId?: string; readonly seq?: number }; readonly excerpt: string }): 'stored' | 'full' {
    this.log.record('addMention', input);
    const box = this.box(this.notes, input.userId);
    if (this.full.has(input.userId) || box.size >= INBOX_NOTES_PER_MEMBER_MAX) return 'full';
    this.mentions.push({ ...input });
    const key = `mention:${fakeId('nt')}`;
    const sessionId = input.target.kind === 'session' ? input.target.sessionId : undefined;
    box.set(key, {
      key,
      kind: 'mention',
      at: this.env.clock.now(),
      unread: true,
      waiting: false,
      ...(sessionId === undefined ? {} : { sessionId }),
      target: input.target,
      from: input.from,
      excerpt: input.excerpt,
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
    });
    return 'stored';
  }

  addResult(input: { readonly userId: UserId; readonly from: Actor; readonly suggestionId: string; readonly sessionId: string; readonly outcome: 'rejected' | 'accepted-edited'; readonly excerpt: string }): void {
    this.log.record('addResult', input);
    this.results.push({ ...input });
    const key = `result:${fakeId('nt')}`;
    this.box(this.notes, input.userId).set(key, {
      key,
      kind: 'result',
      at: this.env.clock.now(),
      unread: true,
      waiting: false,
      sessionId: input.sessionId,
      target: { kind: 'session', sessionId: input.sessionId },
      anchor: { cardId: input.suggestionId },
      from: input.from,
      excerpt: input.excerpt,
      result: input.outcome,
    });
  }

  /** The member's derived items, then their stored notes. */
  itemsOf(userId: UserId): InboxItem[] {
    return [...this.box(this.derived, userId).values(), ...this.box(this.notes, userId).values()].map((item) => structuredClone(item));
  }

  private box(of: Map<UserId, Map<string, InboxItem>>, userId: UserId): Map<string, InboxItem> {
    let box = of.get(userId);
    if (!box) {
      box = new Map();
      of.set(userId, box);
    }
    return box;
  }
}
