// What is in whose inbox (ARCHITECTURE §5.11, §3 "Who decides"): a PURE function of what is open right now. Nothing
// here is stored and nothing here reads a service: inbox-service.ts collects the facts (the open questions and
// permission requests, the pending suggestions, the reports to review, the merge requests, the attention facts, who is
// responsible for which session, the plans, who is a member and who is online) and gives them as an InboxWorld.
//
// Who gets a thing is routing.ts and nothing else, so a card, a refusal and an inbox never disagree:
//
//   question    questionRecipients: the decider; once escalated also the host and every member with agent access
//   vote        voteRecipients: in a session nobody is responsible for, every member holding `discuss` who has not
//               voted on every part and does not hold the question item already
//   permission  permissionRecipients: host-only → the host; the responsible person while they hold `session.drive` and
//               it has not escalated; else the host and every member with agent access
//   suggestion  suggestionRecipients (as a permission request that is not host-only); ONE item per author and session
//   report      reportRecipients: the reviewers; once escalated also the host and every member with agent access
//   merge       the host: `pending`, `conflict`, and a `draft` whose report is reviewed (`ready`)
//   attention   the recipients its fact names (the service that owns the fact decides them)
//
// An item leaves when its thing is no longer in the world, for everyone at once: there is nothing to clear by hand.
//
// STAMPS. Every derived item has a stamp; the member's "seen" mark remembers the stamp the item had when they looked
// at it. The item is unread again when its stamp moved on to a NON-EMPTY value: a question whose eligible members
// have all voted, a new version of a report, one more suggestion of the same author, a merge request that changed
// state. The empty stamp never makes an item unread (a question that is no longer "all voted" stays read) and re-arms
// the mark for the next time. A permission request, a vote and an attention item are unread once.
import { createHash } from 'node:crypto';
import {
  INBOX_ALSO_FOR_MAX,
  INBOX_EXCERPT_MAX_CHARS,
  INBOX_KEY_MAX_CHARS,
  PLAN_ITEMS_MAX,
  agentAccessMembers,
  allVoted,
  deciderOf,
  hostOf,
  inboxKindWaits,
  leadingLabel,
  permissionRecipients,
  questionRecipients,
  reportRecipients,
  reviewersOf,
  suggestionRecipients,
  voteRecipients,
  votersOf,
  type Actor,
  type AttentionSubject,
  type InboxItem,
  type MergeRequest,
  type PermissionRequest,
  type PlanInfo,
  type Question,
  type ReportSummary,
  type RoutingMembers,
  type Suggestion,
  type UserRef,
} from '@smurg/protocol';
import type { AttentionFact } from '../core/interfaces.ts';
import { noteKey, type StoredNote } from './store.ts';

/** What the derivation needs to know of an agent session. */
export interface SessionView {
  /** `AgentSession.responsible` (null: nobody is assigned). */
  readonly responsible: string | null;
  /** `AgentSessionFacts.fallbackDecider`. */
  readonly fallbackDecider: string | null;
  readonly topicId?: string;
  readonly itemId?: string;
  readonly item?: { readonly number: number; readonly title: string };
}

/** Everything a member's inbox is derived from, as it is right now. */
export interface InboxWorld {
  /** The active members with their current roles (`MemberDirectory.routing()`). */
  readonly members: RoutingMembers;
  userRef(userId: string): UserRef | null;
  isOnline(userId: string): boolean;
  /** Open questions. */
  readonly questions: readonly Question[];
  /** Open permission requests (the host's copies: `path` is never read here). */
  readonly permissions: readonly PermissionRequest[];
  /** Pending suggestions. */
  readonly suggestions: readonly Suggestion[];
  /** Reports that wait for a review. */
  readonly reports: readonly { readonly topicId: string; readonly itemId: string; readonly report: ReportSummary }[];
  /** Every merge request, drafts included. */
  readonly merges: readonly MergeRequest[];
  readonly attention: readonly AttentionFact[];
  session(sessionId: string): SessionView | null;
  plan(topicId: string): PlanInfo | null;
  /** The topic exists and is not archived (nothing waits in an archived topic). */
  topicOpen(topicId: string): boolean;
}

