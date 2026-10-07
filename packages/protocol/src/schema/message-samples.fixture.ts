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
  modeFixed: true,
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
  permissionMode: 'ask-commands',
  modeFixed: false,
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
  plan: { exists: true, valid: false, error: { ...wireText, line: 12 }, generating: false, stale: true, mode: 'assigned', paused: false, changedAt: T, changedBy: { kind: 'user', ...AMY_REF }, items: 3, started: 1, reviewed: 0, merged: 0 },
  rules: [rule],
};
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
  waitingFor: [{ user: IAN, questions: 1, permissions: 0, reports: 2, since: T }],
  slots: { inUse: 2, max: 8, waitingForPeople: 1 },
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
  blockers: [{ text: { id: 'plan.start.noGit' }, fallback: 'Work items run in git worktrees.' }],
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
/** One valid item of every kind (and of the attention subjects that differ). */
export const INBOX_SAMPLES = [inboxItem, voteItem, permissionItem, suggestionItem, reportItem, attentionItem, accountItem, hostRulesItem, pausedItem, mergeItem, requestedMergeItem, mentionItem, resultItem];
export const hostState = { account: { state: 'usage-limit', resetsAt: T + 3_600_000, sessions: 4 }, mainProjectSettings: 'ignored' };
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
      ],
      invalid: [
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
      valid: [{ account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'none' }, hostState],
      invalid: [{ account: { state: 'ok' }, mainProjectSettings: 'none' }, { account: { state: 'rate-limited', sessions: 1 }, mainProjectSettings: 'used' }, { account: { state: 'ok', sessions: 0 } }],
    },
  },
  'session.host': {
    payload: {
      valid: [hostState, { account: { state: 'logged-out', sessions: 2 }, mainProjectSettings: 'used' }],
      invalid: [{ account: { state: 'ok', sessions: 0 }, mainProjectSettings: 'trusted' }, { ...hostState, login: 'logged-out' }],
    },
  },
  'session.state': {
    payload: {
      valid: [{ session }, { session: { ...itemSession, status: 'ended', endedAt: T, endReason: 'merged' } }],
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
    payload: { valid: [{ sessionId: 'sess_i', mode: 'ask-all' }], invalid: [{ sessionId: 'sess_i', mode: 'ask-nothing' }, { sessionId: 'sess_i', mode: 'bypassPermissions' }] },
    result: { valid: [{ session: { ...itemSession, permissionMode: 'ask-all' } }], invalid: [{}] },
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
      valid: [{ request: permission }, { request: outsidePermission }, { request: { ...outsidePermission, path: undefined } }],
      invalid: [{ request: { ...permission, noAlways: 'because' } }, { request: { ...permission, hostOnly: undefined } }],
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
      valid: [{ name: 'Checkout' }, { name: '結帳流程', slug: 'topic-3', firstMessage: 'We need a cart.' }],
      invalid: [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 'Checkout', slug: 'Check Out' }, { name: 'Checkout', slug: '../x' }, { name: 'Checkout', slug: '-a' }],
    },
    result: { valid: [{ topic, session: agentSession }], invalid: [{ topic }, { topic, session }] },
  },
  'topic.list': {
    payload: { valid: [{}, { archived: true }, { after: 'tp_1' }], invalid: [{ archived: 'yes' }] },
    result: {
      valid: [{ topics: [topic, { ...topic, id: 'tp_2', slug: 'topic-2', phase: 'discussing', discussion: 'lost', discussionSessionId: undefined }], hasMore: false }],
      invalid: [{ topics: [topic] }, { topics: [{ ...topic, phase: 'archived' }], hasMore: false }, { topics: [{ ...topic, slug: 'Checkout' }], hasMore: false }],
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
  'plan.generate': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] }, result: emptyOnly },
  'plan.get': {
    payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] },
    result: {
      valid: [{ plan }, { plan: null }],
      invalid: [{}, { plan: { ...plan, items: [{ ...workItem, id: 'Cart API' }] } }, { plan: { ...plan, items: [{ ...workItem, state: 'merged' }] } }, { plan: { ...plan, specHash: 'abc' } }],
    },
  },
  'plan.updated': { payload: { valid: [{ plan }], invalid: [{ plan: null }] } },
  'plan.mode.set': { payload: { valid: [{ topicId: 'tp_1', mode: 'everyone' }], invalid: [{ topicId: 'tp_1', mode: 'nobody' }] }, result: { valid: [{ plan }], invalid: [{}] } },
  'plan.assign': {
    payload: { valid: [{ topicId: 'tp_1', itemId: 'cart-api', userId: AMY }, { topicId: 'tp_1', itemId: 'cart-api', userId: null }], invalid: [{ topicId: 'tp_1', itemId: 'cart-api' }, { topicId: 'tp_1', itemId: 'Cart', userId: null }] },
    result: { valid: [{ plan }], invalid: [{}] },
  },
  'plan.suggest': { payload: { valid: [{ topicId: 'tp_1' }], invalid: [{}] }, result: { valid: [{ plan }], invalid: [{}] } },
  'plan.preflight': {
    payload: { valid: [{ topicId: 'tp_1' }, { topicId: 'tp_1', itemIds: ['cart-api'] }], invalid: [{ topicId: 'tp_1', itemIds: [] }] },
    result: { valid: [{ preflight }, { preflight: { ...preflight, commit: null } }], invalid: [{ preflight: { ...preflight, planHash: undefined } }, { preflight: { ...preflight, invisibleCharacters: ['report'] } }] },
  },
  'plan.start': {
    payload: {
      valid: [{ topicId: 'tp_1', planRevision: 4, specHash: HASH, planHash: HASH }, { topicId: 'tp_1', itemIds: ['cart-api'], planRevision: 4, specHash: HASH, planHash: HASH }],
      invalid: [{ topicId: 'tp_1' }, { topicId: 'tp_1', planRevision: 4, specHash: HASH }, { topicId: 'tp_1', planRevision: 4, specHash: 'x', planHash: HASH }],
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
      valid: [{ report }, { report: { ...report, changes: undefined, noChanges: 'spec-files', questions: [] } }],
      invalid: [{ report: reportSummary }, { report: { ...report, outcome: 'done' } }, { report: { ...report, sections: { ...report.sections, verified: [{ text: 'x' }] } } }],
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
        { items: [{ ...voteItem, key: 'question:q_1' }], hasMore: false },
        { items: [{ ...accountItem, key: 'attention:storage:workspace' }], hasMore: false },
        // a console target names one of the console's sections
        { items: [{ ...accountItem, target: { kind: 'console', section: 'agents' } }], hasMore: false },
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
      valid: [{ requests: [mergeRequest, { ...mergeRequest, id: 'mr_2', status: 'conflict', conflictFiles: ['src/app.ts'], decidedAt: T }] }],
      invalid: [{ requests: [{ ...mergeRequest, conflictFiles: ['../x'] }] }],
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
      valid: [{}, { diskReserveBytes: 10 * GiB }, { sharedDirs: ['data'] }, { maxLiveAgents: 2, escalateAfterMs: 60_000, agentMcp: true }],
      invalid: [
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
  'admin.transcript.redact': { payload: { valid: [{ sessionId: 'sess_a', seq: 7 }], invalid: [{ sessionId: 'sess_a', seq: 0 }, { sessionId: 'sess_a' }] }, result: emptyOnly },
};
