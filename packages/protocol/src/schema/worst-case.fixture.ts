// Test fixture: the LARGEST sample of every protocol 4 message, for worst-case.test.ts. A sample is built at the
// schema's own maxima (arrays at their maximum length, character-limited strings at their maximum length in
// three-byte characters, byte-limited strings at their byte limit), EXCEPT where the registry names a size rule: then
// the daemon bounds the message and the sample is the largest one that rule lets through.
//
//   page   events and cards together at most EVENTS_PAGE_MAX_BYTES (at least one card for session.cards.get)
//   batch  events at most EVENTS_BATCH_MAX_BYTES (at least one event)
//   list   entries at most LIST_REPLY_MAX_BYTES (at least one entry), then `hasMore`
import { encodedSize, takeWithinBytes } from '../codec.ts';
import * as L from './limits.ts';
import { SHARED_DIRS_MAX } from './limits.ts';
import type { MessageType } from './registry.ts';

const T = 1_727_000_000_000;
const HASH = 'f'.repeat(64);
/** A three-byte character (UTF-8) that is one UTF-16 unit: the worst case of a character-limited string. */
const WIDE = '結';
const wide = (chars: number): string => WIDE.repeat(chars);
/** `bytes` of UTF-8, mostly three-byte characters. */
const big = (bytes: number): string => WIDE.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3);
const many = <V>(count: number, make: (index: number) => V): V[] => Array.from({ length: count }, (_, index) => make(index));
const id = (prefix: string, index = 0): string => `${prefix}_${String(index).padStart(60 - prefix.length, '0')}`.slice(0, 64);

const USER_ID = `google:${'u'.repeat(255)}`;
const user = { userId: USER_ID, displayName: wide(256) };
const actor = { kind: 'agent', sessionId: id('s'), ownerUserId: USER_ID, displayName: wide(256) };
const PATH = `${wide(255)}/`.repeat(15) + wide(255); // 4,095 UTF-16 units, 16 segments
const file = { root: { kind: 'worktree', worktreeId: id('wt') }, path: PATH };
const root = file.root;
const itemId = (index: number): string => `i${String(index).padStart(39, '0')}`;
/** The largest reference the bound lets through: its JSON is exactly WIRE_TEXT_REF_MAX_CHARS characters, all three-byte. */
const ref = ((): { id: string; params: Record<string, string> } => {
  const empty = { id: 'plan.error.cycle', params: { a: '', b: '' } };
  const fill = L.WIRE_TEXT_REF_MAX_CHARS - JSON.stringify(empty).length;
  return { id: empty.id, params: { a: wide(Math.min(1000, fill)), b: wide(Math.max(0, fill - 1000)) } };
})();
const wireText = { text: ref, fallback: wide(L.FALLBACK_TEXT_MAX_CHARS) };

const rule = (index: number): unknown => ({ id: id('rl', index), tool: 'WebFetch', pattern: `domain:${'a'.repeat(L.RULE_PATTERN_MAX_CHARS - 7)}`, scope: 'topic', addedBy: user, addedAt: T });

export const worstSession = {
  id: id('s'),
  kind: 'agent',
  purpose: 'item',
  topicId: id('tp'),
  itemId: itemId(0),
  attempt: 9,
  topicName: wide(L.TOPIC_NAME_MAX_CHARS),
  item: { number: 9e6, title: wide(L.ITEM_TITLE_MAX_CHARS) },
  openedBy: user,
  responsible: user,
  title: wide(256),
  root,
  branch: wide(256),
  status: 'waiting-permission',
  waitingSince: T,
  runningSince: T,
  doing: 'compacting',
  retryHostOnly: true,
  permissionMode: 'ask-commands',
  modeFixed: false,
  ruleCount: 100,
  login: 'logged-out',
  claudeVersion: '9'.repeat(32),
  projectSettings: 'ignored',
  noteworthyAt: T,
  lastSeq: 9_999_999,
  lastActivityAt: T,
  createdAt: T,
  endedAt: T,
  endReason: 'worktree-removed',
  endedBy: user,
};
const agentSession = worstSession;

