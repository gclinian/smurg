// What the protocol 4 flow tests share (t.topic-flow, r2.agent-role, r11.console): a MEMBER as a client keeps it.
//
// A `Member` is one Connection of the client SDK and the state a client builds from what that connection receives,
// by the reading rules of ARCHITECTURE §5.9 (the same rules the web app's stores follow):
//
//   - a conversation is a WINDOW of events by `seq`: the page of `session.watch`, then `session.events`; an event that
//     arrives again under a `seq` replaces the old one; a watch with `haveSeq` continues the window or replaces it;
//     `hasMore` is read forward and `hasEarlier` backward with `session.history`;
//   - cards (questions, permission requests, suggestions) are entities: whole with `*.updated`, a small change of an
//     open question with `question.changed`; a watch reply carries every OPEN card, so a card this client holds as
//     open that the reply does not carry was settled while the client was away: it is read with `session.cards.get`;
//   - topics, plans, sessions, reports and the inbox are folded from their list request and their update messages.
//
// The tests assert on this state (what a person would have on screen), never on the daemon's internals, and compare
// the state of one member with another's: through the relay every member must end with the same picture.
import {
  CARDS_GET_MAX,
  EVENTS_PAGE_MAX,
  type AgentSession,
  type AuditEntry,
  type CardRef,
  type ConversationEvent,
  type InboxItem,
  type MergeRequest,
  type PayloadOf,
  type PermissionRequest,
  type PlanInfo,
  type Question,
  type Role,
  type SessionInfo,
  type SmurgError,
  type Suggestion,
  type Topic,
} from '@smurg/protocol';
import type { Connection, InteractiveEventType } from '@smurg/protocol/client';
import { waitUntil, type StackClient } from './harness.ts';

/** The d→c types a member's recorder keeps, in arrival order (everything a flow sends to a client but text deltas). */
const RECORDED = [
  'session.events',
  'session.state',
  'question.updated',
  'question.changed',
  'permission.updated',
  'suggest.updated',
  'topic.updated',
  'topic.removed',
  'plan.updated',
  'report.updated',
  'inbox.changed',
  'worktree.updated',
  'worktree.removed',
  'worktree.merge.updated',
] as const satisfies readonly InteractiveEventType[];
type Recorded = (typeof RECORDED)[number];

type ReportSummary = PayloadOf<'report.updated'>['report'];

/** What a member holds: comparable between members (`picture`). */
export interface Picture {
  readonly topics: Topic[];
  readonly plans: PlanInfo[];
  readonly sessions: SessionInfo[];
  readonly conversations: Record<string, ConversationEvent[]>;
  readonly questions: Question[];
  readonly permissions: PermissionRequest[];
  readonly suggestions: Suggestion[];
}

export interface Member {
  readonly name: string;
  readonly role: Role;
  readonly userId: string;
  readonly client: StackClient;
  readonly conn: Connection;
  /** Every payload of one type this connection received, in arrival order (live: the array grows). */
  got<T extends Recorded>(type: T): PayloadOf<T>[];
  /** The conversation of one session as this member has it: its window, in order. */
  events(sessionId: string): ConversationEvent[];
  /** The cards this member holds, each in its newest state, in the order they were first seen. */
  questions(): Question[];
  permissions(): PermissionRequest[];
  suggestions(): Suggestion[];
  topic(topicId: string): Topic | undefined;
  plan(topicId: string): PlanInfo | undefined;
  session(sessionId: string): SessionInfo | undefined;
  /** The sessions this member watches. */
  watching(): string[];
  /** The member's inbox as the daemon lists it now (`inbox.list`). */
  inbox(): Promise<InboxItem[]>;
  /** The member's inbox as this client folded it: `inbox.list` at `sync()`, then every `inbox.changed`. */
  inboxHeld(): InboxItem[];
  /**
   * `session.watch`, as a client does it: with `haveSeq` when it has a window (continue or replace), then forward
   * while `hasMore`; the cards of the reply, `moreCards`, and every card held as open that the reply did not carry.
   */
  watch(sessionId: string): Promise<void>;
  /** "Load earlier" until the first event: `session.history { beforeSeq }`, `limit` events at a time. Returns the number of requests. */
  readBack(sessionId: string, limit?: number): Promise<number>;
  /**
   * What a client does after a Welcome that did not resume its channel (it joined, it reloaded, the host's smurg
   * started again): the lists (topics, plans, sessions, reports' requests, the inbox) and every watched session again.
   */
  sync(): Promise<void>;
  /** Waits until everything this client started by itself (card reads) has finished. */
  settled(): Promise<void>;
  /** The newest summary of each report this member was sent (`report.updated`), by `<topic id>.<item id>`. */
  reports(): Record<string, ReportSummary>;
  /** The merge requests this member holds: the list at `sync()`, then every `worktree.merge.updated`. */
  merges(): MergeRequest[];
  /**
   * What this member holds, in a form two members can be compared by: the conversations, the cards, the topics, the
   * plans (each item with its report's and its change's state) and the sessions.
   */
  picture(): Picture;
}