/** An item without the one field that is the member's own (`unread`). */
export type InboxItemBody = Omit<InboxItem, 'unread'>;

export interface DerivedItem {
  readonly body: InboxItemBody;
  /** See STAMPS above. */
  readonly stamp: string;
}

// =====================================================================================================================
// Text and keys
// =====================================================================================================================

// What `multilineTextSchema` refuses: control characters other than tab and LF, bidi embeddings / overrides / isolates.
const UNSHOWABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const CLIPPED = '…';

/**
 * The text of an item's `excerpt`: always valid for the wire (no control or bidi characters, well formed), trimmed,
 * and clipped to INBOX_EXCERPT_MAX_CHARS with an ellipsis, never in the middle of a surrogate pair.
 */
export function excerptOf(text: string): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(UNSHOWABLE, '').replace(LONE_SURROGATE, '�').trim();
  if (clean.length <= INBOX_EXCERPT_MAX_CHARS) return clean;
  let cut = INBOX_EXCERPT_MAX_CHARS - CLIPPED.length;
  const last = clean.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return clean.slice(0, cut).trimEnd() + CLIPPED;
}

const KEY_PART = /^[\x21-\x7e]+$/;

/** `raw` as a part of an inbox key when it is printable ASCII and fits; else a fixed-length digest of it. */
function keyPart(raw: string, maxChars: number): string {
  if (raw.length <= maxChars && KEY_PART.test(raw)) return raw;
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}

export function questionKey(questionId: string): string {
  return `question:${questionId}`;
}

export function voteKey(questionId: string): string {
  return `vote:${questionId}`;
}

export function permissionKey(requestId: string): string {
  return `permission:${requestId}`;
}

/** ONE item per author and session: `suggestion:<session id>.<provider>-<id of the author>`. */
export function suggestionKey(sessionId: string, authorUserId: string): string {
  const prefix = `suggestion:${sessionId}.`;
  return prefix + keyPart(authorUserId.replace(':', '-'), INBOX_KEY_MAX_CHARS - prefix.length);
}

export function reportKey(topicId: string, itemId: string): string {
  return `report:${topicId}.${itemId}`;
}

export function mergeKey(requestId: string): string {
  return `merge:${requestId}`;
}

export function attentionKey(subject: AttentionSubject, id: string): string {
  const prefix = `attention:${subject}:`;
  return prefix + keyPart(id, INBOX_KEY_MAX_CHARS - prefix.length);
}

// =====================================================================================================================
// Shared pieces of an item
// =====================================================================================================================

interface Where {
  topicId?: string;
  itemId?: string;
  item?: { number: number; title: string };
}

/** Where a session's things belong: its topic, and its work item with the item's number and title. */
function whereOfSession(view: SessionView | null): Where {
  if (view === null || view.topicId === undefined) return {};
  if (view.itemId === undefined || view.item === undefined) return { topicId: view.topicId };
  return { topicId: view.topicId, itemId: view.itemId, item: { number: view.item.number, title: view.item.title } };
}

/** A work item named by its ids: number and title from the plan (`number` 0 and the id when it left the plan). */
function whereOfItem(world: Pick<InboxWorld, 'plan'>, topicId: string, itemId: string): Required<Where> {
  const found = world.plan(topicId)?.items.find((item) => item.id === itemId);
  return { topicId, itemId, item: found === undefined ? { number: 0, title: itemId } : { number: found.number, title: found.title } };
}

/** The other members whose inbox holds the same thing (they may settle it too). */
function othersOf(world: Pick<InboxWorld, 'userRef'>, recipients: readonly string[], me: string): Pick<InboxItemBody, 'alsoFor' | 'alsoForMore'> {
  const refs = recipients.filter((userId) => userId !== me).flatMap((userId) => world.userRef(userId) ?? []);
  if (refs.length === 0) return {};
  if (refs.length <= INBOX_ALSO_FOR_MAX) return { alsoFor: refs };
  return { alsoFor: refs.slice(0, INBOX_ALSO_FOR_MAX), alsoForMore: refs.length - INBOX_ALSO_FOR_MAX };
}