// ---- events --------------------------------------------------------------------------------------------------------
const stamp = (seq: number): { seq: number; at: number } => ({ seq, at: T });
const largestEvents = (seq: number): unknown[] => [
  { ...stamp(seq), kind: 'tool.finished', turnId: id('t'), toolUseId: id('tu'), ok: true, result: { additions: 9e6, deletions: 9e6, exitCode: 255, matches: 9e6, durationMs: 9e9, body: { kind: 'diff', text: big(L.EVENT_TEXT_MAX_BYTES), truncated: true } } },
  { ...stamp(seq), kind: 'text', turnId: id('t'), blockId: id('b'), text: big(L.EVENT_TEXT_MAX_BYTES), aborted: true, truncated: true, parentToolUseId: id('tu') },
  { ...stamp(seq), kind: 'message', messageId: id('m'), from: { ...user, role: 'editor' }, text: wide(L.MESSAGE_TEXT_MAX_CHARS), cleaned: true, origin: 'follow-up', suggestion: { id: id('sg'), acceptedBy: user, modified: true }, mentions: many(L.MENTIONS_PER_TEXT_MAX, () => USER_ID) },
  { ...stamp(seq), kind: 'tool.started', turnId: id('t'), toolUseId: id('tu'), tool: { name: 'x'.repeat(64), verb: 'run', target: big(L.COMMAND_MAX_BYTES), file, outside: true }, parentToolUseId: id('tu') },
  { ...stamp(seq), kind: 'smurg', messageId: id('m'), purpose: 'restart-discussion', by: user, text: big(L.SMURG_TEXT_MAX_BYTES) },
  { ...stamp(seq), kind: 'notice', level: 'warning', ...wireText, action: 'restart-agent' },
];
/** The largest single event. */
export const worstEvent = largestEvents(1).reduce((a, b) => (encodedSize(a) >= encodedSize(b) ? a : b));

