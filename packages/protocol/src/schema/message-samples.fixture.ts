// Test fixture (not exported by any entry point): at least one valid and one invalid payload for every message type,
// and the same for the `.ok` result of every request. Typed as Record<MessageType, …> so adding a type to the
// registry without samples is a compile error; registry.test.ts and codec.test.ts run every sample.
import { MAX_CHUNK_SIZE, UPLOAD_HASHES_PAGE_MAX } from '../constants.ts';
import type { MessageType } from './registry.ts';

export type SampleSet = { readonly valid: readonly unknown[]; readonly invalid: readonly unknown[] };
export type MessageSamples = { readonly payload: SampleSet; readonly result?: SampleSet };

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export const T = 1_727_000_000_000;
export const HOST = 'github:12345';
export const AMY = 'dev:amy';
export const MAIN = { kind: 'main' } as const;
export const WT = { kind: 'worktree', worktreeId: 'wt_1' } as const;
export const FILE = { root: MAIN, path: 'src/app.ts' };
export const WT_FILE = { root: WT, path: 'docs/讀我.md' };
export const HASH = 'a'.repeat(64);
export const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

export const member = { userId: HOST, displayName: 'Ian', role: 'host', color: '#ff8800', online: true, joinedAt: T };
export const guestMember = { userId: AMY, displayName: 'Amy', role: 'editor', color: '#3366cc', online: true, joinedAt: T };
export const entry = { name: 'app.ts', path: 'src/app.ts', kind: 'file', size: 12, mtime: T };
export const disk = {
  totalBytes: 500 * GiB,
  availableBytes: 30 * GiB,
  reserveBytes: 25 * GiB,
  pendingBytes: 0,
  requestedBytes: 10 * GiB,
  freeAfterBytes: 20 * GiB,
  ok: false,
};
export const humanLock = {
  kind: 'human',
  file: FILE,
  holders: [{ userId: AMY, displayName: 'Amy', lastActivityAt: T }],
  acquiredAt: T,
};
export const agentActor = { kind: 'agent', sessionId: 'sess_1', ownerUserId: HOST, displayName: 'Claude (Ian)' };
export const agentLock = {
  kind: 'agent',
  file: FILE,
  sessionId: 'sess_1',
  ownerUserId: HOST,
  agentName: 'Claude (Ian)',
  acquiredAt: T,
  expiresAt: T + 60_000,
};
export const IAN = { userId: HOST, displayName: 'Ian' };
export const AMY_REF = { userId: AMY, displayName: 'Amy' };
/** A terminal session. */
export const session = {
  id: 'sess_1',
  kind: 'terminal',
  openedBy: IAN,
  title: 'shell',
  root: MAIN,
  status: 'running',
  cols: 120,
  rows: 40,
  createdAt: T,
  attached: 1,
};
/** A topic's discussion session. */
export const agentSession = {
  id: 'sess_a',
  kind: 'agent',
  purpose: 'discussion',
  topicId: 'tp_1',
  topicName: 'Checkout 結帳',
  openedBy: IAN,
  responsible: null,
  root: MAIN,
  status: 'idle',
  permissionMode: 'ask-all',
  modeChoice: null,
  modeFixed: true,
  model: null,
  ruleCount: 0,
  login: 'logged-in',
  claudeVersion: '2.1.288',
  projectSettings: 'none',
  noteworthyAt: T,
  lastSeq: 12,
  lastActivityAt: T,
  createdAt: T,
};
/** The execution session of one work item. */
export const itemSession = {
  ...agentSession,
  id: 'sess_i',
  purpose: 'item',
  itemId: 'cart-api',
  attempt: 1,
  item: { number: 1, title: 'Cart API' },
  responsible: AMY_REF,
  root: WT,
  branch: 'smurg/checkout/cart-api',
  status: 'waiting-permission',
  waitingSince: T,
  runningSince: T,
  // Protocol 5: the workspace's auto, and what really runs (the model has no auto mode: smurg's own fallback).
  permissionMode: 'auto',
  modeChoice: null,
  modeInUse: 'ask-commands',
  modeFallback: 'model-no-auto',
  modeFixed: false,
  model: 'haiku',
  modelInUse: 'claude-haiku-4-5-20251001',
  ruleCount: 2,
  projectSettings: 'used',
};
export const suggestion = {
  id: 'sg_1',
  sessionId: 'sess_a',
  author: AMY_REF,
  text: '請幫這個函式加上測試\n\tthanks',
  origin: 'selection',
  source: { file: FILE, startLine: 3, endLine: 9 },
  status: 'pending',
  createdAt: T,
};
export const rule = { id: 'rl_1', tool: 'Bash', pattern: 'pnpm test *', scope: 'topic', addedBy: IAN, addedAt: T };
export const wireText = { text: { id: 'plan.error.missingId', params: { line: 12 } }, fallback: 'Line 12: this work item has no id.' };
export const events = [
  { seq: 1, at: T, kind: 'line', text: { id: 'conversation.started.discussion', params: { name: 'Ian' } }, fallback: 'Ian started the discussion' },
  { seq: 2, at: T, kind: 'message', messageId: 'm_1', from: { ...IAN, role: 'host' }, text: 'Where should the cart live?', origin: 'composer' },
  { seq: 3, at: T, kind: 'delivery', messageId: 'm_1', state: 'started' },
  { seq: 4, at: T, kind: 'turn.started', turnId: 't_1' },
  { seq: 5, at: T, kind: 'text', turnId: 't_1', blockId: 'b_1', text: 'Let me read the code first.' },
  { seq: 6, at: T, kind: 'tool.started', turnId: 't_1', toolUseId: 'toolu_1', tool: { name: 'Read', verb: 'read', target: 'src/app.ts', file: FILE } },
  { seq: 7, at: T, kind: 'tool.finished', turnId: 't_1', toolUseId: 'toolu_1', ok: true, result: { durationMs: 12 } },
  { seq: 8, at: T, kind: 'tool.started', turnId: 't_1', toolUseId: 'toolu_2', tool: { name: 'Bash', verb: 'run', target: 'pnpm test cart' } },
  {
    seq: 9,
    at: T,
    kind: 'tool.finished',
    turnId: 't_1',
    toolUseId: 'toolu_2',
    ok: false,
    result: { exitCode: 1, durationMs: 900, body: { kind: 'output', text: '1 failed', truncated: false } },
  },
  { seq: 10, at: T, kind: 'card', card: 'question', id: 'q_1' },
  { seq: 11, at: T, kind: 'turn.finished', turnId: 't_1', outcome: 'completed', durationMs: 4200 },
  { seq: 12, at: T, kind: 'pointer', target: 'spec', topicId: 'tp_1' },
  { seq: 13, at: T, kind: 'smurg', messageId: 'm_2', purpose: 'generate-plan', by: IAN, text: 'Read specs/checkout/SPEC.md as it is now.' },
  { seq: 14, at: T, kind: 'notice', level: 'warning', text: { id: 'notice.compacted' }, fallback: 'Claude Code shortened the earlier conversation to make room.' },
  {
    seq: 15,
    at: T,
    kind: 'message',
    messageId: 'm_3',
    from: { ...AMY_REF, role: 'editor' },
    text: 'Use the session store',
    cleaned: true,
    origin: 'revise',
    suggestion: { id: 'sg_1', acceptedBy: IAN, modified: false },
    mentions: [HOST],
  },
];
export const question = {
  id: 'q_1',
  sessionId: 'sess_a',
  askedAt: T,
  status: 'open',
  parts: [
    {
      header: 'Cart',
      text: 'Where is the cart kept?',
      multi: false,
      options: [
        { label: 'On the server', description: 'Survives a reload. Recommended.' },
        { label: 'In the browser', description: 'Simpler, lost when the tab closes.' },
      ],
    },
  ],
  votes: [
    { userId: AMY, displayName: 'Amy', part: 0, options: [0], at: T },
    { userId: HOST, displayName: 'Ian', part: 0, other: 'Both, behind a flag', at: T },
  ],
  comments: [{ id: 'cm_1', from: AMY_REF, text: '@Ian the server, please', at: T, mentions: [HOST] }],
  eligible: 3,
  decider: IAN,
};
export const answeredQuestion = {
  ...question,
  status: 'answered',
  deciderSeenAt: T,
  escalatedAt: T,
  answer: { parts: [{ options: [0] }], note: 'Amy asked for the server', by: AMY_REF, onBehalfOf: IAN, at: T, tally: [[1, 0, 1]] },
};
export const permission = {
  id: 'pr_1',
  sessionId: 'sess_i',
  askedAt: T,
  status: 'open',
  tool: 'Bash',
  what: 'command',
  command: 'pnpm test cart',
  root: WT,
  reason: 'This command requires approval',
  hostOnly: false,
  alwaysRule: { tool: 'Bash', pattern: 'pnpm test *' },
};
export const editPermission = {
  id: 'pr_2',
  sessionId: 'sess_i',
  askedAt: T,
  status: 'denied',
  tool: 'Edit',
  what: 'edit',
  file: WT_FILE,
  change: { text: '--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1 +1 @@\n-a\n+b\n' },
  root: WT,
  hostOnly: false,
  noAlways: 'no-suggestion',
  decision: { by: IAN, at: T, message: 'Edit the copy in src instead' },
};
export const outsidePermission = {
  id: 'pr_3',
  sessionId: 'sess_i',
  askedAt: T,
  status: 'withdrawn',
  tool: 'Read',
  what: 'outside',
  outside: true,
  path: '/Users/ian/notes.txt',
  root: WT,
  hostOnly: true,
  noAlways: 'host-only',
  escalatedAt: T,
  withdrawn: { reason: 'stopped', at: T },
};
export const reportSummary = {
  version: 2,
  writtenAt: T,
  outcome: 'partial',
  state: 'to-review',
  reviewers: [AMY_REF],
  checks: { passed: 3, notVerified: 1 },
};
export const topic = {
  id: 'tp_1',
  name: 'Checkout 結帳',
  slug: 'checkout',
  phase: 'plan',
  archived: false,
  versioned: true,
  createdBy: IAN,
  createdAt: T,
  discussionSessionId: 'sess_a',
  discussion: 'live',
  spec: { exists: true, changedAt: T, changedBy: agentActor, lastAgentChange: { sessionId: 'sess_a', seq: 7, at: T, askedBy: AMY_REF } },
  handEdits: { spec: [{ by: AMY_REF, at: T }, { by: 'outside', at: T }], plan: [] },
  plan: { exists: true, valid: false, error: { ...wireText, line: 12 }, generating: false, stale: true, mode: 'assigned', paused: false, changedAt: T, changedBy: { kind: 'user', ...AMY_REF }, items: 3, started: 1, reviewed: 0, merged: 0, leftOut: 0, undone: 0 },
  rules: [rule],
  agent: { model: 'sonnet', permissionMode: null },
};
/** Protocol 6: a topic whose items are all settled (one left out), and the same topic after "I've checked the result". */
export const readyTopic = { ...topic, phase: 'ready', plan: { ...topic.plan, valid: true, error: undefined, stale: false, started: 3, reviewed: 1, merged: 2, leftOut: 1, undone: 0 } };
export const checkedTopic = { ...readyTopic, phase: 'complete', checked: { by: AMY_REF, at: T } };
export const pausedTopic = { ...topic, plan: { ...topic.plan, paused: true, pausedBy: IAN } };
export const workItem = {
  id: 'cart-api',
  number: 1,
  title: 'Cart API',
  summary: 'Add the cart endpoints. Done when the cart tests pass.',
  dependsOn: [],
  size: 'm',
  touches: ['src/cart/**', 'test/cart/**'],
  inPlan: true,
  state: 'done',
  armed: false,
  responsible: { ...AMY_REF, source: 'agent' },
  startedBy: IAN,
  sessionId: 'sess_i',
  worktreeId: 'wt_1',
  attempt: 1,
  changesAsked: { by: IAN, at: T },
  report: reportSummary,
  merge: { requestId: 'mr_1', status: 'draft', ready: false },
};
/** Protocol 6: work items that smurg merges by itself: merged by smurg; held for its carers; held for the host; a conflict with a person's change; left out; undone. */
export const mergedAutoItem = { ...workItem, state: 'reviewed', changesAsked: undefined, merge: { requestId: 'mr_1', status: 'merged', ready: false }, merging: 'auto', merged: { at: T, by: 'smurg' } };
export const heldItem = {
  ...workItem,
  id: 'receipt-email',
  number: 2,
  title: 'Receipt email',
  changesAsked: undefined,
  merging: 'auto',
  autoMerge: { state: 'held', reason: 'partial', since: T, tries: 0, hostOnly: false, escalated: true },
  waiting: 'question',
};
export const hostHeldItem = {
  ...heldItem,
  autoMerge: { state: 'held', reason: 'policy', since: T, tries: 0, hostOnly: true, escalated: false, paths: ['.github/workflows/ci.yml'] },
  waiting: undefined,
};
export const branchHeldItem = { ...hostHeldItem, autoMerge: { state: 'held', reason: 'branch', since: T, tries: 0, hostOnly: true, escalated: false, branch: { expected: 'main', current: 'experiment' } } };
export const conflictItem = {
  ...heldItem,
  autoMerge: { state: 'held', reason: 'conflict', since: T, tries: 0, hostOnly: false, escalated: false, paths: ['config.txt'], people: [{ path: 'config.txt', by: [AMY_REF], outside: false }] },
  waiting: undefined,
};
export const askedItem = { ...heldItem, autoMerge: { state: 'waiting', reason: 'asked', since: T, tries: 0, hostOnly: false, escalated: false, asked: IAN }, waiting: undefined };
export const resolvingItem = { ...heldItem, autoMerge: { state: 'resolving', reason: 'conflict', since: T, tries: 2, hostOnly: false, escalated: false, paths: ['src/cart/api.ts'] }, waiting: undefined };
export const leftOutItem = { ...workItem, id: 'checkout-page', number: 3, state: 'stopped', changesAsked: undefined, merge: undefined, report: undefined, leftOut: { by: AMY_REF, at: T } };
export const undoneItem = { ...workItem, state: 'not-started', changesAsked: undefined, merge: undefined, report: undefined, sessionId: undefined, worktreeId: undefined, undone: { by: IAN, at: T } };
export const waitingItem = {
  id: 'checkout-page',
  number: 3,
  title: 'Checkout page',
  summary: '',
  dependsOn: ['cart-api'],
  size: 'l',
  touches: [],
  inPlan: true,
  state: 'waiting',
  armed: false,
  disarmed: 'plan-changed',
  waitsFor: ['cart-api'],
  responsible: null,
  attempt: 0,
  startError: { text: { id: 'plan.item.disarmed.changed' }, fallback: 'The spec or the plan changed since Start. This item did not start.' },
};
export const plan = {
  topicId: 'tp_1',
  revision: 4,
  specHash: HASH,
  planHash: 'b'.repeat(64),
  mode: 'assigned',
  paused: false,
  items: [workItem, waitingItem],
  split: { source: 'agent', reason: 'Amy knows the cart code.' },
  warnings: [{ text: { id: 'plan.warning.overlap', params: { first: 1, second: 2 } }, fallback: 'Items 1 and 2 may change the same files and neither waits for the other.' }],
  waitingFor: [{ user: IAN, questions: 1, permissions: 0, reports: 2, decisions: 0, since: T }],
  slots: { inUse: 2, max: 8, waitingForPeople: 1 },
};
/** Protocol 6: a plan that runs by itself, with every kind of item it shows. */
export const autoPlan = {
  ...plan,
  items: [mergedAutoItem, heldItem, hostHeldItem, branchHeldItem, conflictItem, askedItem, resolvingItem, leftOutItem, undoneItem],
  waitingFor: [{ user: AMY_REF, questions: 1, permissions: 0, reports: 0, decisions: 2, since: T }],
};
export const report = {
  ...reportSummary,
  topicId: 'tp_1',
  itemId: 'cart-api',
  file: { root: WT, path: 'specs/checkout/reports/cart-api.md' },
  sections: {
    done: 'The cart endpoints and their tests.',
    why: 'The cart lives in the session store.',
    verified: [{ text: '`pnpm test cart`: 14 tests passed', passed: true }, { text: 'Manual check in the browser', passed: false, note: 'no browser in this session' }],
    watchOut: '`POST /cart/items` does not check stock yet.',
    followUps: 'None.',
  },
  changes: { requestId: 'mr_1', files: 4, additions: 120, deletions: 8, byHand: [{ path: 'src/cart/api.ts', by: [AMY_REF] }] },
  questions: [{ id: 'm_9', from: IAN, text: 'Why not check stock here?', at: T, answer: { text: 'Item 5 does.', at: T } }],
};
/** Protocol 6: a report with a failed check (`- [!] …: failed: …`), and one whose hand-edit list was cut. */
export const failedReport = {
  ...report,
  outcome: 'partial',
  checks: { passed: 1, notVerified: 1, failed: 1 },
  sections: { ...report.sections, verified: [...report.sections.verified, { text: '`pnpm test checkout`', passed: false, failed: true, note: '2 of 9 tests failed' }] },
  changes: { ...report.changes, byHandTruncated: true },
};
export const preflight = {
  planRevision: 4,
  specHash: HASH,
  planHash: 'b'.repeat(64),
  startsNow: ['cart-api'],
  waits: [{ itemId: 'checkout-page', for: ['cart-api'] }],
  alreadyStarted: [],
  responsible: [{ itemId: 'cart-api', user: AMY_REF, online: true }, { itemId: 'checkout-page', user: null, online: false }],
  youDecide: 1,
  commit: { needed: true, branch: 'main', as: IAN, files: ['specs/checkout/SPEC.md', 'specs/checkout/PLAN.md'], alsoInFolder: ['specs/checkout/notes.md'] },
  handEdits: { spec: [{ by: AMY_REF, at: T }], plan: [] },
  invisibleCharacters: ['spec'],
  stale: false,
  openQuestion: false,
  specOpenQuestions: 2,
  editingNow: [AMY_REF],
  projectSettings: 'used',
  rules: [rule],
  sharedDirs: ['data'],
  blockers: [{ text: { id: 'plan.paused' }, fallback: "smurg was restarted on the host's computer. This plan is paused." }],
  history: 'folder',
  direct: null,
  agent: { model: 'sonnet', permissionMode: null, effective: 'auto' },
  nestedRepos: [],
  cloudSynced: false,
  merging: { workspace: 'auto', proposed: 'auto', detached: false },
};
/** Protocol 6: a Start on a detached HEAD (only the host merges), and one in a workspace whose host merges each item. */
export const detachedPreflight = { ...preflight, merging: { workspace: 'auto', proposed: 'host', detached: true } };
export const hostMergesPreflight = { ...preflight, merging: { workspace: 'host', proposed: 'host', detached: false } };
/** Protocol 5: the Start dialog of a folder without .git (smurg's own history) and of a host without git (direct). */
export const smurgHistoryPreflight = { ...preflight, history: 'smurg', commit: null, nestedRepos: ['frontend'], cloudSynced: true };
export const directPreflight = {
  ...preflight,
  history: 'direct',
  commit: null,
  direct: { reason: { text: { id: 'worktree.unavailable.gitCannotRun' }, fallback: 'git does not run on the host.' }, hostOnly: true },
  agent: { model: null, permissionMode: 'ask-all', effective: 'ask-all' },
  merging: null,
};
const CART_ITEM = { number: 1, title: 'Cart API' };
/** A question I decide (kind `question`). */
export const inboxItem = {
  key: 'question:q_1',
  kind: 'question',
  at: T,
  unread: true,
  waiting: true,
  topicId: 'tp_1',
  sessionId: 'sess_a',
  target: { kind: 'session', sessionId: 'sess_a' },
  anchor: { cardId: 'q_1', seq: 10 },
  excerpt: 'Where is the cart kept?',
  voted: 2,
  eligible: 3,
  allVoted: false,
  leading: 'On the server',
  waitsFor: IAN,
  waitsForOffline: false,
  escalated: true,
  alsoFor: [AMY_REF],
  alsoForMore: 0,
};
export const voteItem = {
  key: 'vote:q_1',
  kind: 'vote',
  at: T,
  unread: true,
  waiting: true,
  topicId: 'tp_1',
  sessionId: 'sess_a',
  target: { kind: 'session', sessionId: 'sess_a' },
  anchor: { cardId: 'q_1' },
  excerpt: 'Where is the cart kept?',
  voted: 1,
  eligible: 3,
  waitsFor: IAN,
};
export const permissionItem = {
  key: 'permission:pr_1',
  kind: 'permission',
  at: T,
  unread: true,
  waiting: true,
  topicId: 'tp_1',
  sessionId: 'sess_i',
  itemId: 'cart-api',
  item: CART_ITEM,
  target: { kind: 'session', sessionId: 'sess_i' },
  anchor: { cardId: 'pr_1', seq: 22 },
  excerpt: 'pnpm test cart',
  escalated: true,
  waitsFor: AMY_REF,
  waitsForOffline: true,
  alsoFor: [IAN],
};
export const suggestionItem = {
  key: 'suggestion:sess_a.dev-amy',
  kind: 'suggestion',
  at: T,
  unread: true,
  waiting: false,
  topicId: 'tp_1',
  sessionId: 'sess_a',
  target: { kind: 'session', sessionId: 'sess_a' },
  anchor: { cardId: 'sg_1' },
  from: { kind: 'user', ...AMY_REF },
  excerpt: 'Use the session store',
  count: 3,
};
export const reportItem = {
  key: 'report:tp_1.cart-api',
  kind: 'report',
  at: T,
  unread: true,
  waiting: false,
  topicId: 'tp_1',
  sessionId: 'sess_i',
  itemId: 'cart-api',
  item: CART_ITEM,
  target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' },
  excerpt: '',
  outcome: 'partial',
  checks: { passed: 2, notVerified: 1 },
  escalated: false,
};
export const attentionItem = {
  key: 'attention:item-stalled:tp_1.cart-api',
  kind: 'attention',
  subject: 'item-stalled',
  at: T,
  unread: false,
  waiting: true,
  topicId: 'tp_1',
  sessionId: 'sess_i',
  itemId: 'cart-api',
  item: CART_ITEM,
  target: { kind: 'session', sessionId: 'sess_i' },
  excerpt: '',
};
/** One item for the host while the account stops sessions; `host-rules` and `storage` do not stop work. */
export const accountItem = {
  key: 'attention:account:workspace',
  kind: 'attention',
  subject: 'account',
  at: T,
  unread: true,
  waiting: true,
  target: { kind: 'console', section: 'sessions' },
  excerpt: '',
  count: 4,
};
export const hostRulesItem = {
  key: 'attention:host-rules:workspace',
  kind: 'attention',
  subject: 'host-rules',
  at: T,
  unread: true,
  waiting: false,
  target: { kind: 'console', section: 'host-rules' },
  excerpt: '',
  count: 12,
};
export const pausedItem = {
  key: 'attention:plan-paused:tp_1',
  kind: 'attention',
  subject: 'plan-paused',
  at: T,
  unread: true,
  waiting: true,
  topicId: 'tp_1',
  target: { kind: 'plan', topicId: 'tp_1' },
  excerpt: 'Checkout 結帳',
  count: 4,
};
/** A reviewed draft: ready to merge, nobody asked (no `from`); item 3 waits for it. */
export const mergeItem = {
  key: 'merge:mr_2',
  kind: 'merge',
  at: T,
  unread: true,
  waiting: false,
  topicId: 'tp_1',
  itemId: 'cart-api',
  item: CART_ITEM,
  target: { kind: 'changes', requestId: 'mr_2' },
  excerpt: '',
  ready: true,
  unblocks: [3],
  conflict: false,
};
/** A request a member made for a free session's worktree. */
export const requestedMergeItem = {
  key: 'merge:mr_1',
  kind: 'merge',
  at: T,
  unread: false,
  waiting: false,
  target: { kind: 'changes', requestId: 'mr_1' },
  from: { kind: 'user', ...AMY_REF },
  excerpt: 'add tests',
  ready: false,
  conflict: true,
};
export const mentionItem = {
  key: 'mention:nt_4',
  kind: 'mention',
  at: T,
  unread: true,
  waiting: false,
  topicId: 'tp_1',
  sessionId: 'sess_a',
  target: { kind: 'session', sessionId: 'sess_a' },
  anchor: { cardId: 'q_1', seq: 10 },
  from: agentActor,
  excerpt: '@Ian the server, please',
};
export const resultItem = {
  key: 'result:nt_5',
  kind: 'result',
  at: T,
  unread: true,
  waiting: false,
  sessionId: 'sess_a',
  target: { kind: 'session', sessionId: 'sess_a' },
  anchor: { cardId: 'sg_1' },
  from: { kind: 'user', ...IAN },
  excerpt: 'Use the session store',
  result: 'rejected',
};
/** Protocol 5: the host's notice of the 0.6.0 update, until the host has seen it (it stops no work). */
export const agentsAutoItem = {
  key: 'attention:agents-auto:workspace',
  kind: 'attention',
  subject: 'agents-auto',
  at: T,
  unread: true,
  waiting: false,
  target: { kind: 'console', section: 'settings' },
  excerpt: '',
};
/** Protocol 6: the host's notice of the 0.7.0 update (work items merge by themselves), until the host has seen it. */
export const autoMergeNoticeItem = { ...agentsAutoItem, key: 'attention:auto-merge:workspace', subject: 'auto-merge' };
/** Protocol 6: a work item held for a decision of its responsible person (it stops item 3), and one for the host. */
export const decisionItem = {
  key: 'decision:tp_1.cart-api',
  kind: 'decision',
  at: T,
  unread: true,
  waiting: true,
  topicId: 'tp_1',
  sessionId: 'sess_i',
  itemId: 'cart-api',
  item: CART_ITEM,
  target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' },
  excerpt: '',
  reason: 'partial',
  outcome: 'partial',
  checks: { passed: 2, notVerified: 1, failed: 0 },
  unblocks: [3],
  escalated: false,
};
export const hostDecisionItem = { ...decisionItem, unread: false, reason: 'policy', outcome: undefined, checks: undefined, unblocks: undefined, escalated: undefined };
/** Protocol 6: a topic whose items are all settled, in every member's inbox (it stops nothing). */
export const readyItem = {
  key: 'ready:tp_1',
  kind: 'ready',
  at: T,
  unread: true,
  waiting: false,
  topicId: 'tp_1',
  target: { kind: 'result', topicId: 'tp_1' },
  excerpt: 'Checkout 結帳',
  tally: { items: 3, merged: 2, leftOut: 1, undone: 0 },
  checks: { passed: 5, notVerified: 1, failed: 0 },
};
/** One valid item of every kind (and of the attention subjects that differ). */
export const INBOX_SAMPLES = [
  inboxItem,
  voteItem,
  permissionItem,
  suggestionItem,
  reportItem,
  attentionItem,
  accountItem,
  hostRulesItem,
  pausedItem,
  mergeItem,
  requestedMergeItem,
  mentionItem,
  resultItem,
  agentsAutoItem,
  autoMergeNoticeItem,
  decisionItem,
  hostDecisionItem,
  readyItem,
];
/** Protocol 5: the host's agent (the list Claude Code 2.1.288 answered, U1 E3) and how work items run. */
export const agentModels = [
  { value: 'opus', name: 'Opus', description: 'Opus 5.5 · Most capable for complex work · $15/$75 per Mtok', resolved: 'claude-opus-5-5', auto: true },
  { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Best for everyday tasks', resolved: 'claude-sonnet-5', auto: true },
  { value: 'sonnet[1m]', name: 'Sonnet (1M context)', description: '', resolved: 'claude-sonnet-5[1m]', auto: true },
  { value: 'haiku', name: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers', resolved: 'claude-haiku-4-5-20251001', auto: false },
  { value: 'fable', name: 'Fable', description: 'Fable · Research preview', resolved: 'claude-fable-1', auto: true, billing: 'usage-credits' },
];
export const agentHostState = { models: agentModels, modelsKnown: true, hostDefault: 'claude-opus-5-5', autoMode: 'ok', asksNothing: 'ok' };
export const unknownAgentHostState = { models: [], modelsKnown: false, hostDefault: null, autoMode: 'ok', asksNothing: 'ok' };
export const hostState = {
  account: { state: 'usage-limit', resetsAt: T + 3_600_000, sessions: 4 },
  mainProjectSettings: 'ignored',
  agent: agentHostState,
  work: { history: 'folder' },
};
/** The host has no usable git: items run directly in the folder. */
export const directHostState = {
  account: { state: 'ok', sessions: 0 },
  mainProjectSettings: 'none',
  agent: { ...unknownAgentHostState, autoMode: 'off', asksNothing: 'root' },
  work: { history: 'direct', reason: { text: { id: 'worktree.unavailable.gitNotFound', params: { minVersion: '2.42.0' } }, fallback: 'git was not found on the host.' } },
};
export const claudeConfigFile = {
  path: '.claude/settings.json',
  hash: HASH,
  decision: null,
  changed: false,
  text: '{ "hooks": {} }',
  runs: ['./scripts/lint.sh --fix'],
  permissions: ['allow Bash(npm run *)'],
  env: [{ name: 'ANTHROPIC_BASE_URL', flagged: true }, { name: 'CI', flagged: false }],
  otherKeys: ['statusLine'],
  scripts: [{ path: 'scripts/lint.sh', hash: HASH }],
  needsAck: ['credentials', 'allows-tools'],
};
export const conflict = {
  id: 'c_1',
  file: FILE,
  createdAt: T,
  source: agentActor,
  humans: [{ userId: AMY, displayName: 'Amy' }],
  hunks: [{ humanText: 'amy()', agentText: 'agent()', baseText: 'base()', startLine: 3 }],
  agentVersionBytes: 120,
  status: 'open',
};
export const worktree = {
  id: 'wt_1',
  ownerUserId: AMY,
  ownerName: 'Amy',
  branch: 'smurg/amy/wt_1',
  sessionId: 'sess_2',
  kept: false,
  createdAt: T,
  sharedDirs: ['data'],
};
export const mergeRequest = {
  id: 'mr_1',
  worktreeId: 'wt_1',
  requestedBy: { userId: AMY, displayName: 'Amy' },
  message: 'add tests',
  commit: '0123456789abcdef0123456789abcdef01234567',
  status: 'pending',
  reviewed: false,
  createdAt: T,
};
/** The snapshot behind a result report: nobody asked to merge it yet. */
export const draftRequest = {
  id: 'mr_2',
  worktreeId: 'wt_1',
  commit: '0123456789abcdef0123456789abcdef01234567',
  status: 'draft',
  topicId: 'tp_1',
  itemId: 'cart-api',
  reviewed: true,
  createdAt: T,
};
export const activity = {
  id: 'ev_1',
  at: T,
  actor: agentActor,
  kind: 'agent.edit',
  file: FILE,
  text: { id: 'activity.agentEdit', params: { agent: 'Claude (Ian)', path: 'src/app.ts', tool: 'Edit' } },
  summary: 'Claude (Ian) edited src/app.ts (Edit)',
};
export const invite = { id: 'inv_1', role: 'editor', createdAt: T, expiresAt: T + 3_600_000, maxUses: 3, uses: 0, revoked: false };
export const device = { deviceId: 'dev_1', name: 'Chrome on macOS', kind: 'web', addedAt: T, lastSeenAt: T, revoked: false };
export const audit = {
  id: 'a_1',
  at: T,
  actor: { kind: 'user', userId: HOST, displayName: 'Ian' },
  action: 'file.write',
  target: 'src/app.ts',
  outcome: 'ok',
  detail: { bytes: 12 },
};
export const publicSettings = {
  humanLockIdleMs: 30_000,
  agentLockTimeoutMs: 60_000,
  uploadChunkSize: 4 * MiB,
  sharedDirs: ['data', 'checkpoints'],
  permissionMode: 'auto' as const,
  merging: 'auto' as const,
};
export const hostSettings = {
  ...publicSettings,
  diskReserveBytes: 5 * GiB,
  diskReservePercent: 5,
  maxLiveAgents: 8,
  escalateAfterMs: 5 * 60_000,
  agentMcp: false,
};
export const empty = {};
const emptyOnly: SampleSet = { valid: [{}], invalid: [{ extra: 1 }, null, []] };

export const MESSAGE_SAMPLES: Record<MessageType, MessageSamples> = {
  // ---- channel.* ------------------------------------------------------------------------------------------------
  'channel.memberUpdated': {
    payload: { valid: [{ member: guestMember }], invalid: [{ member: { ...guestMember, role: 'owner' } }, {}] },
  },
  'channel.settingsUpdated': {
    payload: {
      valid: [{ settings: publicSettings }],
      invalid: [
        { settings: hostSettings },
        { settings: { ...publicSettings, uploadChunkSize: 16 * MiB } },
        // protocol 5: every member learns the workspace's mode; it is one of smurg's four
        { settings: { ...publicSettings, permissionMode: undefined } },
        { settings: { ...publicSettings, permissionMode: 'bypassPermissions' } },
        // protocol 6: every member learns how work items merge; it is one of the two policies
        { settings: { ...publicSettings, merging: undefined } },
        { settings: { ...publicSettings, merging: 'smurg' } },
        // the guest switches of protocol 1 are gone with the guest sandbox (ARCHITECTURE §11 D-15)
        { settings: { ...publicSettings, guestSubscriptionLogin: false } },
        { settings: { ...publicSettings, guestMainWorkspace: true } },
        {},
      ],
    },
  },
  'channel.closed': {
    payload: {
      valid: [{ reason: 'kicked' }, { reason: 'role-changed' }],
      invalid: [{ reason: 'bored' }, { reason: 'kicked', message: 'Your role changed.' }],
    },
  },
  'channel.ack': { payload: { valid: [{ upTo: 0 }, { upTo: 42 }], invalid: [{ upTo: -1 }, { upTo: 1.5 }, { upTo: 2 ** 53 }] } },
  'channel.leave': { payload: emptyOnly, result: emptyOnly },
  error: {
    payload: {
      valid: [
        { code: 'forbidden', message: 'a message without a reference' },
        { code: 'insufficient_disk', message: 'no space', detail: { disk } },
        { code: 'forbidden', message: 'You do not have permission to do this.', text: { id: 'error.default.forbidden' } },
        { code: 'conflict', message: 'x', detail: { reason: 'worktree-in-use' }, text: { id: 'worktree.inUse' } },
        { code: 'locked', message: 'x', text: { id: 'file.lockedByPeople', params: { names: ['Amy', 'Bob'] } } },
        { code: 'too_large', message: 'x', text: { id: 'future.message', params: { name: 'amy', count: 2, forced: false, holders: ['Amy', 'Bob'] } } },
      ],
      invalid: [
        { code: 'forbidden', message: 'x', text: 'error.default.forbidden' },
        { code: 'forbidden', message: 'x', text: { id: 'Error.default' } },
        { code: 'forbidden', message: 'x', text: { id: 'error default' } },
        { code: 'forbidden', message: 'x', text: { id: 'a.b', params: { name: null } } },
        { code: 'forbidden', message: 'x', text: { id: 'a.b', params: { list: Array.from({ length: 11 }, () => 'x') } } },
        { code: 'forbidden', message: 'x', text: { id: 'a.b', params: { n: Number.POSITIVE_INFINITY } } },
        { code: 'forbidden', message: 'x', text: { id: 'a.b', extra: 1 } },
        { code: 'teapot', message: 'x' },
        { code: 'internal', message: 'x'.repeat(2_001) },
        { code: 'internal', message: 'x', detail: { constructor: 1 } },
      ],
    },
  },

  // ---- file.* ---------------------------------------------------------------------------------------------------
  'file.tree': {
    payload: {
      valid: [{ root: MAIN, path: '' }, { root: WT, path: 'docs', depth: 3 }],
      invalid: [{ root: MAIN, path: '../etc' }, { root: MAIN, path: '/abs' }, { root: MAIN, path: '', depth: 0 }],
    },
    result: {
      valid: [{ entries: [entry, { name: 'src', path: 'src', kind: 'dir', size: 0, mtime: -1000 }], truncated: false }],
      invalid: [{ entries: [{ ...entry, kind: 'socket' }], truncated: false }, { entries: [] }],
    },
  },
  'file.stat': {
    payload: { valid: [FILE, { root: MAIN, path: '' }], invalid: [{ root: MAIN, path: 'a\\b' }, { root: { kind: 'other' }, path: 'a' }] },
    result: { valid: [{ entry: { ...entry, lock: humanLock, lastModifiedBy: agentActor } }], invalid: [{ entry: { ...entry, size: -1 } }] },
  },
  'file.create': {
    payload: {
      valid: [{ file: FILE, kind: 'file' }, { file: WT_FILE, kind: 'dir' }],
      invalid: [{ file: { root: MAIN, path: '' }, kind: 'file' }, { file: FILE, kind: 'symlink' }],
    },
    result: { valid: [{ entry }], invalid: [{ entry: { ...entry, name: 'a/b' } }] },
  },
  'file.rename': {
    payload: {
      valid: [{ root: MAIN, from: 'a.txt', to: 'b/c.txt' }],
      invalid: [{ root: MAIN, from: 'a.txt', to: 'b//c.txt' }, { root: MAIN, from: 'a.txt' }],
    },
    result: { valid: [{ entry }], invalid: [{}] },
  },
  'file.delete': {
    payload: { valid: [{ file: FILE }], invalid: [{ file: { root: MAIN, path: 'a/./b' } }] },
    result: emptyOnly,
  },
  'file.read': {
    payload: {
      valid: [{ file: FILE }, { file: FILE, maxBytes: 1024 }],
      invalid: [{ file: FILE, maxBytes: 5 * MiB + 1 }, { file: { root: MAIN, path: 'C:/x' } }],
    },
    result: {
      valid: [{ content: bytes(12), hash: HASH, truncated: false }],
      invalid: [{ content: 'text', hash: HASH, truncated: false }, { content: bytes(1), hash: 'A'.repeat(64), truncated: false }],
    },
  },
  'file.write': {
    payload: {
      valid: [{ file: FILE, content: bytes(3) }, { file: FILE, content: new Uint8Array(0), ifMatchHash: HASH }],
      invalid: [{ file: FILE, content: [1, 2, 3] }, { file: FILE, content: bytes(5 * MiB + 1) }],
    },
    result: { valid: [{ entry, hash: HASH }], invalid: [{ entry, hash: 'nothex' }] },
  },
  'file.changed': {
    payload: {
      valid: [{ root: MAIN, changes: [{ path: 'src/app.ts', change: 'change', by: agentActor }, { path: 'tmp', change: 'unlinkDir' }] }],
      invalid: [{ root: MAIN, changes: [] }, { root: MAIN, changes: [{ path: 'a', change: 'moved' }] }],
    },
  },

  // ---- transfer -------------------------------------------------------------------------------------------------
  'file.upload.plan': {
    payload: {
      valid: [
        {
          root: MAIN,
          entries: [
            { path: 'photos', kind: 'dir' },
            { path: 'photos/empty', kind: 'dir' },
            { path: 'photos/cafe\u0301.jpg', kind: 'file', size: 10 * GiB },
          ],
          onConflict: 'rename',
        },
      ],
      invalid: [
        { root: MAIN, entries: [{ path: 'a', kind: 'file' }], onConflict: 'fail' },
        { root: MAIN, entries: [{ path: 'a', kind: 'dir', size: 1 }], onConflict: 'fail' },
        { root: MAIN, entries: [], onConflict: 'fail' },
      ],
    },
    result: {
      valid: [{ disk, renamed: [{ from: 'photos/a.jpg', to: 'photos/a (1).jpg' }] }],
      invalid: [{ disk: { ...disk, ok: 'yes' }, renamed: [] }],
    },
  },
  'file.upload.begin': {
    payload: {
      valid: [
        { root: MAIN, path: 'big.bin', size: 10 * GiB, chunkSize: 4 * MiB, lastModified: T },
        { root: WT, path: 'big.bin', size: 0, chunkSize: 1 * MiB, lastModified: 0, uploadId: 'up_1', onConflict: 'overwrite' },
      ],
      invalid: [
        { root: MAIN, path: 'big.bin', size: 1, chunkSize: 512 * KiB, lastModified: T },
        { root: MAIN, path: 'big.bin', size: 1, chunkSize: 9 * MiB, lastModified: T },
        { root: MAIN, path: 'big.bin', size: 2 ** 53, chunkSize: 4 * MiB, lastModified: T },
      ],
    },
    result: {
      valid: [{ uploadId: 'up_1', chunkCount: 2560, have: bytes(320, 0), received: 0, resumed: false, disk }],
      invalid: [{ uploadId: 'up 1', chunkCount: 1, have: bytes(1), received: 0, resumed: false, disk }],
    },
  },
  'file.upload.hashes': {
    payload: {
      valid: [{ uploadId: 'up_1', from: 0, count: 64 }],
      invalid: [{ uploadId: 'up_1', from: 0, count: 0 }, { uploadId: 'up_1', from: 0, count: UPLOAD_HASHES_PAGE_MAX + 1 }],
    },
    result: { valid: [{ hashes: bytes(64) }, { hashes: new Uint8Array(0) }], invalid: [{ hashes: bytes(33) }] },
  },
  'file.upload.chunk': {
    payload: {
      valid: [{ uploadId: 'up_1', index: 3, hash: bytes(32), data: bytes(4 * MiB) }],
      invalid: [
        { uploadId: 'up_1', index: 3, hash: bytes(31), data: bytes(10) },
        { uploadId: 'up_1', index: 3, hash: bytes(32), data: bytes(MAX_CHUNK_SIZE + 1) },
        { uploadId: 'up_1', index: 3, hash: bytes(32), data: new Uint8Array(0) },
        { uploadId: 'up_1', index: 3, hash: bytes(32), data: new Int8Array(4) },
      ],
    },
    result: { valid: [{ index: 3 }], invalid: [{ index: -3 }] },
  },
  'file.upload.commit': {
    payload: { valid: [{ uploadId: 'up_1', rootHash: bytes(32) }], invalid: [{ uploadId: 'up_1', rootHash: HASH }] },
    result: { valid: [{ entry }], invalid: [{ entry: {} }] },
  },
  'file.upload.abort': { payload: { valid: [{ uploadId: 'up_1' }], invalid: [{ uploadId: '' }] }, result: emptyOnly },
  'file.download.begin': {
    payload: {
      valid: [{ file: { root: MAIN, path: '' }, zip: true }, { file: FILE, offset: 8 * MiB, ifMatch: '12-1727000000000123-99' }],
      invalid: [{ file: FILE, zip: true, offset: 5 }, { file: FILE, ifMatch: 'has space' }],
    },
    result: {
      valid: [{ downloadId: 'dl_1', name: 'app.ts', size: 12, etag: '12-1-2', zip: false }, { downloadId: 'dl_2', name: 'Smurg.zip', zip: true }],
      invalid: [{ downloadId: 'dl_1', name: '../x', zip: false }],
    },
  },
  'file.download.chunk': {
    payload: {
      valid: [{ downloadId: 'dl_1', index: 0, offset: 0, data: bytes(1024) }],
      invalid: [{ downloadId: 'dl_1', index: 0, offset: 0, data: new Uint8Array(0) }, { downloadId: 'dl_1', index: 0, data: bytes(1) }],
    },
  },
  'file.download.ack': { payload: { valid: [{ downloadId: 'dl_1', index: 7 }], invalid: [{ downloadId: 'dl_1', index: '7' }] } },
  'file.download.end': {
    payload: {
      valid: [
        { downloadId: 'dl_2', totalBytes: 163_093_384, skipped: [{ path: 'a-fifo', reason: 'special-file' }], zip64: false },
        { downloadId: 'dl_3', totalBytes: 0, skipped: [], zip64: false, error: { code: 'internal', message: 'disk error' } },
      ],
      invalid: [{ downloadId: 'dl_2', totalBytes: 1, skipped: [{ path: '/etc/passwd', reason: 'x' }], zip64: false }],
    },
  },
  'file.download.cancel': { payload: { valid: [{ downloadId: 'dl_1' }], invalid: [{ downloadId: 'dl/1' }] } },

  // ---- doc.* ----------------------------------------------------------------------------------------------------
  'doc.open': {
    payload: { valid: [{ file: FILE }, { file: WT_FILE }], invalid: [{ file: { root: MAIN, path: '' } }, { path: 'src/app.ts' }] },
    result: {
      valid: [
        { docId: 'doc_1', epoch: 'e1', canEdit: true, meta: { eol: 'CRLF', bom: true, mixedEol: false } },
        { docId: 'doc_1', epoch: 'e1', canEdit: false, lock: agentLock, meta: { eol: 'LF', bom: false, mixedEol: true } },
      ],
      invalid: [{ docId: 'doc_1', epoch: 'e1', canEdit: true, meta: { eol: '\n', bom: false, mixedEol: false } }],
    },
  },
  'doc.reset': { payload: { valid: [{ docId: 'doc_1', epoch: 'e2' }], invalid: [{ docId: 'doc_1' }] } },
  'doc.sync': {
    payload: {
      valid: [{ docId: 'doc_1', data: new Uint8Array([0, 0, 1, 0]) }],
      invalid: [{ docId: 'doc_1', data: new Uint8Array(0) }, { docId: 'doc_1', data: 'AAE=' }],
    },
  },
  'doc.awareness': {
    payload: { valid: [{ docId: 'doc_1', data: bytes(40) }], invalid: [{ docId: 'doc_1', data: bytes(256 * KiB + 1) }] },
  },
  'doc.close': { payload: { valid: [{ docId: 'doc_1' }], invalid: [{ docId: 'doc_1', force: true }] } },
  'doc.saved': {
    payload: { valid: [{ docId: 'doc_1', file: FILE, hash: HASH, at: T }], invalid: [{ docId: 'doc_1', file: FILE, hash: HASH, at: -1 }] },
  },
  'doc.rejected': {
    payload: {
      valid: [{ docId: 'doc_1', reason: 'agent-locked', lock: agentLock }, { docId: 'doc_1', reason: 'read-only' }, { docId: 'doc_1', reason: 'file-unavailable' }],
      invalid: [{ docId: 'doc_1', reason: 'because' }],
    },
  },
  'doc.conflict': {
    payload: {
      valid: [{ conflict }, { conflict: { ...conflict, hunks: [{ ...conflict.hunks[0], truncated: true }], hunksOmitted: 3 } }],
      invalid: [{ conflict: { ...conflict, hunks: [{ ...conflict.hunks[0], startLine: 0 }] } }, { conflict: { ...conflict, agentVersion: 'x' } }],
    },
  },
  'doc.conflict.list': {
    payload: emptyOnly,
    result: { valid: [{ conflicts: [conflict] }, { conflicts: [] }], invalid: [{ conflicts: [{ ...conflict, status: 'closed' }] }] },
  },
  'doc.conflict.resolve': {
    payload: {
      valid: [{ conflictId: 'c_1', action: 'dismiss' }, { conflictId: 'c_1', action: 'apply-agent-version' }],
      invalid: [{ conflictId: 'c_1', action: 'merge' }],
    },
    result: { valid: [{ conflict: { ...conflict, status: 'applied' } }], invalid: [{ conflict: null }] },
  },
  'doc.conflict.get': {
    payload: { valid: [{ conflictId: 'c_1' }], invalid: [{ conflictId: 1 }] },
    result: { valid: [{ conflict, agentVersion: bytes(120) }], invalid: [{ conflict, agentVersion: 'agent text' }] },
  },

  // ---- lock / presence / activity ----------------------------------------------------------------------------------
  'lock.state': {
    payload: { valid: [{ file: FILE, lock: humanLock }, { file: FILE, lock: null }], invalid: [{ file: FILE }, { file: FILE, lock: { kind: 'human', file: FILE, holders: [], acquiredAt: T } }] },
  },
  'lock.list': {
    payload: emptyOnly,
    result: { valid: [{ locks: [humanLock, agentLock] }], invalid: [{ locks: [{ ...agentLock, kind: 'robot' }] }] },
  },
  'lock.release': { payload: { valid: [{ file: FILE }], invalid: [{ file: { root: MAIN, path: '' } }] }, result: emptyOnly },
  'lock.forceRelease': { payload: { valid: [{ file: WT_FILE }], invalid: [{}] }, result: emptyOnly },
  'presence.heartbeat': { payload: { valid: [{ at: T }], invalid: [{ at: 'now' }] } },
  'presence.state': {
    payload: {
      valid: [
        {
          members: [{ ...member, connections: 2, activeFile: FILE }],
          agents: [{ sessionId: 'sess_1', ownerUserId: HOST, displayName: 'Claude (Ian)', color: '#f59e0b', status: 'running' }],
        },
      ],
      invalid: [{ members: [member], agents: [] }],
    },
  },
  'presence.update': {
    payload: { valid: [{ activeFile: FILE }, { activeFile: null }, {}], invalid: [{ activeFile: { root: MAIN, path: '..' } }] },
  },
  'activity.event': {
    payload: {
      valid: [
        { event: activity },
        { event: { ...activity, via: 'bash' } },
        { event: { ...activity, text: { id: 'activity.agentEdit', params: { agent: 'Claude (Ian)', path: 'src/app.ts' } } } },
        { event: { ...activity, kind: 'file.rename', text: { id: 'activity.fileRename', params: { from: 'src/old.ts', to: 'src/app.ts' } }, renamedFrom: 'src/old.ts' } },
      ],
      invalid: [
        { event: { ...activity, text: undefined } },
        { event: { ...activity, text: 'activity.agentEdit' } },
        { event: { ...activity, renamedFrom: '' } },
        { event: { ...activity, renamedFrom: '../outside.ts' } },{ event: { ...activity, kind: 'agent.dance' } }, { event: { ...activity, via: 'zsh' } }, { event: { ...activity, via: '' } }],
    },
  },
  'activity.list': {
    payload: { valid: [{}, { limit: 50, before: T }], invalid: [{ limit: 501 }, { limit: 0 }] },
    result: { valid: [{ events: [activity] }], invalid: [{ events: [{ ...activity, summary: 'x'.repeat(501) }] }] },
  },
  'activity.notify': {
    payload: {
      valid: [
        { notification: { id: 'n_1', at: T, from: agentActor, text: 'Amy，src/app.ts 我改好了', file: FILE } },
        {
          notification: {
            id: 'n_2',
            at: T,
            from: { kind: 'system' },
            msg: { id: 'notify.claudeVersionTooOld', params: { version: '2.0.1', minVersion: '2.1.0' } },
            fallback: 'Note: Claude Code 2.0.1 is older than 2.1.0.',
          },
        },
      ],
      invalid: [
        { notification: { id: 'n_1', at: T, from: agentActor, text: '' } },
        { notification: { id: 'n_1', at: T, from: agentActor } },
        { notification: { id: 'n_1', at: T, from: agentActor, text: 'x', msg: { id: 'notify.x' }, fallback: 'x' } },
        { notification: { id: 'n_1', at: T, from: agentActor, text: 'x', fallback: 'x' } },
        { notification: { id: 'n_1', at: T, from: agentActor, msg: { id: 'notify.x' } } },
        { notification: { id: 'n_1', at: T, from: agentActor, fallback: 'x' } },
        { notification: { id: 'n_1', at: T, from: agentActor, msg: { id: '' }, fallback: 'x' } },
        { notification: { id: 'n_1', at: T, from: agentActor, msg: { id: 'notify.x' }, fallback: '' } },
      ],
    },
  },

  // ---- session.* / exec.* -------------------------------------------------------------------------------------
  'session.create': {
    payload: {
      valid: [
        { kind: 'agent', workspace: { mode: 'main' } },
        { kind: 'terminal', workspace: { mode: 'worktree', worktreeId: 'wt_1' }, cols: 80, rows: 24, title: 'shell' },
        { kind: 'agent', workspace: { mode: 'worktree' }, title: 'Try the cache', firstMessage: 'Look at src/cache.ts\n​please' },
        { kind: 'agent', workspace: { mode: 'main' }, model: 'sonnet[1m]', permissionMode: 'ask-commands' },
        { kind: 'agent', workspace: { mode: 'worktree' }, model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5', permissionMode: 'auto' },
      ],
      invalid: [
        // protocol 5: never `ask-nothing` for one session (the host's, workspace-wide); a model id is an id
        { kind: 'agent', workspace: { mode: 'main' }, permissionMode: 'ask-nothing' },
        { kind: 'agent', workspace: { mode: 'main' }, permissionMode: null },
        { kind: 'agent', workspace: { mode: 'main' }, model: '' },
        { kind: 'agent', workspace: { mode: 'main' }, model: '--dangerously-skip-permissions' },
        { kind: 'agent', workspace: { mode: 'main' }, model: 'x'.repeat(257) },
        { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, model: 'sonnet' },
        { kind: 'agent', workspace: { mode: 'main' }, sandboxed: false },
        // an agent session is a conversation: it has no terminal size
        { kind: 'agent', workspace: { mode: 'main' }, cols: 120, rows: 40 },
        // protocol 1's guest login process and guest API key are gone (ARCHITECTURE §11 D-15)
        { kind: 'login', workspace: { mode: 'main' }, cols: 120, rows: 40 },
        { kind: 'agent', workspace: { mode: 'main' }, apiKey: 'sk-ant-api03-abc' },
        { kind: 'terminal', workspace: { mode: 'main' } },
        { kind: 'agent', workspace: { mode: 'elsewhere' } },
        { kind: 'terminal', workspace: { mode: 'main' }, cols: 0, rows: 40 },
        { kind: 'agent', workspace: { mode: 'main' }, firstMessage: '  \n' },
      ],
    },
    result: {
      valid: [{ session }, { session: { ...session, title: undefined } }, { session: agentSession }, { session: itemSession }],
      invalid: [
        { session: { ...session, status: 'paused' } },
        { session: { ...session, sandboxed: false } },
        { session: { ...session, title: 7 } },
        { session: { ...session, ownerUserId: HOST } },
        { session: { ...agentSession, cols: 80, rows: 24 } },
        { session: { ...agentSession, topicId: undefined } },
        { session: { ...itemSession, itemId: undefined } },
        { session: { ...agentSession, status: 'exited' } },
        // a topic's session names its topic; an item's session its item and its attempt; a free session neither
        { session: { ...agentSession, topicName: undefined } },
        { session: { ...itemSession, item: undefined } },
        { session: { ...itemSession, attempt: undefined } },
        { session: { ...agentSession, purpose: 'free', topicId: undefined } },
        { session: { ...agentSession, item: { number: 1, title: 'Cart API' } } },
        // protocol 5: a discussion follows nothing and reads ask-all; a fallback goes with the mode in use
        { session: { ...agentSession, modeChoice: 'auto' } },
        { session: { ...agentSession, permissionMode: 'auto' } },
        { session: { ...itemSession, modeInUse: undefined } },
        { session: { ...itemSession, modeChoice: 'ask-nothing' } },
        { session: { ...itemSession, modeFallback: 'tired' } },
        { session: { ...itemSession, model: undefined } },
        { session: { ...itemSession, modelInUse: '' } },
        { session: { ...agentSession, modeChoice: undefined } },
      ],
    },
  },
  'session.list': {
    payload: { valid: [{}, { topicId: 'tp_1' }, { after: 'sess_2' }, { topicId: 'tp_1', after: 'sess_a' }], invalid: [{ extra: 1 }, { topicId: '' }, null, []] },
    result: {
      valid: [
        { sessions: [session, { ...session, id: 'sess_2', status: 'exited', exitCode: 3, endedAt: T + 1, endReason: 'exit' }, agentSession, itemSession], hasMore: false },
        { sessions: [{ ...agentSession, purpose: 'free', topicId: undefined, topicName: undefined, title: 'Try the cache', modeFixed: false }], hasMore: true },
      ],
      invalid: [{ sessions: {}, hasMore: false }, { sessions: [session] }],
    },
  },
  'session.host.get': {
    payload: emptyOnly,
    result: {
      valid: [
        { account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none', agent: unknownAgentHostState, work: { history: 'unchecked' } },
        hostState,
        directHostState,
        { ...hostState, work: { history: 'smurg' } },
      ],
      invalid: [
        { account: { state: 'ok' }, mainProjectSettings: 'none', agent: unknownAgentHostState, work: { history: 'folder' } },
        { account: { state: 'rate-limited', sessions: 1 }, mainProjectSettings: 'used', agent: unknownAgentHostState, work: { history: 'folder' } },
        { account: { state: 'ok', sessions: 0 } },
        // protocol 4's host state (no agent, no work) is refused: protocol 5 is exact
        { account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none' },
        { ...hostState, work: { history: 'folder', reason: directHostState.work.reason } },
        { ...hostState, work: { history: 'git' } },
        { ...hostState, agent: { ...agentHostState, models: Array.from({ length: 33 }, () => agentModels[0]) } },
        { ...hostState, agent: { ...agentHostState, models: [{ ...agentModels[0], value: 'opus 5' }] } },
        { ...hostState, agent: { ...agentHostState, models: [{ ...agentModels[0], billing: 'credits' }] } },
        { ...hostState, agent: { ...agentHostState, models: [{ ...agentModels[0], name: '' }] } },
        { ...hostState, agent: { ...agentHostState, asksNothing: 'yes' } },
        { ...hostState, agent: { ...agentHostState, hostDefault: undefined } },
      ],
    },
  },
  'session.host': {
    payload: {
      valid: [hostState, directHostState, { account: { state: 'logged-out', sessions: 2 }, mainProjectSettings: 'used', agent: unknownAgentHostState, work: { history: 'unchecked' } }],
      invalid: [{ account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'trusted', agent: unknownAgentHostState, work: { history: 'folder' } }, { ...hostState, login: 'logged-out' }],
    },
  },
  'session.state': {
    payload: {
      valid: [{ session }, { session: { ...itemSession, status: 'ended', endedAt: T, endReason: 'merged' } }, { session: { ...itemSession, status: 'ended', endedAt: T, endReason: 'reviewed' } }],
      invalid: [{ session: { ...session, cols: 1001 } }, { session: { ...agentSession, endReason: 'crashed' } }],
    },
  },
  'session.end': {
    payload: { valid: [{ sessionId: 'sess_1' }, { sessionId: 'sess_1', keepWorktree: true }], invalid: [{ sessionId: 'sess_1', keepWorktree: 'yes' }] },
    result: emptyOnly,
  },
  'session.rename': {
    payload: { valid: [{ sessionId: 'sess_a', title: 'Cache idea' }], invalid: [{ sessionId: 'sess_a', title: '' }, { sessionId: 'sess_a' }] },
    result: { valid: [{ session: { ...agentSession, title: 'Cache idea' } }, { session }], invalid: [{}] },
  },
  'session.attach': {
    payload: {
      valid: [{ sessionId: 'sess_1' }, { sessionId: 'sess_1', haveOffset: 1_000_000, cols: 100, rows: 30 }],
      invalid: [{ sessionId: 'sess_1', cols: 100 }, { sessionId: 'sess_1', haveOffset: -1 }],
    },
    result: {
      valid: [{ session, mode: 'snapshot', data: bytes(2048), cols: 120, rows: 40, nextOffset: 99 }],
      invalid: [
        { session, mode: 'replay', data: bytes(1), cols: 120, rows: 40, nextOffset: 99 },
        { session: agentSession, mode: 'snapshot', data: bytes(1), cols: 120, rows: 40, nextOffset: 99 },
      ],
    },
  },
  'session.detach': { payload: { valid: [{ sessionId: 'sess_1' }], invalid: [{}] } },
  'exec.output': {
    payload: {
      valid: [{ sessionId: 'sess_1', offset: 0, data: bytes(64 * KiB) }],
      invalid: [{ sessionId: 'sess_1', offset: 0, data: new Uint8Array(0) }, { sessionId: 'sess_1', offset: 0.5, data: bytes(1) }],
    },
  },
  'exec.input': {
    payload: { valid: [{ sessionId: 'sess_1', data: new Uint8Array([0x1b, 0x5b, 0x41]) }], invalid: [{ sessionId: 'sess_1', data: 'ls\r' }] },
  },
  'exec.resize': {
    payload: { valid: [{ sessionId: 'sess_1', cols: 80, rows: 24 }], invalid: [{ sessionId: 'sess_1', cols: 80 }, { sessionId: 'sess_1', cols: 80, rows: 1001 }] },
  },
  'session.watch': {
    payload: {
      valid: [{ sessionId: 'sess_a' }, { sessionId: 'sess_a', haveSeq: 0, live: false }, { sessionId: 'sess_a', haveSeq: 41 }],
      invalid: [{ sessionId: 'sess_a', haveSeq: -1 }, { sessionId: 'sess_a', live: 'yes' }, {}],
    },
    result: {
      valid: [
        { session: agentSession, events, firstSeq: 1, nextSeq: 16, hasEarlier: false, hasMore: false, streaming: [{ turnId: 't_2', blockId: 'b_4', text: 'The cart' }, { turnId: 't_2', blockId: 'b_5', text: 'In the subagent', parentToolUseId: 'toolu_7' }], questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] },
        { session: agentSession, events: [], firstSeq: 0, nextSeq: 1, hasEarlier: false, hasMore: false, streaming: [], questions: [], permissions: [], suggestions: [], moreCards: [] },
        // the caller's haveSeq is current: an empty page that continues its window; earlier events exist
        { session: agentSession, events: [], firstSeq: 0, nextSeq: 16, hasEarlier: true, hasMore: false, streaming: [], questions: [question], permissions: [], suggestions: [], moreCards: [] },
      ],
      invalid: [
        { session, events, firstSeq: 1, nextSeq: 16, hasEarlier: false, hasMore: false, streaming: [], questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] },
        { session: agentSession, events: [{ seq: 1, at: T, kind: 'raw', line: '{}' }], firstSeq: 1, nextSeq: 2, hasEarlier: false, hasMore: false, streaming: [], questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] },
        { session: agentSession, events: [{ ...events[4], usage: { input_tokens: 5 } }], firstSeq: 1, nextSeq: 2, hasEarlier: false, hasMore: false, streaming: [], questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] },
        { session: agentSession, events: [{ ...events[0], seq: 0 }], firstSeq: 1, nextSeq: 2, hasEarlier: false, hasMore: false, streaming: [], questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] },
        // a tool result names its turn
        { session: agentSession, events: [{ seq: 7, at: T, kind: 'tool.finished', toolUseId: 'toolu_1', ok: true, result: {} }], firstSeq: 7, nextSeq: 8, hasEarlier: true, hasMore: false, streaming: [], questions: [], permissions: [], suggestions: [], moreCards: [] },
        // a streaming block never says the agent thinks
        { session: agentSession, events: [], firstSeq: 0, nextSeq: 1, hasEarlier: false, hasMore: false, streaming: [{ turnId: 't_2', blockId: 'b_4', text: '', thinking: true }], questions: [], permissions: [], suggestions: [], moreCards: [] },
      ],
    },
  },
  'session.unwatch': { payload: { valid: [{ sessionId: 'sess_a' }], invalid: [{}] } },
  'session.history': {
    payload: {
      valid: [{ sessionId: 'sess_a', beforeSeq: 100, limit: 500 }, { sessionId: 'sess_a', afterSeq: 0, limit: 50 }],
      invalid: [
        { sessionId: 'sess_a', limit: 50 },
        { sessionId: 'sess_a', beforeSeq: 100, afterSeq: 4, limit: 50 },
        { sessionId: 'sess_a', beforeSeq: 100, limit: 501 },
        { sessionId: 'sess_a', beforeSeq: 100 },
      ],
    },
    result: {
      valid: [{ events, hasEarlier: true, hasMore: false, questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] }],
      invalid: [{ events, hasEarlier: true, questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] }, { events: [{ ...events[1], text: 'evil ‮ reversed' }], hasEarlier: false, hasMore: false, questions: [question], permissions: [permission], suggestions: [suggestion], moreCards: [{ kind: 'permission', id: 'pr_9' }] }],
    },
  },
  'session.cards.get': {
    payload: {
      valid: [{ sessionId: 'sess_a', cards: [{ kind: 'question', id: 'q_1' }, { kind: 'suggestion', id: 'sg_1' }] }],
      invalid: [
        { sessionId: 'sess_a', cards: [] },
        { sessionId: 'sess_a', cards: [{ kind: 'report', id: 'r_1' }] },
        { sessionId: 'sess_a', cards: Array.from({ length: 21 }, (_, i) => ({ kind: 'question', id: `q_${i}` })) },
      ],
    },
    result: {
      valid: [{ questions: [question, answeredQuestion], permissions: [permission, editPermission, outsidePermission], suggestions: [], moreCards: [] }],
      invalid: [
        { questions: [{ ...question, votes: [{ userId: AMY, displayName: 'Amy', part: 0, at: T }] }], permissions: [], suggestions: [], moreCards: [] },
        { questions: [{ ...question, parts: [] }], permissions: [], suggestions: [], moreCards: [] },
        // two parts with the same text: Claude Code keys the answer by the text
        { questions: [{ ...question, parts: [question.parts[0], question.parts[0]] }], permissions: [], suggestions: [], moreCards: [] },
        { questions: [], permissions: [{ ...permission, alwaysRule: { tool: 'Edit', pattern: 'src/**' } }], suggestions: [], moreCards: [] },
        { questions: [], permissions: [], suggestions: [] },
      ],
    },
  },
  'session.events': {
    payload: {
      valid: [{ sessionId: 'sess_a', events }, { sessionId: 'sess_a', events: [events[4]] }],
      invalid: [
        { sessionId: 'sess_a', events: [] },
        { sessionId: 'sess_a', events: [{ ...events[5], tool: { name: 'Read', verb: 'peek' } }] },
        { sessionId: 'sess_a', events: [{ ...events[8], result: { cost: 0.2 } }] },
      ],
    },
  },
  'session.delta': {
    payload: {
      valid: [
        { sessionId: 'sess_a', turnId: 't_2', blockId: 'b_4', offset: 8, text: ' lives in' },
        { sessionId: 'sess_a', turnId: 't_2', blockId: 'b_5', offset: 0, text: '', thinking: true },
        { sessionId: 'sess_a', turnId: 't_2', blockId: 'b_6', offset: 0, text: 'In the subagent', parentToolUseId: 'toolu_7' },
      ],
      invalid: [
        { sessionId: 'sess_a', turnId: 't_2', blockId: 'b_4', offset: -1, text: 'x' },
        { sessionId: 'sess_a', turnId: 't_2', blockId: 'b_4', offset: 0, text: 'x', thinking: false },
        // a thinking delta carries no text and starts no block
        { sessionId: 'sess_a', turnId: 't_2', blockId: 'b_5', offset: 0, text: 'hmm', thinking: true },
        { sessionId: 'sess_a', turnId: 't_2', blockId: 'b_5', offset: 3, text: '', thinking: true },
      ],
    },
  },
  'session.message.send': {
    payload: {
      valid: [
        { sessionId: 'sess_a', text: 'Use the session store' },
        { sessionId: 'sess_a', text: '/context looks like a command\n@Amy please check', mentions: [AMY], origin: 'selection' },
      ],
      invalid: [
        { sessionId: 'sess_a', text: '' },
        { sessionId: 'sess_a', text: ' \n\t' },
        { sessionId: 'sess_a', text: 'x'.repeat(64 * KiB + 1) },
        { sessionId: 'sess_a', text: 'x', origin: 'revise' },
        { sessionId: 'sess_a', text: 'x', mentions: Array.from({ length: 11 }, (_, i) => `dev:u${i}`) },
        { sessionId: 'sess_a', text: 'nul\u0000' },
      ],
    },
    result: { valid: [{ messageId: 'm_1' }], invalid: [{}] },
  },
  'session.interrupt': { payload: { valid: [{ sessionId: 'sess_a' }], invalid: [{}] }, result: emptyOnly },
  'session.retry': {
    payload: { valid: [{ sessionId: 'sess_a' }], invalid: [{ sessionId: 7 }] },
    result: { valid: [{ session: { ...agentSession, status: 'starting' } }], invalid: [{ session }] },
  },
  'session.restart': {
    payload: { valid: [{ sessionId: 'sess_a' }], invalid: [{}, { sessionId: 'sess_a', reason: 'asked' }] },
    result: { valid: [{ session: agentSession }, { session: itemSession }], invalid: [{ session }, {}] },
  },
  'session.responsible.set': {
    payload: { valid: [{ sessionId: 'sess_i', userId: AMY }, { sessionId: 'sess_i', userId: null }], invalid: [{ sessionId: 'sess_i' }, { sessionId: 'sess_i', userId: 'amy' }] },
    result: { valid: [{ session: itemSession }], invalid: [{ session }] },
  },
  'session.mode.set': {
    payload: {
      valid: [{ sessionId: 'sess_i', mode: 'ask-all' }, { sessionId: 'sess_i', mode: 'auto' }, { sessionId: 'sess_i', mode: null }],
      invalid: [{ sessionId: 'sess_i', mode: 'ask-nothing' }, { sessionId: 'sess_i', mode: 'bypassPermissions' }, { sessionId: 'sess_i' }],
    },
    result: { valid: [{ session: { ...itemSession, permissionMode: 'ask-all', modeChoice: 'ask-all', modeInUse: 'ask-all', modeFallback: undefined } }], invalid: [{}] },
  },
  'session.model.set': {
    payload: {
      valid: [{ sessionId: 'sess_i', model: 'sonnet' }, { sessionId: 'sess_a', model: null }, { sessionId: 'sess_i', model: 'claude-opus-5-5@20261001' }],
      invalid: [{ sessionId: 'sess_i' }, { sessionId: 'sess_i', model: '' }, { sessionId: 'sess_i', model: 'sonnet; rm -rf /' }, { sessionId: 'sess_i', model: '-p' }],
    },
    result: { valid: [{ session: { ...itemSession, model: 'sonnet', modelInUse: undefined } }], invalid: [{}, { session }] },
  },
  'session.rules.get': {
    payload: { valid: [{ sessionId: 'sess_i' }], invalid: [{}] },
    result: {
      valid: [
        { rules: [rule, { ...rule, id: 'rl_2', tool: 'WebFetch', pattern: 'domain:example.com', scope: 'session' }], host: { state: 'applied', rules: ['Bash(npm run *)'] } },
        { rules: [], host: { state: 'applied' } },
        { rules: [], host: { state: 'none' } },
      ],
      invalid: [{ rules: [{ ...rule, tool: 'Edit' }], host: { state: 'none' } }, { rules: [], host: { state: 'asked' } }, { rules: [] }],
    },
  },
  'session.rule.remove': {
    payload: { valid: [{ sessionId: 'sess_i', ruleId: 'rl_1' }], invalid: [{ sessionId: 'sess_i' }] },
    result: { valid: [{ session: itemSession }], invalid: [{}] },
  },
  'session.loginStatus': {
    payload: { valid: [{ sessionId: 'sess_a' }], invalid: [{ sessionId: 'sess 1' }] },
    result: { valid: [{ login: 'logged-out' }], invalid: [{ login: 'maybe' }] },
  },

  // ---- question.* / permission.* --------------------------------------------------------------------------------
  'question.vote': {
    payload: {
      valid: [
        { questionId: 'q_1', part: 0, options: [1] },
        { questionId: 'q_1', part: 3, options: [0, 2] },
        { questionId: 'q_1', part: 0, other: 'Both, behind a flag' },
        { questionId: 'q_1', part: 0 },
      ],
      invalid: [
        { questionId: 'q_1', part: 0, options: [0], other: 'and this' },
        { questionId: 'q_1', part: 4, options: [0] },
        { questionId: 'q_1', part: 0, options: [4] },
        { questionId: 'q_1', part: 0, options: [] },
        { questionId: 'q_1', part: 0, options: ['On the server'] },
        { questionId: 'q_1', part: 0, other: 'x'.repeat(501) },
      ],
    },
    result: emptyOnly,
  },
  'question.comment': {
    payload: {
      valid: [{ questionId: 'q_1', text: 'The server, please' }, { questionId: 'q_1', text: '@Ian 看一下', mentions: [HOST] }],
      invalid: [{ questionId: 'q_1', text: '' }, { questionId: 'q_1', text: 'x'.repeat(1_001) }],
    },
    result: { valid: [{ commentId: 'cm_1' }], invalid: [{}] },
  },
  'question.submit': {
    payload: {
      valid: [
        { questionId: 'q_1', answers: [{ options: [0] }] },
        { questionId: 'q_1', answers: [{ options: [0, 1] }, { other: 'Both, behind a flag', otherBy: AMY }], note: 'Amy asked for the server' },
      ],
      invalid: [
        { questionId: 'q_1', answers: [] },
        // an answer is option INDEXES: no label text comes from a client
        { questionId: 'q_1', answers: [{ label: 'On the server' }] },
        { questionId: 'q_1', answers: [{ options: [0], other: 'x' }] },
        { questionId: 'q_1', answers: [{ options: [0] }], note: 'x'.repeat(1_001) },
        { questionId: 'q_1', answers: Array.from({ length: 5 }, () => ({ options: [0] })) },
      ],
    },
    result: { valid: [{ question: answeredQuestion }], invalid: [{ question: { ...answeredQuestion, answer: { ...answeredQuestion.answer, tally: [[1]] } } }] },
  },
  'question.remind': { payload: { valid: [{ questionId: 'q_1' }], invalid: [{}] }, result: emptyOnly },
  'question.seen': { payload: { valid: [{ questionId: 'q_1' }], invalid: [{ questionId: '' }] } },
  'question.changed': {
    payload: {
      valid: [
        { sessionId: 'sess_a', questionId: 'q_1', vote: question.votes[0], eligible: 4 },
        { sessionId: 'sess_a', questionId: 'q_1', voteRemoved: { userId: AMY, part: 0 } },
        { sessionId: 'sess_a', questionId: 'q_1', comment: question.comments[0] },
        { sessionId: 'sess_a', questionId: 'q_1', deciderSeenAt: T },
      ],
      invalid: [{ sessionId: 'sess_a', questionId: 'q_1', question }, { sessionId: 'sess_a', questionId: 'q_1', vote: { ...question.votes[0], options: undefined } }, { questionId: 'q_1', deciderSeenAt: T }],
    },
  },
  'question.updated': {
    payload: {
      valid: [
        { question },
        { question: answeredQuestion },
        { question: { ...question, status: 'withdrawn', withdrawn: { reason: 'restarted', at: T }, previous: { askedAt: T, tally: [[2, 0, 0]] } } },
        { question: { ...question, decider: null } },
      ],
      invalid: [{ question: { ...question, status: 'closed' } }, { question: { ...question, withdrawn: { reason: 'timeout', at: T } } }],
    },
  },
  'permission.decide': {
    payload: {
      valid: [
        { requestId: 'pr_1', decision: 'allow' },
        { requestId: 'pr_1', decision: 'allow-always', scope: 'topic' },
        { requestId: 'pr_1', decision: 'allow-always' },
        { requestId: 'pr_1', decision: 'deny', message: 'Run the unit tests only' },
      ],
      invalid: [
        // the client never sends a rule
        { requestId: 'pr_1', decision: 'allow-always', rule: 'Bash(pnpm *)' },
        { requestId: 'pr_1', decision: 'allow', scope: 'session' },
        { requestId: 'pr_1', decision: 'allow', message: 'ok' },
        { requestId: 'pr_1', decision: 'bypass' },
      ],
    },
    result: {
      valid: [{ request: { ...permission, status: 'allowed', decision: { by: IAN, at: T, always: 'topic' } } }, { request: editPermission }],
      invalid: [{ request: { ...permission, status: 'granted' } }],
    },
  },
  'permission.updated': {
    payload: {
      valid: [{ request: permission }, { request: outsidePermission }, { request: { ...outsidePermission, path: undefined } }, { request: { ...permission, hostOnly: true, gate: 'writes-settings-script' } }, { request: { ...permission, gate: 'may-reach-settings-script' } }, { request: { ...permission, hostOnly: true, gate: 'writes-unknown' } }],
      invalid: [{ request: { ...permission, noAlways: 'because' } }, { request: { ...permission, hostOnly: undefined } }, { request: { ...permission, gate: 'because' } }],
    },
  },

  // ---- suggest.* ------------------------------------------------------------------------------------------------
  'suggest.create': {
    payload: {
      valid: [
        { sessionId: 'sess_a', text: 'please run the tests' },
        { sessionId: 'sess_a', text: 'look here', source: { file: FILE, startLine: 1, endLine: 1 }, mentions: [HOST] },
        // invisible and control characters are removed by the daemon (agentText), not refused
        { sessionId: 'sess_a', text: 'evil ‮ reversed' },
      ],
      invalid: [
        { sessionId: 'sess_a', text: '   \n\t' },
        { sessionId: 'sess_a', text: 'x', source: { file: FILE, startLine: 5, endLine: 4 } },
        { sessionId: 'sess_a', text: 'x'.repeat(64 * KiB + 1) },
        { sessionId: 'sess_a', text: 'x', origin: 'revise' },
      ],
    },
    result: {
      valid: [{ suggestion }, { suggestion: { ...suggestion, cleaned: true, origin: 'follow-up', topicId: 'tp_1', itemId: 'cart-api', mentions: [HOST] } }],
      invalid: [
        { suggestion: { ...suggestion, status: 'auto-accepted' } },
        { suggestion: { ...suggestion, origin: undefined } },
        { suggestion: { ...suggestion, text: 'stored ‮ text is clean' } },
      ],
    },
  },
  'suggest.edit': {
    payload: { valid: [{ suggestionId: 'sg_1', text: 'better wording' }], invalid: [{ suggestionId: 'sg_1', text: '' }] },
    result: { valid: [{ suggestion }], invalid: [{}] },
  },
  'suggest.withdraw': {
    payload: { valid: [{ suggestionId: 'sg_1' }], invalid: [{ suggestionId: 'sg_1', reason: 'x' }] },
    result: { valid: [{ suggestion: { ...suggestion, status: 'withdrawn', resolvedAt: T } }], invalid: [{ suggestion: { ...suggestion, author: 'Amy' } }] },
  },
  'suggest.accept': {
    payload: { valid: [{ suggestionId: 'sg_1' }, { suggestionId: 'sg_1', text: 'edited by owner' }], invalid: [{ suggestionId: 'sg_1', text: 'x'.repeat(64 * KiB + 1) }] },
    result: {
      valid: [{ suggestion: { ...suggestion, status: 'accepted-modified', resolvedAt: T, finalText: 'edited by owner', decidedBy: IAN } }],
      invalid: [{ suggestion: { ...suggestion, createdAt: 'yesterday' } }],
    },
  },
  'suggest.reject': {
    payload: { valid: [{ suggestionId: 'sg_1' }, { suggestionId: 'sg_1', reason: '先不要' }], invalid: [{ suggestionId: 'sg_1', reason: 'line1\nline2' }] },
    result: { valid: [{ suggestion: { ...suggestion, status: 'rejected', resolvedAt: T, rejectReason: '先不要', decidedBy: IAN } }], invalid: [{ suggestion: null }] },
  },
  'suggest.list': {
    payload: { valid: [{}, { sessionId: 'sess_a' }, { sessionId: 'sess_a', after: 'sg_1' }], invalid: [{ sessionId: null }, { after: '' }] },
    result: { valid: [{ suggestions: [suggestion], hasMore: false }, { suggestions: [], hasMore: true }], invalid: [{ suggestions: [{ ...suggestion, id: '' }], hasMore: false }, { suggestions: [suggestion] }] },
  },
  'suggest.updated': {
    payload: {
      valid: [{ suggestion }, { suggestion: { ...suggestion, status: 'rejected', resolvedAt: T, closedReason: 'topic-archived' } }],
      invalid: [{ suggestion: { ...suggestion, text: 42 } }, { suggestion: { ...suggestion, closedReason: 'timeout' } }],
    },
  },

  // ---- topic.* / plan.* / report.* --------------------------------------------------------------------------------
  'topic.create': {
    payload: {
      valid: [{ name: 'Checkout' }, { name: '結帳流程', slug: 'topic-3', firstMessage: 'We need a cart.' }, { name: 'Checkout', model: 'fable' }],
      invalid: [
        { name: '' },
        { name: '   ' },
        { name: 'x'.repeat(121) },
        { name: 'Checkout', slug: 'Check Out' },
        { name: 'Checkout', slug: '../x' },
        { name: 'Checkout', slug: '-a' },
        { name: 'Checkout', model: null },
        { name: 'Checkout', permissionMode: 'auto' },
      ],
    },
    result: { valid: [{ topic, session: agentSession }], invalid: [{ topic }, { topic, session }] },
  },
  'topic.list': {
    payload: { valid: [{}, { archived: true }, { after: 'tp_1' }], invalid: [{ archived: 'yes' }] },
    result: {
      valid: [{ topics: [topic, { ...topic, id: 'tp_2', slug: 'topic-2', phase: 'discussing', discussion: 'lost', discussionSessionId: undefined }], hasMore: false }, { topics: [readyTopic, checkedTopic, pausedTopic], hasMore: false }],
      invalid: [
        { topics: [topic] },
        { topics: [{ ...topic, phase: 'archived' }], hasMore: false },
        { topics: [{ ...topic, slug: 'Checkout' }], hasMore: false },
        // protocol 6: every topic counts its items left out and undone
        { topics: [{ ...topic, plan: { ...topic.plan, leftOut: undefined } }], hasMore: false },
        { topics: [{ ...topic, plan: { ...topic.plan, undone: -1 } }], hasMore: false },
        { topics: [{ ...checkedTopic, checked: { by: AMY_REF } }], hasMore: false },
      ],
    },
  },
  'topic.updated': { payload: { valid: [{ topic }], invalid: [{ topic: { ...topic, rules: [{ ...rule, pattern: '' }] } }] } },
  'topic.removed': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{ topic }] } },
  'topic.rename': {
    payload: { valid: [{ topicId: 'tp_1', name: '結帳' }], invalid: [{ topicId: 'tp_1', name: '' }, { topicId: 'tp_1', name: 'x', slug: 'y' }] },
    result: { valid: [{ topic }], invalid: [{}] },
  },
  'topic.archive': {
    payload: { valid: [{ topicId: 'tp_1', archived: true }, { topicId: 'tp_1', archived: true, deleteUnmerged: true }, { topicId: 'tp_1', archived: false }], invalid: [{ topicId: 'tp_1' }] },
    result: { valid: [{ topic: { ...topic, archived: true } }], invalid: [{}] },
  },
  'topic.delete': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] }, result: emptyOnly },
  'topic.discussion.restart': {
    payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] },
    result: { valid: [{ topic, session: agentSession }], invalid: [{ topic }] },
  },
  'topic.revise': {
    payload: {
      valid: [
        { topicId: 'tp_1', target: 'spec', text: 'Make the scope smaller' },
        { topicId: 'tp_1', target: 'plan', text: 'Split item 2', quote: { heading: 'Behaviour', text: 'The cart keeps items.' }, mentions: [HOST] },
      ],
      invalid: [{ topicId: 'tp_1', target: 'report', text: 'x' }, { topicId: 'tp_1', target: 'spec', text: '' }, { topicId: 'tp_1', target: 'spec', text: 'x', quote: { text: '' } }],
    },
    result: { valid: [{ messageId: 'm_1' }, { suggestion: { ...suggestion, origin: 'revise', topicId: 'tp_1' } }], invalid: [{}, { messageId: 'm_1', suggestion }] },
  },
  'topic.spec.request': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] }, result: emptyOnly },
  'topic.rule.add': {
    payload: {
      valid: [{ topicId: 'tp_1', tool: 'Bash', pattern: 'pnpm test *' }, { topicId: 'tp_1', tool: 'WebFetch', pattern: 'domain:example.com' }],
      invalid: [{ topicId: 'tp_1', tool: 'Edit', pattern: 'src/**' }, { topicId: 'tp_1', tool: 'Bash', pattern: '' }, { topicId: 'tp_1', tool: 'Bash', pattern: 'a\nb' }],
    },
    result: { valid: [{ topic }], invalid: [{}] },
  },
  'topic.rule.remove': { payload: { valid: [{ topicId: 'tp_1', ruleId: 'rl_1' }], invalid: [{ topicId: 'tp_1' }] }, result: { valid: [{ topic }], invalid: [{}] } },
  'topic.agent.set': {
    payload: {
      valid: [{ topicId: 'tp_1', model: 'opus' }, { topicId: 'tp_1', permissionMode: 'ask-commands' }, { topicId: 'tp_1', model: null, permissionMode: null }],
      invalid: [{ topicId: 'tp_1' }, { topicId: 'tp_1', permissionMode: 'ask-nothing' }, { topicId: 'tp_1', model: 'not a model' }, { topicId: 'tp_1', model: 'opus', extra: 1 }],
    },
    result: { valid: [{ topic: { ...topic, agent: { model: 'opus', permissionMode: 'ask-commands' } } }], invalid: [{}, { topic: { ...topic, agent: { model: 'opus' } } }] },
  },
  'plan.generate': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] }, result: emptyOnly },
  'plan.get': {
    payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] },
    result: {
      valid: [{ plan }, { plan: null }],
      invalid: [{}, { plan: { ...plan, items: [{ ...workItem, id: 'Cart API' }] } }, { plan: { ...plan, items: [{ ...workItem, state: 'merged' }] } }, { plan: { ...plan, specHash: 'abc' } }],
    },
  },
  'plan.updated': {
    payload: {
      valid: [{ plan }, { plan: autoPlan }],
      invalid: [
        { plan: null },
        // protocol 6: what a work item says about its merge
        { plan: { ...plan, waitingFor: [{ user: IAN, questions: 1, permissions: 0, reports: 2, since: T }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, merging: 'smurg' }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, autoMerge: { ...heldItem.autoMerge, reason: 'tired' } }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, autoMerge: { ...heldItem.autoMerge, state: 'waiting' } }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, autoMerge: { ...heldItem.autoMerge, hostOnly: true } }] } },
        { plan: { ...autoPlan, items: [{ ...hostHeldItem, autoMerge: { ...hostHeldItem.autoMerge, escalated: true } }] } },
        { plan: { ...autoPlan, items: [{ ...hostHeldItem, autoMerge: { ...hostHeldItem.autoMerge, paths: Array.from({ length: 21 }, (_, i) => `f${i}.txt`) } }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, autoMerge: { ...heldItem.autoMerge, people: conflictItem.autoMerge.people } }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, autoMerge: { ...heldItem.autoMerge, asked: IAN } }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, autoMerge: { ...heldItem.autoMerge, branch: branchHeldItem.autoMerge.branch } }] } },
        { plan: { ...autoPlan, items: [{ ...mergedAutoItem, merged: { at: T, by: 'host' } }] } },
        { plan: { ...autoPlan, items: [{ ...heldItem, waiting: 'card' }] } },
      ],
    },
  },
  'plan.mode.set': { payload: { valid: [{ topicId: 'tp_1', mode: 'everyone' }], invalid: [{ topicId: 'tp_1', mode: 'nobody' }] }, result: { valid: [{ plan }], invalid: [{}] } },
  'plan.assign': {
    payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api', userId: AMY }, { topicId: 'tp_1', itemId: 'cart-api', userId: null }], invalid: [{ topicId: 'tp_1', itemId: 'cart-api' }, { topicId: 'tp_1', itemId: 'Cart', userId: null }] },
    result: { valid: [{ plan }], invalid: [{}] },
  },
  'plan.suggest': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] }, result: { valid: [{ plan }], invalid: [{}] } },
  'plan.preflight': {
    payload: { valid: [{ topicId: 'tp_1' }, { topicId: 'tp_1', itemIds: ['cart-api'] }], invalid: [{ topicId: 'tp_1', itemIds: [] }] },
    result: {
      valid: [{ preflight }, { preflight: { ...preflight, commit: null } }, { preflight: smurgHistoryPreflight }, { preflight: directPreflight }, { preflight: detachedPreflight }, { preflight: hostMergesPreflight }],
      invalid: [
        { preflight: { ...preflight, planHash: undefined } },
        { preflight: { ...preflight, invisibleCharacters: ['report'] } },
        // protocol 5: what goes with each history
        { preflight: { ...preflight, history: 'unchecked' } },
        { preflight: { ...preflight, history: undefined } },
        { preflight: { ...preflight, direct: directPreflight.direct } },
        { preflight: { ...directPreflight, direct: null } },
        { preflight: { ...smurgHistoryPreflight, commit: preflight.commit } },
        { preflight: { ...preflight, nestedRepos: ['frontend'] } },
        { preflight: { ...preflight, cloudSynced: true } },
        { preflight: { ...preflight, nestedRepos: Array.from({ length: 21 }, (_, i) => `repo-${i}`), history: 'smurg', commit: null } },
        { preflight: { ...preflight, agent: { model: null, permissionMode: 'ask-nothing', effective: 'ask-nothing' } } },
        { preflight: { ...preflight, agent: { model: null, permissionMode: null } } },
        // protocol 6: how the items merge, said unless they run directly in the folder; a detached HEAD is the host's
        { preflight: { ...preflight, merging: undefined } },
        { preflight: { ...preflight, merging: null } },
        { preflight: { ...directPreflight, merging: preflight.merging } },
        { preflight: { ...preflight, merging: { workspace: 'auto', proposed: 'auto', detached: true } } },
        { preflight: { ...smurgHistoryPreflight, merging: { workspace: 'auto', proposed: 'host', detached: true } } },
        { preflight: { ...preflight, merging: { workspace: 'host', proposed: 'auto', detached: false } } },
      ],
    },
  },
  'plan.start': {
    payload: {
      valid: [
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH },
        { topicId: 'tp_1', itemIds: ['cart-api'], planRevision: 4, specHash: HASH, planHash: HASH },
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, agent: { model: 'sonnet', permissionMode: 'ask-commands' } },
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, agent: { model: null }, direct: true },
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, agent: {} },
        // protocol 6: "The host merges each item" of this Start
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, merging: 'host' },
      ],
      invalid: [
        { topicId: 'tp_1' },
        { topicId: 'tp_1', planRevision: 4, specHash: HASH },
        { topicId: 'tp_1', planRevision: 4, specHash: 'x', planHash: HASH },
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, direct: false },
        // nobody asks for smurg's merge: the workspace's setting gives it
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, merging: 'auto' },
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, agent: { permissionMode: 'ask-nothing' } },
        { topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH, agent: { model: 'opus', mode: 'auto' } },
      ],
    },
    result: { valid: [{ plan }], invalid: [{}] },
  },
  'plan.changes': {
    payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}, { topicId: 'tp_1', target: 'spec' }] },
    result: {
      valid: [
        { files: [] },
        { files: [{ target: 'spec', diff: '--- a/specs/checkout/SPEC.md\n+++ b/specs/checkout/SPEC.md\n@@ -3 +3 @@\n-The cart is kept in the browser.\n+The cart is kept on the server.\n', truncated: false }, { target: 'plan', diff: '', truncated: true }] },
      ],
      invalid: [{ files: [{ target: 'report', diff: '', truncated: false }] }, { files: [{ target: 'spec', diff: '' }] }, {}],
    },
  },
  'plan.resume': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] }, result: { valid: [{ plan }], invalid: [{}] } },
  'plan.item.retry': { payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api' }], invalid: [{ topicId: 'tp_1' }] }, result: { valid: [{ plan }], invalid: [{}] } },
  'plan.item.continue': { payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api' }], invalid: [{ itemId: 'cart-api' }] }, result: emptyOnly },
  'plan.item.resolve': { payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api' }], invalid: [{ topicId: 'tp_1', itemId: '' }] }, result: emptyOnly },
  'report.get': {
    payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api' }], invalid: [{ topicId: 'tp_1' }] },
    result: {
      valid: [{ report }, { report: { ...report, changes: undefined, noChanges: 'spec-files', questions: [] } }, { report: { ...report, changes: undefined, noChanges: 'no-history', questions: [] } }, { report: failedReport }],
      invalid: [
        { report: reportSummary },
        { report: { ...report, outcome: 'done' } },
        { report: { ...report, sections: { ...report.sections, verified: [{ text: 'x' }] } } },
        // protocol 6: a failed check did not pass and says what happened
        { report: { ...failedReport, sections: { ...failedReport.sections, verified: [{ text: 'x', passed: true, failed: true, note: 'y' }] } } },
        { report: { ...failedReport, sections: { ...failedReport.sections, verified: [{ text: 'x', passed: false, failed: true }] } } },
        { report: { ...failedReport, sections: { ...failedReport.sections, verified: [{ text: 'x', passed: false, failed: false, note: 'y' }] } } },
        { report: { ...failedReport, changes: { ...failedReport.changes, byHandTruncated: false } } },
      ],
    },
  },
  'report.updated': {
    payload: {
      valid: [
        { topicId: 'tp_1', itemId: 'cart-api', report: reportSummary },
        { topicId: 'tp_1', itemId: 'cart-api', report: { ...reportSummary, state: 'reviewed', escalatedAt: T, review: { by: IAN, at: T, version: 2, insteadOf: AMY_REF } } },
        { topicId: 'tp_1', itemId: 'cart-api', report: { ...reportSummary, state: 'invalid', error: { ...wireText, line: 3 } } },
      ],
      invalid: [{ topicId: 'tp_1', report: reportSummary }, { topicId: 'tp_1', itemId: 'cart-api', report: { ...reportSummary, version: 0 } }],
    },
  },
  'report.followUp': {
    payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api', text: 'Why not check stock here?' }], invalid: [{ topicId: 'tp_1', itemId: 'cart-api', text: '' }, { topicId: 'tp_1', text: 'x' }] },
    result: { valid: [{ messageId: 'm_9' }, { suggestion: { ...suggestion, origin: 'follow-up', topicId: 'tp_1', itemId: 'cart-api' } }], invalid: [{}] },
  },
  'report.review': {
    payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api', version: 2 }, { topicId: 'tp_1', itemId: 'cart-api', version: 2, acknowledgeUnfinished: true }], invalid: [{ topicId: 'tp_1', itemId: 'cart-api' }, { topicId: 'tp_1', itemId: 'cart-api', version: 0 }] },
    result: { valid: [{ report: { ...reportSummary, state: 'reviewed', review: { by: AMY_REF, at: T, version: 2 } } }], invalid: [{ report }] },
  },

  // ---- inbox.* ----------------------------------------------------------------------------------------------------
  'inbox.list': {
    payload: { valid: [{}, { after: 'question:q_1' }], invalid: [{ userId: AMY }, { after: 'no key' }] },
    result: {
      valid: [{ items: INBOX_SAMPLES, hasMore: false }, { items: [], hasMore: true }, ...INBOX_SAMPLES.map((item) => ({ items: [item], hasMore: false }))],
      invalid: [
        { items: [inboxItem] },
        { items: [{ ...inboxItem, kind: 'todo' }], hasMore: false },
        { items: [{ ...inboxItem, target: { kind: 'file', path: 'a' } }], hasMore: false },
        { items: [{ ...inboxItem, alsoFor: Array.from({ length: 6 }, () => AMY_REF) }], hasMore: false },
        // each kind carries its own fields and no others (INBOX_KIND_FIELDS)
        { items: [{ ...inboxItem, allVoted: undefined }], hasMore: false },
        { items: [{ ...inboxItem, anchor: { seq: 10 } }], hasMore: false },
        { items: [{ ...inboxItem, outcome: 'complete' }], hasMore: false },
        { items: [{ ...voteItem, allVoted: false }], hasMore: false },
        { items: [{ ...permissionItem, item: undefined }], hasMore: false },
        { items: [{ ...suggestionItem, count: undefined }], hasMore: false },
        { items: [{ ...reportItem, checks: undefined }], hasMore: false },
        { items: [{ ...mergeItem, outcome: 'complete', checks: { passed: 4, notVerified: 0 } }], hasMore: false },
        { items: [{ ...mentionItem, from: undefined }], hasMore: false },
        { items: [{ ...resultItem, result: 'accepted' }], hasMore: false },
        { items: [{ ...resultItem, result: undefined }], hasMore: false },
        { items: [{ ...attentionItem, subject: undefined }], hasMore: false },
        // `waiting` follows the kind; the key names the kind (and the subject)
        { items: [{ ...reportItem, waiting: true }], hasMore: false },
        { items: [{ ...hostRulesItem, waiting: true }], hasMore: false },
        { items: [{ ...agentsAutoItem, waiting: true }], hasMore: false },
        { items: [{ ...voteItem, key: 'question:q_1' }], hasMore: false },
        { items: [{ ...accountItem, key: 'attention:storage:workspace' }], hasMore: false },
        // a console target names one of the console's sections
        { items: [{ ...accountItem, target: { kind: 'console', section: 'agents' } }], hasMore: false },
        // protocol 6: a decision waits and names its reason; a topic ready to check waits for nobody and opens its result
        { items: [{ ...decisionItem, waiting: false }], hasMore: false },
        { items: [{ ...decisionItem, reason: undefined }], hasMore: false },
        { items: [{ ...decisionItem, reason: 'tired' }], hasMore: false },
        { items: [{ ...decisionItem, tally: readyItem.tally }], hasMore: false },
        { items: [{ ...readyItem, waiting: true }], hasMore: false },
        { items: [{ ...readyItem, tally: undefined }], hasMore: false },
        { items: [{ ...readyItem, reason: 'partial' }], hasMore: false },
        { items: [{ ...readyItem, target: { kind: 'result' } }], hasMore: false },
        { items: [{ ...autoMergeNoticeItem, waiting: true }], hasMore: false },
        { items: [{ ...reportItem, reason: 'partial' }], hasMore: false },
      ],
    },
  },
  'inbox.changed': {
    payload: {
      valid: [{ upsert: [inboxItem], remove: ['mention:nt_4'] }, { upsert: [], remove: [] }, { upsert: INBOX_SAMPLES, remove: [] }],
      invalid: [{ upsert: [inboxItem] }, { upsert: [], remove: [''] }, { upsert: [{ ...attentionItem, subject: 'tired' }], remove: [] }],
    },
  },
  'inbox.seen': { payload: { valid: [{ keys: ['mention:nt_4', 'question:q_1'] }], invalid: [{ keys: [] }, { keys: 'all' }] } },
  'inbox.dismiss': { payload: { valid: [{ key: 'result:nt_5' }], invalid: [{ keys: ['result:nt_5'] }] }, result: emptyOnly },

  // ---- worktree.* -----------------------------------------------------------------------------------------------
  'worktree.list': {
    payload: emptyOnly,
    result: { valid: [{ worktrees: [worktree] }], invalid: [{ worktrees: [{ ...worktree, sharedDirs: ['/data'] }] }] },
  },
  'worktree.remove': { payload: { valid: [{ worktreeId: 'wt_1' }], invalid: [{ worktreeId: '../wt' }] }, result: emptyOnly },
  'worktree.merge.request': {
    payload: { valid: [{ worktreeId: 'wt_1' }, { worktreeId: 'wt_1', message: 'done\n- tests' }], invalid: [{ worktreeId: 'wt_1', message: 'x'.repeat(4_001) }] },
    result: {
      valid: [{ request: mergeRequest }, { request: { ...mergeRequest, commit: 'a'.repeat(64) } }, { request: draftRequest }],
      invalid: [
        { request: { ...mergeRequest, status: 'open' } },
        { request: { ...mergeRequest, commit: 'HEAD' } },
        { request: { ...mergeRequest, commit: undefined } },
        { request: { ...mergeRequest, reviewed: undefined } },
      ],
    },
  },
  'worktree.merge.list': {
    payload: emptyOnly,
    result: {
      valid: [
        { requests: [mergeRequest, { ...mergeRequest, id: 'mr_2', status: 'conflict', conflictFiles: ['src/app.ts'], decidedAt: T }] },
        // protocol 6: merged by smurg, and a merge the host undid
        { requests: [{ ...draftRequest, status: 'merged', decidedAt: T, auto: true }, { ...draftRequest, id: 'mr_3', status: 'merged', decidedAt: T, auto: true, undone: { commit: 'f'.repeat(40), at: T, by: IAN } }] },
      ],
      invalid: [{ requests: [{ ...mergeRequest, conflictFiles: ['../x'] }] }, { requests: [{ ...draftRequest, auto: false }] }, { requests: [{ ...draftRequest, undone: { commit: 'HEAD', at: T, by: IAN } }] }],
    },
  },
  'worktree.merge.diff': {
    payload: { valid: [{ requestId: 'mr_1' }], invalid: [{ requestId: 'mr_1', context: 3 }] },
    result: {
      valid: [
        {
          diff: 'diff --git a/src/app.ts b/src/app.ts\n+x\n',
          truncated: false,
          files: [
            { path: '.envrc', status: 'modified', additions: 0, deletions: 0, hidden: true },
            { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 },
            { path: 'img.png', status: 'added', additions: 0, deletions: 0, binary: true },
            { path: 'b.ts', status: 'renamed', additions: 0, deletions: 0, oldPath: 'a.ts' },
          ],
        },
      ],
      invalid: [{ diff: 'x', truncated: false, files: [{ path: 'a', status: 'M', additions: 1, deletions: 0 }] }, { diff: 'x\u0000', truncated: false, files: [] }],
    },
  },
  'worktree.merge.fileDiff': {
    payload: { valid: [{ requestId: 'mr_1', path: 'src/app.ts' }], invalid: [{ requestId: 'mr_1', path: '../x' }, { requestId: 'mr_1', path: '' }, { requestId: 'mr_1' }] },
    result: {
      valid: [
        { path: 'src/app.ts', diff: 'diff --git a/src/app.ts b/src/app.ts\n+x\n', truncated: false, binary: false },
        { path: 'img.png', diff: '', truncated: false, binary: true },
        { path: '.envrc', diff: '', truncated: false, binary: false, hidden: true },
      ],
      invalid: [{ path: 'src/app.ts', diff: 'x', truncated: false }, { path: '/etc/passwd', diff: '', truncated: false, binary: false }],
    },
  },
  'worktree.merge.approve': {
    payload: { valid: [{ requestId: 'mr_1' }], invalid: [{}] },
    result: { valid: [{ request: { ...mergeRequest, status: 'merged', decidedAt: T } }], invalid: [{ request: { ...mergeRequest, requestedBy: HOST } }] },
  },
  'worktree.merge.reject': {
    payload: { valid: [{ requestId: 'mr_1' }, { requestId: 'mr_1', reason: '請先修正測試' }], invalid: [{ requestId: 'mr_1', reason: 7 }] },
    result: { valid: [{ request: { ...mergeRequest, status: 'rejected', decidedAt: T, rejectReason: '請先修正測試' } }], invalid: [{ request: {} }] },
  },
  'worktree.updated': { payload: { valid: [{ worktree }], invalid: [{ worktree: { ...worktree, kept: 1 } }] } },
  'worktree.merge.updated': { payload: { valid: [{ request: mergeRequest }, { request: draftRequest }], invalid: [{ request: mergeRequest, extra: true }] } },
  'worktree.removed': { payload: { valid: [{ worktreeId: 'wt_1' }], invalid: [{ worktree }] } },

  // ---- admin.* --------------------------------------------------------------------------------------------------
  'admin.invite.create': {
    payload: {
      valid: [{ role: 'editor' }, { role: 'agent', expiresInSec: 86_400, maxUses: 5 }],
      invalid: [{ role: 'host' }, { role: 'viewer', maxUses: 0 }, { role: 'runner' }],
    },
    result: {
      valid: [{ invite, url: 'https://smurg.app/join/AbCdEfGh_-012345#k=abc&s=def' }],
      invalid: [{ invite, url: 'javascript alert(1)' }],
    },
  },
  'admin.invite.list': { payload: emptyOnly, result: { valid: [{ invites: [invite] }], invalid: [{ invites: [{ ...invite, uses: -1 }] }] } },
  'admin.invite.revoke': { payload: { valid: [{ inviteId: 'inv_1' }], invalid: [{ inviteId: '' }] }, result: emptyOnly },
  'admin.member.list': {
    payload: emptyOnly,
    result: { valid: [{ members: [{ ...guestMember, devices: [device] }] }], invalid: [{ members: [guestMember] }] },
  },
  'admin.member.setRole': {
    payload: { valid: [{ userId: AMY, role: 'agent' }], invalid: [{ userId: AMY, role: 'host' }, { userId: 'amy', role: 'viewer' }, { userId: AMY, role: 'runner' }] },
    result: { valid: [{ member: { ...guestMember, role: 'agent' } }], invalid: [{ member: { ...guestMember, avatarUrl: 'http://x/y.png' } }] },
  },
  'admin.member.kick': { payload: { valid: [{ userId: AMY }], invalid: [{ userId: 'root' }] }, result: emptyOnly },
  'admin.session.terminate': { payload: { valid: [{ sessionId: 'sess_2' }], invalid: [{ session: 'sess_2' }] }, result: emptyOnly },
  'admin.audit.query': {
    payload: { valid: [{}, { limit: 100, before: T }], invalid: [{ before: -5 }] },
    result: { valid: [{ entries: [audit] }], invalid: [{ entries: [{ ...audit, action: 'coffee.make' }] }, { entries: [{ ...audit, detail: { prototype: {} } }] }] },
  },
  'admin.audit.entry': { payload: { valid: [{ entry: audit }], invalid: [{ entry: { ...audit, outcome: 'meh' } }] } },
  'admin.settings.get': {
    payload: emptyOnly,
    result: {
      valid: [{ settings: hostSettings }],
      invalid: [
        { settings: { ...hostSettings, uploadChunkSize: 16 * MiB } },
        { settings: { ...hostSettings, guestSubscriptionLogin: true } },
        { settings: { ...hostSettings, allowedDomains: ['pypi.org'] } },
      ],
    },
  },
  'admin.settings.set': {
    payload: {
      valid: [{}, { diskReserveBytes: 10 * GiB }, { sharedDirs: ['data'] }, { maxLiveAgents: 2, escalateAfterMs: 60_000, agentMcp: true }, { permissionMode: 'ask-nothing' }, { permissionMode: 'ask-commands' }, { merging: 'host' }, { merging: 'auto' }],
      invalid: [
        { merging: 'never' },
        { merging: null },
        { permissionMode: 'bypassPermissions' },
        { permissionMode: null },
        { diskReservePercent: 101 },
        { maxLiveAgents: 1 },
        { maxLiveAgents: 33 },
        { escalateAfterMs: 59_999 },
        { agentMcp: 'yes' },
        { sandbox: false },
        { humanLockIdleMs: 10 },
        // gone with the guest sandbox (ARCHITECTURE §11 D-15)
        { allowedDomains: ['pypi.org'] },
        { guestSubscriptionLogin: false },
        { guestMainWorkspace: true },
      ],
    },
    result: { valid: [{ settings: hostSettings }], invalid: [{ settings: { ...hostSettings, diskReservePercent: -1 } }] },
  },
  'admin.claudeConfig.get': {
    payload: { valid: [{}, { after: 'wt:wt_1' }], invalid: [{ root: MAIN }] },
    result: {
      valid: [
        { roots: [{ root: MAIN, state: 'ignored', files: [claudeConfigFile] }, { root: WT, state: 'none', files: [] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [{ ...claudeConfigFile, decision: 'trust', needsAck: [] }] }], hasMore: true },
        // A summary that is not whole says so; a variable that changes which programs run; the entry for the rest of `.claude/`.
        {
          roots: [
            {
              root: MAIN,
              state: 'ignored',
              files: [
                { ...claudeConfigFile, env: [{ name: 'NODE_OPTIONS', flagged: false, programs: true }], needsAck: ['incomplete'], cut: { omitted: 3, shortened: 1 } },
                { ...claudeConfigFile, scripts: [{ path: 'scripts/lint.sh', hash: HASH }, { path: 'scripts/optional.sh', hash: HASH, absent: true }], needsAck: ['incomplete'], unfollowed: 2 },
                { ...claudeConfigFile, path: '.claude', text: `${HASH}  .claude/agents/reviewer.md`, runs: ['hook in .claude/agents/reviewer.md: ./scripts/check.sh'], env: [], otherKeys: ['.claude/agents/reviewer.md'], needsAck: [] },
              ],
            },
          ],
          hasMore: false,
        },
      ],
      invalid: [
        { roots: [{ root: MAIN, state: 'ignored', files: [claudeConfigFile] }] },
        { roots: [{ root: MAIN, state: 'trusted', files: [] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [{ ...claudeConfigFile, hash: 'abc' }] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [{ ...claudeConfigFile, cut: { omitted: -1, shortened: 0 } }] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [{ ...claudeConfigFile, cut: { omitted: 1 } }] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [{ ...claudeConfigFile, needsAck: ['whole'] }] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [{ ...claudeConfigFile, scripts: [{ path: 'scripts/optional.sh', hash: HASH, absent: false }] }] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [{ ...claudeConfigFile, unfollowed: -1 }] }], hasMore: false },
        { roots: [{ root: MAIN, state: 'used', files: [claudeConfigFile, claudeConfigFile, claudeConfigFile, claudeConfigFile, claudeConfigFile] }], hasMore: false },
      ],
    },
  },
  'admin.claudeConfig.decide': {
    payload: {
      valid: [
        { root: MAIN, files: [{ path: '.mcp.json', hash: HASH }], decision: 'trust', acknowledged: ['allows-tools'] },
        { root: WT, files: [{ path: '.claude/settings.json', hash: HASH }], decision: 'ignore', acknowledged: [] },
        { root: MAIN, files: [{ path: '.claude/settings.json', hash: HASH }, { path: '.claude/settings.local.json', hash: HASH }, { path: '.mcp.json', hash: HASH }, { path: '.claude', hash: HASH }], decision: 'trust', acknowledged: ['credentials', 'allows-tools', 'incomplete'] },
      ],
      invalid: [{ root: MAIN, files: [], decision: 'trust', acknowledged: [] }, { root: MAIN, files: [{ path: '.mcp.json', hash: HASH }], decision: 'always', acknowledged: [] }, { root: MAIN, files: [{ path: '.mcp.json' }], decision: 'trust', acknowledged: [] }],
    },
    result: emptyOnly,
  },
  'admin.hostRules.get': {
    payload: emptyOnly,
    result: {
      valid: [{ rules: [{ rule: 'Bash(npm run *)', source: 'user' }, { rule: 'mcp__mail', source: 'project' }], seen: false }, { rules: [], seen: true }],
      invalid: [{ rules: [{ rule: 'Bash(npm run *)', source: 'cli' }], seen: false }, { rules: [] }, { decision: 'ask', rules: [], seen: true }],
    },
  },
  'admin.hostRules.seen': { payload: emptyOnly, result: emptyOnly },
  'admin.notice.seen': { payload: { valid: [{ notice: 'agents-auto' }, { notice: 'auto-merge' }], invalid: [{}, { notice: 'host-rules' }, { notice: 'agents-auto', also: 1 }] }, result: emptyOnly },
  'admin.transcript.redact': { payload: { valid: [{ sessionId: 'sess_a', seq: 7 }], invalid: [{ sessionId: 'sess_a', seq: 0 }, { sessionId: 'sess_a' }] }, result: emptyOnly },
};