/** The person a thing waits for, in the copy of somebody else. */
function waitingOn(world: Pick<InboxWorld, 'userRef' | 'isOnline'>, userId: string | null, me: string): Pick<InboxItemBody, 'waitsFor' | 'waitsForOffline'> {
  if (userId === null || userId === me) return {};
  const ref = world.userRef(userId);
  return ref === null ? {} : { waitsFor: ref, waitsForOffline: !world.isOnline(userId) };
}

function userActor(ref: UserRef): Actor {
  return { kind: 'user', userId: ref.userId, displayName: ref.displayName };
}

/** What a permission row says the agent wants: the command, the URL, the file in the workspace; else the tool's name. Never the absolute path. */
function permissionExcerpt(request: PermissionRequest): string {
  return excerptOf(request.command ?? request.url ?? request.file?.path ?? request.tool);
}

class Boxes {
  readonly byMember = new Map<string, DerivedItem[]>();

  add(userId: string, body: InboxItemBody, stamp: string): void {
    const box = this.byMember.get(userId);
    if (box === undefined) this.byMember.set(userId, [{ body, stamp }]);
    else box.push({ body, stamp });
  }
}

// =====================================================================================================================
// The derivation
// =====================================================================================================================

function deriveQuestions(world: InboxWorld, boxes: Boxes): void {
  for (const question of world.questions) {
    if (question.status !== 'open') continue;
    const view = world.session(question.sessionId);
    const routing = { responsible: view?.responsible ?? null, fallbackDecider: view?.fallbackDecider ?? null };
    const escalated = question.escalatedAt !== undefined;
    const decider = deciderOf(routing, world.members);
    const deciders = questionRecipients({ escalated }, routing, world.members);
    const voters = votersOf(question);
    const everyone = allVoted(question);
    const leading = leadingLabel(question);
    const shared = {
      at: question.askedAt,
      waiting: true,
      ...whereOfSession(view),
      sessionId: question.sessionId,
      target: { kind: 'session' as const, sessionId: question.sessionId },
      anchor: { cardId: question.id },
      excerpt: excerptOf(question.parts[0]?.text ?? ''),
      voted: voters.complete.length,
      eligible: question.eligible,
    };
    for (const userId of deciders) {
      boxes.add(
        userId,
        {
          key: questionKey(question.id),
          kind: 'question',
          ...shared,
          allVoted: everyone,
          ...(leading === undefined ? {} : { leading }),
          ...waitingOn(world, decider, userId),
          ...(escalated ? { escalated: true } : {}),
          ...othersOf(world, deciders, userId),
        },
        everyone ? 'all-voted' : '',
      );
    }
    // Whoever holds the question itself is not asked to vote on it as well.
    const holders = new Set(deciders);
    for (const userId of voteRecipients({ voted: voters.complete }, routing, world.members)) {
      if (holders.has(userId)) continue;
      boxes.add(userId, { key: voteKey(question.id), kind: 'vote', ...shared, ...waitingOn(world, decider, userId) }, 'vote');
    }
  }
}

function derivePermissions(world: InboxWorld, boxes: Boxes): void {
  for (const request of world.permissions) {
    if (request.status !== 'open') continue;
    const view = world.session(request.sessionId);
    const session = { responsible: view?.responsible ?? null };
    const escalated = request.escalatedAt !== undefined;
    const recipients = permissionRecipients({ hostOnly: request.hostOnly, escalated }, session, world.members);
    // The one person it went to before it escalated: the others' copies say who has not answered.
    const first = escalated ? permissionRecipients({ hostOnly: request.hostOnly, escalated: false }, session, world.members) : [];
    const waitedFor = first.length === 1 ? (first[0] as string) : null;
    for (const userId of recipients) {
      boxes.add(
        userId,
        {
          key: permissionKey(request.id),
          kind: 'permission',
          at: request.askedAt,
          waiting: true,
          ...whereOfSession(view),
          sessionId: request.sessionId,
          target: { kind: 'session', sessionId: request.sessionId },
          anchor: { cardId: request.id },
          excerpt: permissionExcerpt(request),
          ...waitingOn(world, waitedFor, userId),
          ...(escalated ? { escalated: true } : {}),
          ...othersOf(world, recipients, userId),
        },
        'open',
      );
    }
  }
}