// ---- cards ---------------------------------------------------------------------------------------------------------
export const worstQuestion = {
  id: id('q'),
  sessionId: id('s'),
  askedAt: T,
  status: 'answered',
  parts: many(L.QUESTION_PARTS_MAX, (i) => ({
    header: wide(L.QUESTION_HEADER_MAX_CHARS),
    // the texts of the parts are distinct
    text: wide(L.QUESTION_TEXT_MAX_CHARS - 1) + String(i),
    multi: true,
    options: many(L.QUESTION_OPTIONS_MAX, () => ({ label: wide(L.OPTION_LABEL_MAX_CHARS), description: wide(L.OPTION_DESCRIPTION_MAX_CHARS) })),
  })),
  votes: many(L.QUESTION_VOTERS_MAX * L.QUESTION_PARTS_MAX, (i) => ({ ...user, part: i % L.QUESTION_PARTS_MAX, other: wide(L.OTHER_ANSWER_MAX_CHARS), at: T })),
  comments: many(L.QUESTION_COMMENTS_MAX, (i) => ({ id: id('cm', i), from: user, text: wide(L.COMMENT_MAX_CHARS), at: T, mentions: many(L.MENTIONS_PER_TEXT_MAX, () => USER_ID) })),
  eligible: 1000,
  decider: user,
  deciderSeenAt: T,
  escalatedAt: T,
  previous: { askedAt: T, tally: many(L.QUESTION_PARTS_MAX, () => many(L.QUESTION_OPTIONS_MAX + 1, () => 1000)) },
  answer: {
    parts: many(L.QUESTION_PARTS_MAX, () => ({ other: wide(L.OTHER_ANSWER_MAX_CHARS), otherBy: user })),
    note: wide(L.ANSWER_NOTE_MAX_CHARS),
    by: user,
    onBehalfOf: user,
    at: T,
    tally: many(L.QUESTION_PARTS_MAX, () => many(L.QUESTION_OPTIONS_MAX + 1, () => 1000)),
  },
  withdrawn: { reason: 'restarted', by: user, at: T },
};
export const worstPermission = {
  id: id('pr'),
  sessionId: id('s'),
  askedAt: T,
  status: 'denied',
  tool: 'x'.repeat(L.TOOL_NAME_MAX_CHARS),
  what: 'other',
  command: big(L.COMMAND_MAX_BYTES),
  file,
  change: { text: big(L.EVENT_TEXT_MAX_BYTES) },
  outside: true,
  path: big(L.COMMAND_MAX_BYTES),
  url: wide(L.URL_MAX_CHARS),
  input: big(L.PERMISSION_INPUT_MAX_BYTES),
  root,
  reason: wide(L.PERMISSION_REASON_MAX_CHARS),
  gate: 'may-reach-settings-script',
  hostOnly: true,
  alwaysRule: { tool: 'WebFetch', pattern: `domain:${'a'.repeat(L.RULE_PATTERN_MAX_CHARS - 7)}` },
  noAlways: 'fetches-code',
  escalatedAt: T,
  decision: { by: user, at: T, always: 'session', message: wide(L.DENY_MESSAGE_MAX_CHARS) },
  withdrawn: { reason: 'restarted', at: T },
};
export const worstSuggestion = {
  id: id('sg'),
  sessionId: id('s'),
  author: user,
  text: wide(L.SUGGESTION_TEXT_MAX_CHARS),
  cleaned: true,
  origin: 'follow-up',
  topicId: id('tp'),
  itemId: itemId(0),
  mentions: many(L.MENTIONS_PER_TEXT_MAX, () => USER_ID),
  source: { file, startLine: 9e9, endLine: 9e9 },
  status: 'accepted-modified',
  createdAt: T,
  resolvedAt: T,
  finalText: wide(L.SUGGESTION_TEXT_MAX_CHARS),
  decidedBy: user,
  rejectReason: wide(L.REASON_MAX_CHARS),
  closedReason: 'topic-archived',
};
const moreCards = many(L.CARD_REFS_MAX, (i) => ({ kind: 'permission', id: id('pr', i) }));

/** A page filled by the page rule: events first, then cards in what is left (`atLeastOneCard`: session.cards.get). */
function page(atLeastOneCard: boolean): { events: unknown[]; questions: unknown[]; permissions: unknown[]; suggestions: unknown[]; moreCards: unknown[] } {
  const candidates = many(L.EVENTS_PAGE_MAX, (i) => ({ ...(worstEvent as object), seq: i + 1 }));
  const events = atLeastOneCard ? { taken: [] as unknown[], bytes: 0 } : takeWithinBytes(candidates, L.EVENTS_PAGE_MAX_BYTES, { atLeastOne: true });
  const cards = takeWithinBytes([worstQuestion, worstQuestion, worstPermission, worstSuggestion], Math.max(0, L.EVENTS_PAGE_MAX_BYTES - events.bytes), { atLeastOne: atLeastOneCard });
  return {
    events: events.taken,
    questions: cards.taken.filter((card) => card === worstQuestion),
    permissions: cards.taken.filter((card) => card === worstPermission),
    suggestions: cards.taken.filter((card) => card === worstSuggestion),
    moreCards,
  };
}

