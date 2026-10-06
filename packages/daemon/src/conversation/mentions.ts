// THE mention rule (ARCHITECTURE §5.11; InboxService.addMention in core/interfaces.ts), for every request that carries
// `mentions`: `session.message.send`, `question.comment`, `suggest.create`, and `topic.revise` / `report.followUp`
// through ConversationService.sendAs. One implementation; the suggest module imports it (a pure helper, like the
// lock texts the locks module takes from hooks/).
//
//  - an id is KEPT only when that member is active and the text contains `@<their display name>`; any other id is
//    dropped without an error (the request succeeds; the stored entity lists only the kept ids);
//  - one `mention` token per kept id (`ctx.rates`), taken BEFORE anything is stored or sent: a sender without tokens
//    gets `rate_limited` and nothing happened;
//  - then one stored mention per kept id (InboxService.addMention). When the mentioned member's stored notes are full
//    the request still succeeds and the SENDER is told (`mention.inboxFull`); the inbox itself tells nobody.
import { INBOX_EXCERPT_MAX_CHARS, agentText, type ColumnTarget, type UserRef } from '@smurg/protocol';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { Principal, UserId } from '../core/interfaces.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';

/** Characters of the text kept in front of the mention in an excerpt. */
const EXCERPT_LEAD_CHARS = 80;
const ELLIPSIS = '…';

/** `@<display name>` as it reads in a text that went through agentText (the texts mentions are looked for in). */
function mentionOf(displayName: string): string {
  return `@${agentText(displayName).text}`;
}

/** The mentioned members that count, in the order the request named them. Never the sender. */
export function keptMentions(ctx: Pick<DaemonContext, 'members'>, text: string, ids: readonly UserId[] | undefined, senderUserId: UserId | null): UserRef[] {
  if (ids === undefined || ids.length === 0) return [];
  const kept: UserRef[] = [];
  const seen = new Set<string>();
  for (const userId of ids) {
    if (seen.has(userId) || userId === senderUserId) continue;
    seen.add(userId);
    const member = ctx.members.active(userId);
    if (member === null) continue;
    if (!text.includes(mentionOf(member.displayName))) continue;
    kept.push({ userId: member.userId, displayName: member.displayName });
  }
  return kept;
}

/** One `mention` token per kept id; throws `rate_limited` (the Router audits it) and takes nothing when they are not there. */
export function takeMentionTokens(ctx: Pick<DaemonContext, 'rates'>, senderUserId: UserId | null, count: number): void {
  if (count <= 0 || senderUserId === null) return;
  ctx.rates.require('mention', senderUserId, count);
}

function wellFormedSlice(text: string, from: number, to: number): string {
  let start = Math.max(0, from);
  let end = Math.min(text.length, to);
  // Never half of a surrogate pair at either end.
  if (start > 0 && start < text.length && /[\udc00-\udfff]/.test(text[start] as string) && /[\ud800-\udbff]/.test(text[start - 1] as string)) start += 1;
  if (end > start && end < text.length && /[\ud800-\udbff]/.test(text[end - 1] as string)) end -= 1;
  return text.slice(start, end);
}

/** At most `max` characters of `text`, cut with an ellipsis. */
export function clipExcerpt(text: string, max = INBOX_EXCERPT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${wellFormedSlice(text, 0, max - 1)}${ELLIPSIS}`;
}

/** The text around `@<name>`: a little of what comes before it, then as much as fits. */
export function mentionExcerpt(text: string, displayName: string, max = INBOX_EXCERPT_MAX_CHARS): string {
  const index = text.indexOf(mentionOf(displayName));
  if (text.length <= max || index <= EXCERPT_LEAD_CHARS) return clipExcerpt(text, max);
  const from = index - EXCERPT_LEAD_CHARS;
  const body = wellFormedSlice(text, from, from + max - 2);
  return `${ELLIPSIS}${body}${from + max - 2 < text.length ? ELLIPSIS : ''}`;
}

/**
 * Stores one mention per kept member, where the text now is (`target`, `anchor`). Never throws: the entity that
 * carries the mention exists already.
 */
export function storeMentions(
  ctx: DaemonContext,
  input: { readonly from: Principal; readonly kept: readonly UserRef[]; readonly target: ColumnTarget; readonly anchor?: { readonly cardId?: string; readonly seq?: number }; readonly text: string },
): void {
  if (input.kept.length === 0 || isStubService(ctx.services.inbox)) return;
  for (const member of input.kept) {
    try {
      const stored = ctx.services.inbox.addMention({
        userId: member.userId,
        from: input.from.actor,
        target: input.target,
        ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
        excerpt: mentionExcerpt(input.text, member.displayName),
      });
      if (stored === 'full') tellSenderInboxFull(ctx, input.from.userId, member.displayName);
    } catch (err) {
      ctx.log.error('storing a mention failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}

/** The mentioned member has too many unopened notes: the request succeeded, the sender learns that this one did not arrive. */
export function tellSenderInboxFull(ctx: DaemonContext, senderUserId: UserId | null, name: string): void {
  if (senderUserId === null || isStubService(ctx.services.activity)) return;
  const text = msg('mention.inboxFull', { name });
  ctx.services.activity.notify(senderUserId, { from: SYSTEM_ACTOR, msg: text, fallback: renderEnglish(text) });
}