function deriveSuggestions(world: InboxWorld, boxes: Boxes): void {
  const groups = new Map<string, Suggestion[]>();
  for (const suggestion of world.suggestions) {
    if (suggestion.status !== 'pending') continue;
    const key = suggestionKey(suggestion.sessionId, suggestion.author.userId);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [suggestion]);
    else group.push(suggestion);
  }
  for (const [key, group] of groups) {
    group.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const oldest = group[0] as Suggestion;
    const newest = group[group.length - 1] as Suggestion;
    const view = world.session(oldest.sessionId);
    const recipients = suggestionRecipients({ responsible: view?.responsible ?? null }, world.members);
    for (const userId of recipients) {
      boxes.add(
        userId,
        {
          key,
          kind: 'suggestion',
          at: newest.createdAt,
          waiting: false,
          ...whereOfSession(view),
          sessionId: oldest.sessionId,
          target: { kind: 'session', sessionId: oldest.sessionId },
          anchor: { cardId: oldest.id },
          from: userActor(oldest.author),
          excerpt: excerptOf(oldest.text),
          count: group.length,
          ...othersOf(world, recipients, userId),
        },
        newest.id,
      );
    }
  }
}

function deriveReports(world: InboxWorld, boxes: Boxes): void {
  for (const { topicId, itemId, report } of world.reports) {
    if (report.state !== 'to-review' && report.state !== 'changed-after-review') continue;
    if (!world.topicOpen(topicId)) continue;
    const planItem = world.plan(topicId)?.items.find((item) => item.id === itemId);
    const view = planItem?.sessionId === undefined ? null : world.session(planItem.sessionId);
    const escalated = report.escalatedAt !== undefined;
    let reviewers: string[];
    let recipients: string[];
    if (planItem === undefined) {
      // The plan does not name the item (any more): who reviews is what the report itself says.
      const members = new Set(world.members.map((member) => member.userId));
      reviewers = report.reviewers.map((reviewer) => reviewer.userId).filter((userId) => members.has(userId));
      recipients = escalated ? [...new Set([...reviewers, ...agentAccessMembers(world.members)])] : reviewers;
    } else {
      // One fact, one home: the session once the item has one, the plan's own record before.
      const responsible = view === null ? (planItem.responsible?.userId ?? null) : view.responsible;
      reviewers = reviewersOf({ responsible }, world.members);
      recipients = reportRecipients({ escalated }, { responsible }, world.members);
    }
    const waitedFor = escalated && reviewers.length === 1 ? (reviewers[0] as string) : null;
    const where = whereOfItem(world, topicId, itemId);
    for (const userId of recipients) {
      boxes.add(
        userId,
        {
          key: reportKey(topicId, itemId),
          kind: 'report',
          at: report.writtenAt,
          waiting: false,
          ...where,
          ...(planItem?.sessionId === undefined ? {} : { sessionId: planItem.sessionId }),
          target: { kind: 'report', topicId, itemId },
          excerpt: '',
          ...waitingOn(world, waitedFor, userId),
          ...(escalated ? { escalated: true } : {}),
          ...othersOf(world, recipients, userId),
          outcome: report.outcome,
          checks: { passed: report.checks.passed, notVerified: report.checks.notVerified },
        },
        `${report.version}:${report.state}`,
      );
    }
  }
}

/** The numbers of the plan's items that wait for this item's merge. */
function unblockedBy(plan: PlanInfo | null, itemId: string): number[] {
  if (plan === null) return [];
  const numbers = plan.items.filter((item) => item.inPlan && item.number >= 1 && item.waitsFor?.includes(itemId) === true).map((item) => item.number);
  return [...new Set(numbers)].sort((a, b) => a - b).slice(0, PLAN_ITEMS_MAX);
}

function mergeInInbox(request: MergeRequest): boolean {
  return request.status === 'pending' || request.status === 'conflict' || (request.status === 'draft' && request.reviewed);
}

