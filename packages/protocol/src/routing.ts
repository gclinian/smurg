// Who decides, who reviews, who is asked (ARCHITECTURE §3 "Who decides"): pure functions over the facts the daemon
// holds. The conversation, topics and inbox modules all use these and nothing else, so a card, a refusal and an inbox
// can never disagree. Clients read the results from `Question.decider`, `ReportSummary.reviewers` and their inbox;
// they may call the `may*` functions to hide what a member cannot do.
//
// Inputs are user ids and CURRENT roles of ACTIVE members. A member who was kicked or left is simply not in
// `members`; a responsible person or fallback decider who is no longer there, or who no longer holds `discuss`, does
// not count.
import { can, type Role } from './roles.ts';

export interface RoutingMember {
  readonly userId: string;
  readonly role: Role;
}

/** The active members of the workspace, the host among them. */
export type RoutingMembers = readonly RoutingMember[];

function roleOf(members: RoutingMembers, userId: string | null | undefined): Role | null {
  if (userId === null || userId === undefined) return null;
  return members.find((member) => member.userId === userId)?.role ?? null;
}

function holds(members: RoutingMembers, userId: string | null | undefined, capability: 'discuss' | 'session.drive'): boolean {
  const role = roleOf(members, userId);
  return role !== null && can(role, capability);
}

/** The host's user id, or null when `members` has no host (never the case in a running workspace). */
export function hostOf(members: RoutingMembers): string | null {
  return members.find((member) => member.role === 'host')?.userId ?? null;
}

/** Members with agent access: the host and the role Agent access (`session.drive`), in the order given. */
export function agentAccessMembers(members: RoutingMembers): string[] {
  return members.filter((member) => can(member.role, 'session.drive')).map((member) => member.userId);
}

/** Anyone holding `discuss` may be made responsible (routing only: it adds no capability). */
export function mayBeResponsible(role: Role | null): boolean {
  return role !== null && can(role, 'discuss');
}

export interface SessionRouting {
  /** `AgentSession.responsible` (null: nobody is assigned). */
  readonly responsible: string | null;
  /** The session's stored fallback decider: the member who opened it or pressed Start, until cleared for good. */
  readonly fallbackDecider: string | null;
}

/**
 * Who decides a session's questions:
 *   the responsible person, when set and still a member holding `discuss`
 *   | else the stored fallback decider, while it has not been cleared and still holds `discuss`
 *   | else the host.
 */
export function deciderOf(session: SessionRouting, members: RoutingMembers): string | null {
  if (holds(members, session.responsible, 'discuss')) return session.responsible;
  if (holds(members, session.fallbackDecider, 'discuss')) return session.fallbackDecider;
  return hostOf(members);
}

/**
 * Who may review an item's report: the responsible person, when set and still a member holding `discuss`; else every
 * member holding `discuss` (nobody assigned: anyone may review, once, for all).
 */
export function reviewersOf(item: { readonly responsible: string | null }, members: RoutingMembers): string[] {
  if (holds(members, item.responsible, 'discuss')) return [item.responsible as string];
  return members.filter((member) => can(member.role, 'discuss')).map((member) => member.userId);
}

/**
 * Whose inbox a permission request is in:
 *   host-only: the host
 *   | the responsible person, when they hold `session.drive` and the request has not escalated
 *   | else the host and every member with agent access.
 */
export function permissionRecipients(
  request: { readonly hostOnly: boolean; readonly escalated: boolean },
  session: Pick<SessionRouting, 'responsible'>,
  members: RoutingMembers,
): string[] {
  const host = hostOf(members);
  if (request.hostOnly) return host === null ? [] : [host];
  if (!request.escalated && holds(members, session.responsible, 'session.drive')) return [session.responsible as string];
  return agentAccessMembers(members);
}

/** A suggestion is routed like a permission request that is not host-only. */
export function suggestionRecipients(session: Pick<SessionRouting, 'responsible'>, members: RoutingMembers): string[] {
  return permissionRecipients({ hostOnly: false, escalated: false }, session, members);
}