const byId = <T extends { id: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A question as two clients can compare it: votes in one order (a client appends a changed vote, the daemon keeps its place). */
function comparableQuestion(question: Question): Question {
  return { ...question, votes: [...question.votes].sort((a, b) => a.part - b.part || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)) };
}

/** A permission request as two clients can compare it: the host's copy alone carries `path` (ARCHITECTURE §5.9). */
function comparablePermission(request: PermissionRequest): PermissionRequest {
  const { path: _path, ...rest } = request;
  return rest;
}

/**
 * A session as two clients can compare it. `lastSeq` and `lastActivityAt` say how far the conversation was when the
 * entity was SENT (a `session.state` goes out when something of the session changes that the list shows, not with
 * every event: the conversation itself goes to who watches it), so two clients that were sent the entity at different
 * moments hold different numbers there, and both are right.
 */
export function comparableSession(session: SessionInfo): SessionInfo {
  if (session.kind !== 'agent') return session;
  return { ...session, lastSeq: 0, lastActivityAt: 0 };
}

export function member(client: StackClient, name: string, role: Role): Member {
  const conn = client.conn;
  const seen = new Map<Recorded, unknown[]>();
  for (const type of RECORDED) {
    const list: unknown[] = [];
    seen.set(type, list);
    conn.on(type, (payload: unknown) => list.push(payload));
  }
  const got = <T extends Recorded>(type: T): PayloadOf<T>[] => seen.get(type) as PayloadOf<T>[];

  const windows = new Map<string, Map<number, ConversationEvent>>();
  const watched = new Set<string>();
  const questions = new Map<string, Question>();
  const permissions = new Map<string, PermissionRequest>();
  const suggestions = new Map<string, Suggestion>();
  const topics = new Map<string, Topic>();
  const plans = new Map<string, PlanInfo>();
  const sessions = new Map<string, SessionInfo>();
  const reports = new Map<string, ReportSummary>();
  const merges = new Map<string, MergeRequest>();
  const inbox = new Map<string, InboxItem>();
  const background = new Set<Promise<void>>();

  const windowOf = (sessionId: string): Map<number, ConversationEvent> => {
    let window = windows.get(sessionId);
    if (window === undefined) {
      window = new Map();
      windows.set(sessionId, window);
    }
    return window;
  };
  const fold = (sessionId: string, events: readonly ConversationEvent[]): void => {
    const window = windowOf(sessionId);
    for (const event of events) window.set(event.seq, event);
  };
  const takeCards = (page: { readonly questions: readonly Question[]; readonly permissions: readonly PermissionRequest[]; readonly suggestions: readonly Suggestion[] }): void => {
    for (const question of page.questions) questions.set(question.id, question);
    for (const request of page.permissions) permissions.set(request.id, request);
    for (const suggestion of page.suggestions) suggestions.set(suggestion.id, suggestion);
  };
  const readCards = async (sessionId: string, refs: readonly CardRef[]): Promise<void> => {
    let left = [...refs];
    while (left.length > 0) {
      const reply = await conn.request('session.cards.get', { sessionId, cards: left.slice(0, CARDS_GET_MAX) });
      takeCards(reply);
      left = [...left.slice(CARDS_GET_MAX), ...reply.moreCards];
    }
  };
  const inBackground = (work: Promise<void>): void => {
    const tracked = work.catch(() => {}).finally(() => background.delete(tracked));
    background.add(tracked);
  };

  conn.on('session.events', (payload) => fold(payload.sessionId, payload.events));
  conn.on('session.state', (payload) => sessions.set(payload.session.id, payload.session));
  conn.on('question.updated', (payload) => questions.set(payload.question.id, payload.question));
  conn.on('permission.updated', (payload) => permissions.set(payload.request.id, payload.request));
  conn.on('suggest.updated', (payload) => suggestions.set(payload.suggestion.id, payload.suggestion));
  conn.on('question.changed', (change) => {
    const question = questions.get(change.questionId);
    if (question === undefined) {
      // A change of a card this client does not hold: read the whole card.
      inBackground(readCards(change.sessionId, [{ kind: 'question', id: change.questionId }]));
      return;
    }
    let votes = question.votes;
    const removed = change.voteRemoved;
    if (removed !== undefined) votes = votes.filter((vote) => !(vote.userId === removed.userId && vote.part === removed.part));
    const added = change.vote;
    if (added !== undefined) votes = [...votes.filter((vote) => !(vote.userId === added.userId && vote.part === added.part)), added];
    const comment = change.comment;
    const comments = comment === undefined || question.comments.some((one) => one.id === comment.id) ? question.comments : [...question.comments, comment];
    questions.set(question.id, {
      ...question,
      votes,
      comments,
      ...(change.eligible === undefined ? {} : { eligible: change.eligible }),
      ...(change.deciderSeenAt === undefined ? {} : { deciderSeenAt: change.deciderSeenAt }),
    });
  });
  conn.on('topic.updated', (payload) => topics.set(payload.topic.id, payload.topic));
  conn.on('topic.removed', (payload) => {
    topics.delete(payload.topicId);
    plans.delete(payload.topicId);
  });
  conn.on('plan.updated', (payload) => plans.set(payload.plan.topicId, payload.plan));
  conn.on('report.updated', (payload) => reports.set(`${payload.topicId}.${payload.itemId}`, payload.report));
  conn.on('worktree.merge.updated', (payload) => merges.set(payload.request.id, payload.request));
  conn.on('inbox.changed', (payload) => {
    for (const key of payload.remove) inbox.delete(key);
    for (const item of payload.upsert) inbox.set(item.key, item);
  });

  const events = (sessionId: string): ConversationEvent[] => [...(windows.get(sessionId)?.values() ?? [])].sort((a, b) => a.seq - b.seq);

  const watch = async (sessionId: string): Promise<void> => {
    const held = events(sessionId);
    const haveSeq = held.at(-1)?.seq;
    const reply = await conn.request('session.watch', { sessionId, ...(haveSeq === undefined ? {} : { haveSeq }) });
    watched.add(sessionId);
    sessions.set(reply.session.id, reply.session);
    // Continue or replace: an empty page, or one that begins right after what was asked for, continues the window.
    const continues = haveSeq !== undefined && (reply.events.length === 0 || reply.firstSeq === haveSeq + 1);
    if (!continues) windows.set(sessionId, new Map());
    fold(sessionId, reply.events);
    takeCards(reply);
    const carried = new Set([...reply.questions, ...reply.permissions, ...reply.suggestions].map((card) => card.id));
    const refs: CardRef[] = [...reply.moreCards];
    for (const ref of refs) carried.add(ref.id);
    // The reply carries every open card of the session. One this client still holds as open and the reply does not
    // carry was answered, decided or withdrawn while the client was not told: read it.
    for (const question of questions.values()) if (question.sessionId === sessionId && question.status === 'open' && !carried.has(question.id)) refs.push({ kind: 'question', id: question.id });
    for (const request of permissions.values()) if (request.sessionId === sessionId && request.status === 'open' && !carried.has(request.id)) refs.push({ kind: 'permission', id: request.id });
    for (const suggestion of suggestions.values()) if (suggestion.sessionId === sessionId && suggestion.status === 'pending' && !carried.has(suggestion.id)) refs.push({ kind: 'suggestion', id: suggestion.id });
    let more = reply.hasMore;
    while (more) {
      const last = events(sessionId).at(-1)?.seq ?? 0;
      const next = await conn.request('session.history', { sessionId, afterSeq: last, limit: EVENTS_PAGE_MAX });
      fold(sessionId, next.events);
      takeCards(next);
      refs.push(...next.moreCards);
      more = next.hasMore && next.events.length > 0;
    }
    // The cards the window's events point to and this client does not hold (a page names them; `moreCards` did not fit).
    for (const event of events(sessionId)) {
      if (event.kind !== 'card') continue;
      const has = event.card === 'question' ? questions.has(event.id) : event.card === 'permission' ? permissions.has(event.id) : suggestions.has(event.id);
      if (!has && !refs.some((ref) => ref.id === event.id)) refs.push({ kind: event.card, id: event.id });
    }
    await readCards(sessionId, refs);
  };

  const readBack = async (sessionId: string, limit = EVENTS_PAGE_MAX): Promise<number> => {
    let requests = 0;
    for (;;) {
      const first = events(sessionId)[0]?.seq;
      if (first === undefined || first <= 1) return requests;
      const page = await conn.request('session.history', { sessionId, beforeSeq: first, limit });
      requests += 1;
      fold(sessionId, page.events);
      takeCards(page);
      await readCards(sessionId, page.moreCards);
      if (page.events.length === 0 || !page.hasEarlier) return requests;
    }
  };

  const sync = async (): Promise<void> => {
    topics.clear();
    plans.clear();
    sessions.clear();
    merges.clear();
    inbox.clear();
    for (const topic of [...(await conn.request('topic.list', {})).topics, ...(await conn.request('topic.list', { archived: true })).topics]) {
      topics.set(topic.id, topic);
      const { plan } = await conn.request('plan.get', { topicId: topic.id });
      if (plan !== null) plans.set(topic.id, plan);
    }
    for (const session of (await conn.request('session.list', {})).sessions) sessions.set(session.id, session);
    for (const request of (await conn.request('worktree.merge.list', {})).requests) merges.set(request.id, request);
    for (const item of (await conn.request('inbox.list', {})).items) inbox.set(item.key, item);
    for (const sessionId of [...watched]) await watch(sessionId);
  };

  return {
    name,
    role,
    userId: client.userId,
    client,
    conn,
    got,
    events,
    questions: () => [...questions.values()],
    permissions: () => [...permissions.values()],
    suggestions: () => [...suggestions.values()],
    topic: (topicId) => topics.get(topicId),
    plan: (topicId) => plans.get(topicId),
    session: (sessionId) => sessions.get(sessionId),
    watching: () => [...watched],
    inbox: async () => (await conn.request('inbox.list', {})).items,
    inboxHeld: () => [...inbox.values()],
    watch,
    readBack,
    sync,
    settled: async () => {
      while (background.size > 0) await Promise.all([...background]);
    },
    reports: () => Object.fromEntries([...reports.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    merges: () => byId([...merges.values()]),
    picture: () => ({
      topics: byId([...topics.values()]),
      plans: [...plans.values()].sort((a, b) => (a.topicId < b.topicId ? -1 : 1)),
      sessions: byId([...sessions.values()].map(comparableSession)),
      conversations: Object.fromEntries([...windows.keys()].sort().map((sessionId) => [sessionId, events(sessionId)])),
      questions: byId([...questions.values()].map(comparableQuestion)),
      permissions: byId([...permissions.values()].map(comparablePermission)),
      suggestions: byId([...suggestions.values()]),
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a request was refused with
// ---------------------------------------------------------------------------------------------------------------------

export interface Refusal {
  readonly code: string;
  readonly reason?: string;
  /** The catalog id of the sentence. */
  readonly id?: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The refusal a request got, or null when it succeeded. */
export async function refusal(promise: Promise<unknown>): Promise<Refusal | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    const e = err as Partial<SmurgError>;
    const reason = e.detail?.['reason'];
    return {
      code: e.code ?? 'unknown',
      message: e.message ?? '',
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(e.text?.id === undefined ? {} : { id: e.text.id }),
      ...(e.detail === undefined ? {} : { detail: e.detail }),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The audit log, as the host's console reads it
// ---------------------------------------------------------------------------------------------------------------------

/** The audit entries of some actions (none named: all), oldest first, read page by page through `admin.audit.query`. */
export async function audited(host: Connection, ...actions: string[]): Promise<AuditEntry[]> {
  const all: AuditEntry[] = [];
  let before: number | undefined;
  for (;;) {
    // `at` is strictly increasing within one log, so `before` is an exact cursor.
    const { entries } = await host.request('admin.audit.query', { limit: 500, ...(before === undefined ? {} : { before }) });
    all.push(...entries);
    if (entries.length < 500) break;
    before = entries.at(-1)?.at;
  }
  return all.filter((entry) => actions.length === 0 || actions.includes(entry.action)).reverse();
}

// ---------------------------------------------------------------------------------------------------------------------
// Waiting for what a member receives (never for a sleep)
// ---------------------------------------------------------------------------------------------------------------------

const WAIT_MS = 30_000;

export const kinds = (events: readonly ConversationEvent[]): string[] => events.map((event) => (event.kind === 'card' ? `card:${event.card}` : event.kind));

/** Waits until the member's inbox (as the daemon lists it) holds an item that fits, and returns it. */
export async function inboxItem(who: Member, fits: (item: InboxItem) => boolean, what: string, timeoutMs = WAIT_MS): Promise<InboxItem> {
  let found: InboxItem | undefined;
  await waitUntil(
    async () => {
      found = (await who.inbox()).find(fits);
      return found !== undefined;
    },
    timeoutMs,
    `${what} in ${who.name}'s inbox`,
  );
  return found as InboxItem;
}

/** Waits until the member's inbox holds no item that fits. */
export async function inboxWithout(who: Member, fits: (item: InboxItem) => boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
  await waitUntil(async () => !(await who.inbox()).some(fits), timeoutMs, `${what} to leave ${who.name}'s inbox`);
}

/** Waits until the member holds an event of the session that fits, and returns the first one. */
export async function eventOf<E extends ConversationEvent = ConversationEvent>(who: Member, sessionId: string, fits: (event: ConversationEvent) => boolean, what: string, timeoutMs = WAIT_MS): Promise<E> {
  await waitUntil(() => who.events(sessionId).some(fits), timeoutMs, `${what} at ${who.name}`);
  return who.events(sessionId).find(fits) as E;
}

/** Waits until the member holds a permission card in a state that fits, and returns it. */
export async function permissionAt(who: Member, fits: (request: PermissionRequest) => boolean, what: string, timeoutMs = WAIT_MS): Promise<PermissionRequest> {
  await waitUntil(() => who.permissions().some(fits), timeoutMs, `${what} at ${who.name}`);
  return who.permissions().findLast(fits) as PermissionRequest;
}

/** Waits until the member holds a question card in a state that fits, and returns it. */
export async function questionAt(who: Member, fits: (question: Question) => boolean, what: string, timeoutMs = WAIT_MS): Promise<Question> {
  await waitUntil(() => who.questions().some(fits), timeoutMs, `${what} at ${who.name}`);
  return who.questions().findLast(fits) as Question;
}

/** Waits until the member holds a suggestion card in a state that fits, and returns it. */
export async function suggestionAt(who: Member, fits: (suggestion: Suggestion) => boolean, what: string, timeoutMs = WAIT_MS): Promise<Suggestion> {
  await waitUntil(() => who.suggestions().some(fits), timeoutMs, `${what} at ${who.name}`);
  return who.suggestions().findLast(fits) as Suggestion;
}

/** Waits until `count` turns of the session have finished in what the member holds. */
export async function turnsFinished(who: Member, sessionId: string, count: number, timeoutMs = WAIT_MS): Promise<void> {
  await waitUntil(() => who.events(sessionId).filter((event) => event.kind === 'turn.finished').length >= count, timeoutMs, `turn ${count} of the session to finish at ${who.name}`);
}

/** Waits until the session, as the member holds it, has this status. */
export async function statusIs(who: Member, sessionId: string, status: SessionInfo['status'], timeoutMs = WAIT_MS): Promise<void> {
  await waitUntil(() => who.session(sessionId)?.status === status, timeoutMs, `the session to be ${status}, as ${who.name} is told (it is ${String(who.session(sessionId)?.status)})`);
}

/**
 * Waits until a new agent session's first process is up: it was told `starting`, and is something else now. (The
 * first state of a session says `idle`: it has no process yet; a message sent then is queued until the process is ready.)
 */
export async function sessionReady(who: Member, sessionId: string, timeoutMs = WAIT_MS): Promise<void> {
  await waitUntil(
    () => {
      const told = who.got('session.state').filter((update) => update.session.id === sessionId).map((update) => update.session.status);
      const at = told.indexOf('starting');
      return at !== -1 && told.slice(at).some((status) => status !== 'starting');
    },
    timeoutMs,
    `the first process of the session to be ready, as ${who.name} is told`,
  );
}

export async function topicIs(who: Member, topicId: string, fits: (topic: Topic) => boolean, what: string, timeoutMs = WAIT_MS): Promise<Topic> {
  await waitUntil(
    () => {
      const topic = who.topic(topicId);
      return topic !== undefined && fits(topic);
    },
    timeoutMs,
    `${what}, as ${who.name} is told`,
  );
  return who.topic(topicId) as Topic;
}

export async function planIs(who: Member, topicId: string, fits: (plan: PlanInfo) => boolean, what: string, timeoutMs = WAIT_MS): Promise<PlanInfo> {
  await waitUntil(
    () => {
      const plan = who.plan(topicId);
      return plan !== undefined && fits(plan);
    },
    timeoutMs,
    `${what}, as ${who.name} is told`,
  );
  return who.plan(topicId) as PlanInfo;
}

export const itemOf = (plan: PlanInfo | null | undefined, id: string): PlanInfo['items'][number] | undefined => plan?.items.find((item) => item.id === id);

/** An agent session of a list reply (a terminal is not one). */
export const agentSessions = (sessions: readonly SessionInfo[]): AgentSession[] => sessions.filter((session): session is AgentSession => session.kind === 'agent');

// ---------------------------------------------------------------------------------------------------------------------
// What the agents were given (the stand-in's echo)
// ---------------------------------------------------------------------------------------------------------------------

interface Echoing {
  echoed(): Promise<{ readonly kind: 'argv' | 'settings' | 'role-prompt' | 'stdin'; readonly session: string | null; readonly value: unknown }[]>;
}

function textOfUserLine(value: unknown): string | null {
  const line = value as { type?: string; message?: { content?: unknown } };
  if (line.type !== 'user') return null;
  const content = line.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part: { text?: string }) => part.text ?? '').join('');
  return null;
}

/** Every message the agent of one session was sent (header line and body), in order. */
export async function told(claude: Echoing, sessionId: string): Promise<string[]> {
  return (await claude.echoed()).filter((entry) => entry.kind === 'stdin' && entry.session === sessionId).flatMap((entry) => {
    const text = textOfUserLine(entry.value);
    return text === null ? [] : [text];
  });
}

/** Everything any agent process received so far (arguments, settings, role prompts, every line on its stdin), as one text. */
export async function everythingAgentsReceived(claude: Echoing): Promise<string> {
  return (await claude.echoed()).map((entry) => JSON.stringify(entry.value)).join('\n');
}

/** How many agent processes were started so far (one `argv` entry each). */
export async function launches(claude: Echoing, sessionId?: string): Promise<number> {
  return (await claude.echoed()).filter((entry) => entry.kind === 'argv' && (sessionId === undefined || entry.session === sessionId)).length;
}