function deriveMerges(world: InboxWorld, boxes: Boxes): void {
  const host = hostOf(world.members);
  if (host === null) return;
  for (const request of world.merges) {
    if (!mergeInInbox(request)) continue;
    const where: Where = request.topicId === undefined ? {} : request.itemId === undefined ? { topicId: request.topicId } : whereOfItem(world, request.topicId, request.itemId);
    const unblocks = request.topicId === undefined || request.itemId === undefined ? [] : unblockedBy(world.plan(request.topicId), request.itemId);
    boxes.add(
      host,
      {
        key: mergeKey(request.id),
        kind: 'merge',
        at: request.createdAt,
        waiting: false,
        ...where,
        target: { kind: 'changes', requestId: request.id },
        ...(request.requestedBy === undefined ? {} : { from: userActor(request.requestedBy) }),
        excerpt: excerptOf(request.message ?? ''),
        ready: request.status === 'draft' && request.reviewed,
        ...(unblocks.length === 0 ? {} : { unblocks }),
        conflict: request.status === 'conflict',
      },
      `${request.status}:${request.reviewed ? 'reviewed' : 'open'}`,
    );
  }
}

function deriveAttention(world: InboxWorld, boxes: Boxes): void {
  const members = new Set(world.members.map((member) => member.userId));
  for (const fact of world.attention) {
    // `item` goes with `itemId`, and an item belongs to a topic: a fact that names half of it keeps what holds.
    const where: Where =
      fact.topicId === undefined ? {} : fact.itemId === undefined || fact.item === undefined ? { topicId: fact.topicId } : { topicId: fact.topicId, itemId: fact.itemId, item: { number: fact.item.number, title: fact.item.title } };
    const body: InboxItemBody = {
      key: attentionKey(fact.subject, fact.id),
      kind: 'attention',
      subject: fact.subject,
      at: fact.at,
      waiting: inboxKindWaits('attention', fact.subject),
      ...where,
      ...(fact.sessionId === undefined ? {} : { sessionId: fact.sessionId }),
      target: fact.target,
      excerpt: excerptOf(fact.excerpt),
      ...(fact.count === undefined ? {} : { count: fact.count }),
    };
    for (const userId of new Set(fact.recipients)) if (members.has(userId)) boxes.add(userId, body, 'open');
  }
}

/** Every member's derived items (members with none are absent). Stored notes are not part of it: `noteItem`. */
export function deriveInbox(world: InboxWorld): Map<string, DerivedItem[]> {
  const boxes = new Boxes();
  deriveQuestions(world, boxes);
  derivePermissions(world, boxes);
  deriveSuggestions(world, boxes);
  deriveReports(world, boxes);
  deriveMerges(world, boxes);
  deriveAttention(world, boxes);
  return boxes.byMember;
}

/** A stored note as the item its member sees. Where it belongs is read from what it points to, as it is named now. */
export function noteItem(note: StoredNote, world: Pick<InboxWorld, 'session' | 'plan'>): InboxItemBody {
  if (note.kind === 'result') {
    return {
      key: noteKey(note),
      kind: 'result',
      at: note.at,
      waiting: false,
      ...whereOfSession(world.session(note.sessionId)),
      sessionId: note.sessionId,
      target: { kind: 'session', sessionId: note.sessionId },
      anchor: { cardId: note.suggestionId },
      from: note.from,
      excerpt: note.excerpt,
      result: note.outcome,
    };
  }
  const target = note.target;
  const where: Where & { sessionId?: string } =
    target.kind === 'session'
      ? { ...whereOfSession(world.session(target.sessionId)), sessionId: target.sessionId }
      : target.kind === 'spec' || target.kind === 'plan'
        ? { topicId: target.topicId }
        : target.kind === 'report'
          ? whereOfItem(world, target.topicId, target.itemId)
          : {};
  const anchor = note.anchor === undefined || (note.anchor.cardId === undefined && note.anchor.seq === undefined) ? undefined : note.anchor;
  return {
    key: noteKey(note),
    kind: 'mention',
    at: note.at,
    waiting: false,
    ...where,
    target,
    ...(anchor === undefined ? {} : { anchor }),
    from: note.from,
    excerpt: note.excerpt,
  };
}