// ---- topics, plans, reports ------------------------------------------------------------------------------------------
const reportSummary = {
  version: 9e6,
  writtenAt: T,
  outcome: 'blocked',
  state: 'changed-after-review',
  reviewers: many(L.REVIEWERS_MAX, () => user),
  escalatedAt: T,
  review: { by: user, at: T, version: 9e6, insteadOf: user },
  checks: { passed: 9e6, notVerified: 9e6 },
  error: { ...wireText, line: 9e6 },
};
export const worstTopic = {
  id: id('tp'),
  name: wide(L.TOPIC_NAME_MAX_CHARS),
  slug: 'a'.repeat(L.TOPIC_SLUG_MAX_CHARS),
  phase: 'executing',
  archived: true,
  versioned: true,
  createdBy: user,
  createdAt: T,
  discussionSessionId: id('s'),
  discussion: 'lost',
  spec: { exists: true, changedAt: T, changedBy: actor, lastAgentChange: { sessionId: id('s'), seq: 9e6, at: T, askedBy: user } },
  handEdits: { spec: many(L.HAND_EDITS_MAX, () => ({ by: user, at: T })), plan: many(L.HAND_EDITS_MAX, () => ({ by: user, at: T })) },
  plan: { exists: true, valid: false, error: { ...wireText, line: 9e6 }, generating: true, stale: true, mode: 'everyone', paused: true, changedAt: T, changedBy: actor, items: 80, started: 80, reviewed: 80, merged: 80 },
  rules: many(L.REMEMBERED_RULES_MAX, rule),
};
const workItem = (index: number): unknown => ({
  id: itemId(index),
  number: index + 1,
  title: wide(L.ITEM_TITLE_MAX_CHARS),
  summary: wide(L.ITEM_SUMMARY_MAX_CHARS),
  dependsOn: many(L.PLAN_ITEMS_MAX, itemId),
  size: 'l',
  touches: many(L.ITEM_TOUCHES_MAX, () => wide(L.ITEM_GLOB_MAX_CHARS)),
  inPlan: true,
  state: 'reviewed',
  stalledBy: 'restart',
  armed: true,
  disarmed: 'starter-removed',
  waitsFor: many(L.PLAN_ITEMS_MAX, itemId),
  responsible: { ...user, source: 'chosen' },
  startedBy: user,
  sessionId: id('s'),
  worktreeId: id('wt'),
  attempt: 9e6,
  startError: wireText,
  changesAsked: { by: user, at: T },
  report: reportSummary,
  merge: { requestId: id('mr'), status: 'conflict', ready: true },
});
export const worstPlan = {
  topicId: id('tp'),
  revision: 9e6,
  specHash: HASH,
  planHash: HASH,
  mode: 'everyone',
  paused: true,
  items: many(L.PLAN_INFO_ITEMS_MAX, workItem),
  split: { source: 'agent', reason: wide(L.SPLIT_REASON_MAX_CHARS) },
  warnings: many(L.PLAN_WARNINGS_MAX, () => wireText),
  waitingFor: many(L.PLAN_WAITING_FOR_MAX, () => ({ user, questions: 9e6, permissions: 9e6, reports: 9e6, since: T })),
  slots: { inUse: 32, max: 32, waitingForPeople: 32 },
};
const followUp = { text: big(L.REPORT_FOLLOW_UP_TEXT_MAX_BYTES), truncated: true };
export const worstReport = {
  ...reportSummary,
  topicId: id('tp'),
  itemId: itemId(0),
  file,
  sections: {
    done: big(L.REPORT_SECTION_MAX_BYTES),
    why: big(L.REPORT_SECTION_MAX_BYTES),
    verified: many(L.REPORT_CHECKS_MAX, () => ({ text: wide(L.REPORT_CHECK_TEXT_MAX_CHARS), passed: false, note: wide(L.REPORT_CHECK_TEXT_MAX_CHARS) })),
    watchOut: big(L.REPORT_SECTION_MAX_BYTES),
    followUps: big(L.REPORT_SECTION_MAX_BYTES),
  },
  changes: { requestId: id('mr'), files: 9e6, additions: 9e6, deletions: 9e6, byHand: many(L.REPORT_BY_HAND_MAX, () => ({ path: PATH, by: many(L.REVIEWERS_MAX, () => user) })) },
  noChanges: 'conflict-markers',
  questions: many(L.REPORT_FOLLOW_UPS_MAX, (i) => ({ ...followUp, id: id('m', i), from: user, at: T, answer: { ...followUp, at: T } })),
};
export const worstPreflight = {
  planRevision: 9e6,
  specHash: HASH,
  planHash: HASH,
  startsNow: many(L.PLAN_INFO_ITEMS_MAX, itemId),
  waits: many(L.PLAN_INFO_ITEMS_MAX, (i) => ({ itemId: itemId(i), for: many(L.PLAN_ITEMS_MAX, itemId) })),
  alreadyStarted: many(L.PLAN_INFO_ITEMS_MAX, itemId),
  responsible: many(L.PLAN_INFO_ITEMS_MAX, (i) => ({ itemId: itemId(i), user, online: true })),
  youDecide: 80,
  commit: { needed: true, branch: wide(256), as: user, files: [PATH, PATH], alsoInFolder: many(L.PREFLIGHT_ALSO_IN_FOLDER_MAX, () => PATH) },
  handEdits: worstTopic.handEdits,
  invisibleCharacters: ['spec', 'plan'],
  stale: true,
  openQuestion: true,
  specOpenQuestions: 9e6,
  editingNow: many(L.PREFLIGHT_EDITING_NOW_MAX, () => user),
  projectSettings: 'ignored',
  rules: many(L.REMEMBERED_RULES_MAX, rule),
  sharedDirs: many(SHARED_DIRS_MAX, () => PATH),
  blockers: many(L.PREFLIGHT_BLOCKERS_MAX, () => wireText),
};