/** Whose inbox holds an open question as `question`: the decider; once escalated, also the host and every member with agent access. */
export function questionRecipients(question: { readonly escalated: boolean }, session: SessionRouting, members: RoutingMembers): string[] {
  const decider = deciderOf(session, members);
  const out = new Set<string>(decider === null ? [] : [decider]);
  if (question.escalated) for (const userId of agentAccessMembers(members)) out.add(userId);
  return [...out];
}

/**
 * Whose inbox holds an open question as `vote`: in a session nobody is assigned to, every member holding `discuss`
 * who has not voted on every part and is not its decider. A session with a responsible person has none.
 */
export function voteRecipients(
  question: { readonly voted: ReadonlySet<string> | readonly string[] },
  session: SessionRouting,
  members: RoutingMembers,
): string[] {
  if (holds(members, session.responsible, 'discuss')) return [];
  const decider = deciderOf(session, members);
  const voted = question.voted instanceof Set ? question.voted : new Set(question.voted as readonly string[]);
  return members.filter((member) => can(member.role, 'discuss') && member.userId !== decider && !voted.has(member.userId)).map((member) => member.userId);
}

/** Whose inbox holds a report to review: its reviewers; once escalated, also the host and every member with agent access. */
export function reportRecipients(report: { readonly escalated: boolean }, item: { readonly responsible: string | null }, members: RoutingMembers): string[] {
  const out = new Set<string>(reviewersOf(item, members));
  if (report.escalated) for (const userId of agentAccessMembers(members)) out.add(userId);
  return [...out];
}

/** May `member` submit the answer? The decider; the host at any time; once escalated, every member with agent access. */
export function maySubmit(member: RoutingMember, question: { readonly decider: string | null; readonly escalated: boolean }): boolean {
  if (!can(member.role, 'discuss')) return false;
  if (question.decider !== null && member.userId === question.decider) return true;
  if (member.role === 'host') return true;
  return question.escalated && can(member.role, 'session.drive');
}

/**
 * SUBMITTING a free-text answer ("Other") and the decider's note need agent access, whoever decides
 * (`question.submit`). VOTING "Other" does not: every member holding `discuss` may (`question.vote`); that text is for
 * people and never reaches the agent by itself.
 */
export function mayAnswerInOwnWords(role: Role | null): boolean {
  return role !== null && can(role, 'session.drive');
}

/** May `member` press "I've reviewed this"? One of the reviewers; once escalated, every member with agent access. */
export function mayReview(member: RoutingMember, report: { readonly reviewers: readonly string[]; readonly escalated: boolean }): boolean {
  if (!can(member.role, 'discuss')) return false;
  if (report.reviewers.includes(member.userId)) return true;
  return report.escalated && can(member.role, 'session.drive');
}

/** May `member` answer a permission request? Members with agent access; a host-only request: the host. */
export function mayDecidePermission(member: RoutingMember, request: { readonly hostOnly: boolean }): boolean {
  if (!can(member.role, 'session.drive')) return false;
  return !request.hostOnly || member.role === 'host';
}

/** "Always allow this kind" for every session of a topic: the host and members with agent access. */
export function mayAllowForTopic(role: Role | null): boolean {
  return role !== null && can(role, 'session.drive');
}

/**
 * May `member` end this session (`session.end`)? A terminal: the member who opened it. An agent session: the host, or
 * a member with agent access who opened it or is responsible for it. A topic's discussion: nobody (archive the topic
 * or restart the discussion).
 */
export function mayEndSession(
  member: RoutingMember,
  session: { readonly kind: 'terminal' | 'agent'; readonly purpose?: 'discussion' | 'item' | 'free'; readonly openedBy: string; readonly responsible?: string | null },
): boolean {
  if (session.kind === 'terminal') return member.userId === session.openedBy;
  if (session.purpose === 'discussion') return false;
  if (member.role === 'host') return true;
  return can(member.role, 'session.drive') && (member.userId === session.openedBy || member.userId === session.responsible);
}