// ---- inbox ---------------------------------------------------------------------------------------------------------
/** The kind with the most fields (INBOX_KIND_FIELDS): a question of a work item's session, escalated. */
export const worstInboxItem = (index: number): unknown => ({
  key: `question:${'k'.repeat(L.INBOX_KEY_MAX_CHARS - 15)}${String(index).padStart(6, '0')}`,
  kind: 'question',
  at: T,
  unread: true,
  waiting: true,
  topicId: id('tp'),
  sessionId: id('s'),
  itemId: itemId(0),
  item: { number: 9e6, title: wide(L.ITEM_TITLE_MAX_CHARS) },
  target: { kind: 'report', topicId: id('tp'), itemId: itemId(0) },
  anchor: { cardId: id('q'), seq: 9e6 },
  excerpt: wide(L.INBOX_EXCERPT_MAX_CHARS),
  voted: 9e6,
  eligible: 9e6,
  allVoted: true,
  leading: wide(L.OPTION_LABEL_MAX_CHARS),
  waitsFor: user,
  waitsForOffline: true,
  escalated: true,
  alsoFor: many(L.INBOX_ALSO_FOR_MAX, () => user),
  alsoForMore: 9e6,
});

// ---- admin ---------------------------------------------------------------------------------------------------------
const configFile = {
  path: PATH,
  hash: HASH,
  decision: 'trust',
  changed: true,
  text: big(L.CLAUDE_CONFIG_TEXT_MAX_BYTES),
  runs: many(L.CLAUDE_CONFIG_LIST_MAX, () => wide(L.CLAUDE_CONFIG_ENTRY_MAX_CHARS)),
  permissions: many(L.CLAUDE_CONFIG_LIST_MAX, () => wide(L.CLAUDE_CONFIG_ENTRY_MAX_CHARS)),
  env: many(L.CLAUDE_CONFIG_LIST_MAX, () => ({ name: wide(L.SHORT_TEXT_MAX_CHARS), flagged: true, programs: true })),
  otherKeys: many(L.CLAUDE_CONFIG_LIST_MAX, () => wide(L.SHORT_TEXT_MAX_CHARS)),
  scripts: many(L.CLAUDE_CONFIG_SCRIPTS_MAX, () => ({ path: PATH, hash: HASH, absent: true })),
  needsAck: ['credentials', 'allows-tools', 'incomplete'],
  cut: { omitted: 9e6, shortened: 9e6 },
  unfollowed: 9e6,
};
export const worstConfigRoot = { root, state: 'ignored', files: many(L.CLAUDE_CONFIG_FILES_MAX, () => configFile) };

function cardsOnly(full: ReturnType<typeof page>): Omit<ReturnType<typeof page>, 'events'> {
  const { events: _events, ...cards } = full;
  return cards;
}

/** Fills a list reply by the list rule. */
function list<V>(count: number, make: (index: number) => V): V[] {
  return takeWithinBytes(many(count, make), L.LIST_REPLY_MAX_BYTES, { atLeastOne: true }).taken;
}

const itemPayload = { topicId: id('tp'), itemId: itemId(0) };
const hostState = { account: { state: 'usage-limit', resetsAt: T, sessions: 9e6 }, mainProjectSettings: 'ignored' };
const text = wide(L.MESSAGE_TEXT_MAX_CHARS);
const mentions = many(L.MENTIONS_PER_TEXT_MAX, () => USER_ID);
const messageOrSuggestion = { suggestion: worstSuggestion };

export type WorstCase = { readonly payload: unknown; readonly result?: unknown };

/** The protocol 4 messages (ARCHITECTURE §5.5 agent part, §5.9–§5.11, the §5.8 additions, and the reshaped §5.5–§5.7 ones). */
export const WORST_CASES: Partial<Record<MessageType, WorstCase>> = {
  'session.create': { payload: { kind: 'agent', workspace: { mode: 'worktree', worktreeId: id('wt') }, title: wide(256), firstMessage: text }, result: { session: agentSession } },
  'session.list': { payload: { topicId: id('tp'), after: id('s') }, result: { sessions: list(L.LIST_MAX_ITEMS, () => agentSession), hasMore: true } },
  'session.state': { payload: { session: agentSession } },
  'session.host.get': { payload: {}, result: hostState },
  'session.host': { payload: hostState },
  'session.rename': { payload: { sessionId: id('s'), title: wide(256) }, result: { session: agentSession } },
  'session.watch': {
    payload: { sessionId: id('s'), haveSeq: 9e6, live: true },
    result: { session: agentSession, ...page(false), firstSeq: 1, nextSeq: 9e6, hasEarlier: true, hasMore: true, streaming: many(L.STREAMING_BLOCKS_MAX, () => ({ turnId: id('t'), blockId: id('b'), text: big(L.EVENT_TEXT_MAX_BYTES), parentToolUseId: id('tu') })) },
  },
  'session.unwatch': { payload: { sessionId: id('s') } },
  'session.history': { payload: { sessionId: id('s'), beforeSeq: 9e6, limit: L.EVENTS_PAGE_MAX }, result: { ...page(false), hasEarlier: true, hasMore: true } },
  'session.cards.get': { payload: { sessionId: id('s'), cards: many(L.CARDS_GET_MAX, (i) => ({ kind: 'question', id: id('q', i) })) }, result: cardsOnly(page(true)) },
  'session.events': { payload: { sessionId: id('s'), events: takeWithinBytes(many(L.EVENTS_BATCH_MAX, (i) => ({ ...(worstEvent as object), seq: i + 1 })), L.EVENTS_BATCH_MAX_BYTES, { atLeastOne: true }).taken } },
  'session.delta': { payload: { sessionId: id('s'), turnId: id('t'), blockId: id('b'), offset: 9e9, text: big(L.DELTA_TEXT_MAX_BYTES), parentToolUseId: id('tu') } },
  'session.message.send': { payload: { sessionId: id('s'), text, mentions, origin: 'selection' }, result: { messageId: id('m') } },
  'session.interrupt': { payload: { sessionId: id('s') }, result: {} },
  'session.retry': { payload: { sessionId: id('s') }, result: { session: agentSession } },
  'session.restart': { payload: { sessionId: id('s') }, result: { session: agentSession } },
  'session.responsible.set': { payload: { sessionId: id('s'), userId: USER_ID }, result: { session: agentSession } },
  'session.mode.set': { payload: { sessionId: id('s'), mode: 'ask-commands' }, result: { session: agentSession } },
  'session.rules.get': {
    payload: { sessionId: id('s') },
    result: { rules: many(2 * L.REMEMBERED_RULES_MAX, rule), host: { state: 'applied', rules: many(L.HOST_RULES_MAX, () => wide(L.HOST_RULE_MAX_CHARS)) } },
  },
  'session.rule.remove': { payload: { sessionId: id('s'), ruleId: id('rl') }, result: { session: agentSession } },
  'question.vote': { payload: { questionId: id('q'), part: 3, other: wide(L.OTHER_ANSWER_MAX_CHARS) }, result: {} },
  'question.comment': { payload: { questionId: id('q'), text: wide(L.COMMENT_MAX_CHARS), mentions }, result: { commentId: id('cm') } },
  'question.submit': {
    payload: { questionId: id('q'), answers: many(L.QUESTION_PARTS_MAX, () => ({ other: wide(L.OTHER_ANSWER_MAX_CHARS), otherBy: USER_ID })), note: wide(L.ANSWER_NOTE_MAX_CHARS) },
    result: { question: worstQuestion },
  },
  'question.remind': { payload: { questionId: id('q') }, result: {} },
  'question.seen': { payload: { questionId: id('q') } },
  'question.changed': { payload: { sessionId: id('s'), questionId: id('q'), vote: worstQuestion.votes[0], voteRemoved: { userId: USER_ID, part: 3 }, comment: worstQuestion.comments[0], eligible: 9e6, deciderSeenAt: T } },
  'question.updated': { payload: { question: worstQuestion } },
  'permission.decide': { payload: { requestId: id('pr'), decision: 'deny', message: wide(L.DENY_MESSAGE_MAX_CHARS) }, result: { request: worstPermission } },
  'permission.updated': { payload: { request: worstPermission } },
  'suggest.create': { payload: { sessionId: id('s'), text: wide(L.SUGGESTION_TEXT_MAX_CHARS), source: { file, startLine: 1, endLine: 9e9 }, mentions }, result: { suggestion: worstSuggestion } },
  'suggest.list': { payload: { sessionId: id('s'), after: id('sg') }, result: { suggestions: list(L.LIST_MAX_ITEMS, () => worstSuggestion), hasMore: true } },
  'suggest.updated': { payload: { suggestion: worstSuggestion } },
  'topic.create': { payload: { name: wide(L.TOPIC_NAME_MAX_CHARS), slug: 'a'.repeat(L.TOPIC_SLUG_MAX_CHARS), firstMessage: text }, result: { topic: worstTopic, session: agentSession } },
  'topic.list': { payload: { archived: true, after: id('tp') }, result: { topics: list(L.TOPICS_MAX, () => worstTopic), hasMore: true } },
  'topic.updated': { payload: { topic: worstTopic } },
  'topic.removed': { payload: { topicId: id('tp') } },
  'topic.rename': { payload: { topicId: id('tp'), name: wide(L.TOPIC_NAME_MAX_CHARS) }, result: { topic: worstTopic } },
  'topic.archive': { payload: { topicId: id('tp'), archived: true, deleteUnmerged: true }, result: { topic: worstTopic } },
  'topic.delete': { payload: { topicId: id('tp') }, result: {} },
  'topic.discussion.restart': { payload: { topicId: id('tp') }, result: { topic: worstTopic, session: agentSession } },
  'topic.revise': { payload: { topicId: id('tp'), target: 'spec', text, quote: { heading: wide(L.QUOTE_HEADING_MAX_CHARS), text: wide(L.QUOTE_TEXT_MAX_CHARS) }, mentions }, result: messageOrSuggestion },
  'topic.spec.request': { payload: { topicId: id('tp') }, result: {} },
  'topic.rule.add': { payload: { topicId: id('tp'), tool: 'WebFetch', pattern: `domain:${'a'.repeat(L.RULE_PATTERN_MAX_CHARS - 7)}` }, result: { topic: worstTopic } },
  'topic.rule.remove': { payload: { topicId: id('tp'), ruleId: id('rl') }, result: { topic: worstTopic } },
  'plan.generate': { payload: { topicId: id('tp') }, result: {} },
  'plan.get': { payload: { topicId: id('tp') }, result: { plan: worstPlan } },
  'plan.updated': { payload: { plan: worstPlan } },
  'plan.mode.set': { payload: { topicId: id('tp'), mode: 'everyone' }, result: { plan: worstPlan } },
  'plan.assign': { payload: { ...itemPayload, userId: USER_ID }, result: { plan: worstPlan } },
  'plan.suggest': { payload: { topicId: id('tp') }, result: { plan: worstPlan } },
  'plan.preflight': { payload: { topicId: id('tp'), itemIds: many(L.PLAN_INFO_ITEMS_MAX, itemId) }, result: { preflight: worstPreflight } },
  'plan.start': { payload: { topicId: id('tp'), itemIds: many(L.PLAN_INFO_ITEMS_MAX, itemId), planRevision: 9e6, specHash: HASH, planHash: HASH }, result: { plan: worstPlan } },
  'plan.changes': { payload: { topicId: id('tp') }, result: { files: [{ target: 'spec', diff: big(L.PLAN_CHANGES_DIFF_MAX_BYTES), truncated: true }, { target: 'plan', diff: big(L.PLAN_CHANGES_DIFF_MAX_BYTES), truncated: true }] } },
  'plan.resume': { payload: { topicId: id('tp') }, result: { plan: worstPlan } },
  'plan.item.retry': { payload: itemPayload, result: { plan: worstPlan } },
  'plan.item.continue': { payload: itemPayload, result: {} },
  'plan.item.resolve': { payload: itemPayload, result: {} },
  'report.get': { payload: itemPayload, result: { report: worstReport } },
  'report.updated': { payload: { ...itemPayload, report: reportSummary } },
  'report.followUp': { payload: { ...itemPayload, text, mentions }, result: messageOrSuggestion },
  'report.review': { payload: { ...itemPayload, version: 9e6, acknowledgeUnfinished: true }, result: { report: reportSummary } },
  'inbox.list': { payload: { after: `mention:${'k'.repeat(L.INBOX_KEY_MAX_CHARS - 8)}` }, result: { items: list(L.INBOX_ITEMS_MAX, worstInboxItem), hasMore: true } },
  'inbox.changed': { payload: { upsert: list(L.INBOX_ITEMS_MAX, worstInboxItem), remove: many(L.INBOX_ITEMS_MAX, (i) => `mention:${'k'.repeat(L.INBOX_KEY_MAX_CHARS - 14)}${String(i).padStart(6, '0')}`) } },
  'inbox.seen': { payload: { keys: many(L.INBOX_SEEN_KEYS_MAX, (i) => `mention:${'k'.repeat(L.INBOX_KEY_MAX_CHARS - 14)}${String(i).padStart(6, '0')}`) } },
  'inbox.dismiss': { payload: { key: `result:${'k'.repeat(L.INBOX_KEY_MAX_CHARS - 7)}` }, result: {} },
  'admin.claudeConfig.get': { payload: { after: wide(256) }, result: { roots: list(L.LIST_MAX_ITEMS, () => worstConfigRoot), hasMore: true } },
  'admin.claudeConfig.decide': { payload: { root, files: many(L.CLAUDE_CONFIG_FILES_MAX, () => ({ path: PATH, hash: HASH })), decision: 'trust', acknowledged: ['credentials', 'allows-tools', 'incomplete'] }, result: {} },
  'admin.hostRules.get': { payload: {}, result: { rules: many(L.HOST_RULES_MAX, () => ({ rule: wide(L.HOST_RULE_MAX_CHARS), source: 'managed' })), seen: true } },
  'admin.hostRules.seen': { payload: {}, result: {} },
  'admin.transcript.redact': { payload: { sessionId: id('s'), seq: 9e6 }, result: {} },
};
