// TEST ONLY (`@smurg/protocol/testing`; no production entry point reaches this file). Builders of valid protocol 4
// entities with sensible defaults, for every package's tests: the daemon's fakes, the CLI and the web app
// (`FakeConnection` validates every payload, so a hand-made entity that misses a field fails far from its cause).
//
//   buildQuestion({ sessionId })            buildTopic({ phase: 'plan' })
//   buildInboxItem('report')                buildEvent('text', { text: 'Done.' })
//
// Each result passes its wire schema. An override that is `undefined` REMOVES the default.
import { MAIN_ROOT } from '../schema/paths.ts';
import type {
  AgentSession,
  MergeRequest,
  Suggestion,
  TerminalSession,
  UserRef,
  WorktreeInfo,
} from '../schema/entities.ts';
import type { ConversationEvent, ConversationEventKind, ConversationEventOf, PermissionRequest, Question } from '../schema/conversation.ts';
import type { InboxItem, InboxKind } from '../schema/inbox.ts';
import type { PlanInfo, ReportInfo, ReportSummary, Topic, WorkItem } from '../schema/topics.ts';

export const FAKE_NOW = 1_727_000_000_000;
export const FAKE_HOST: UserRef = Object.freeze({ userId: 'dev:host', displayName: 'Host' });
export const FAKE_HASH = 'a'.repeat(64);
export const FAKE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

export type Overrides<T> = { readonly [K in keyof T]?: T[K] | undefined };

function merge<T extends object>(base: T, overrides: Overrides<T> | undefined): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as T;
}

/**
 * A free agent session, idle, opened by the host. Pass `purpose`, `topicId` (and `itemId`) for a topic's session: the
 * fields that go with them (`topicName`; `item` and `attempt`) get defaults unless you give them.
 */
export function buildAgentSession(overrides?: Overrides<AgentSession>): AgentSession {
  const session = merge<AgentSession>(
    {
      kind: 'agent',
      id: 'sess_a',
      purpose: 'free',
      openedBy: FAKE_HOST,
      responsible: null,
      root: MAIN_ROOT,
      status: 'idle',
      permissionMode: 'ask-all',
      modeFixed: false,
      ruleCount: 0,
      login: 'logged-in',
      projectSettings: 'none',
      noteworthyAt: FAKE_NOW,
      lastSeq: 0,
      lastActivityAt: FAKE_NOW,
      createdAt: FAKE_NOW,
    },
    overrides,
  );
  const given = overrides ?? {};
  if (session.topicId !== undefined && !('topicName' in given)) session.topicName = 'Checkout';
  if (session.itemId !== undefined && !('item' in given)) session.item = { number: 1, title: 'Cart API' };
  if (session.itemId !== undefined && !('attempt' in given)) session.attempt = 1;
  return session;
}

export function buildTerminalSession(overrides?: Overrides<TerminalSession>): TerminalSession {
  return merge<TerminalSession>(
    { kind: 'terminal', id: 'sess_t', openedBy: FAKE_HOST, root: MAIN_ROOT, status: 'running', cols: 120, rows: 40, attached: 0, createdAt: FAKE_NOW },
    overrides,
  );
}

/** An open question with one part and two options, decided by the host. */
export function buildQuestion(overrides?: Overrides<Question>): Question {
  return merge<Question>(
    {
      id: 'q_1',
      sessionId: 'sess_a',
      askedAt: FAKE_NOW,
      status: 'open',
      parts: [
        {
          header: 'Cart',
          text: 'Where is the cart kept?',
          multi: false,
          options: [
            { label: 'On the server', description: 'Survives a reload.' },
            { label: 'In the browser', description: 'Simpler.' },
          ],
        },
      ],
      votes: [],
      comments: [],
      eligible: 1,
      decider: FAKE_HOST,
    },
    overrides,
  );
}

/** An open permission request for the command `pnpm test`, offering to remember `Bash(pnpm test *)`. */
export function buildPermission(overrides?: Overrides<PermissionRequest>): PermissionRequest {
  return merge<PermissionRequest>(
    {
      id: 'pr_1',
      sessionId: 'sess_a',
      askedAt: FAKE_NOW,
      status: 'open',
      tool: 'Bash',
      what: 'command',
      command: 'pnpm test',
      root: MAIN_ROOT,
      hostOnly: false,
      alwaysRule: { tool: 'Bash', pattern: 'pnpm test *' },
    },
    overrides,
  );
}

export function buildSuggestion(overrides?: Overrides<Suggestion>): Suggestion {
  return merge<Suggestion>(
    { id: 'sg_1', sessionId: 'sess_a', author: { userId: 'dev:amy', displayName: 'Amy' }, text: 'Use the session store', origin: 'composer', status: 'pending', createdAt: FAKE_NOW },
    overrides,
  );
}

/** A topic in the phase `discussing`, with a live discussion and nothing written yet. */
export function buildTopic(overrides?: Overrides<Topic>): Topic {
  return merge<Topic>(
    {
      id: 'tp_1',
      name: 'Checkout',
      slug: 'checkout',
      phase: 'discussing',
      archived: false,
      versioned: true,
      createdBy: FAKE_HOST,
      createdAt: FAKE_NOW,
      discussion: 'live',
      spec: { exists: false },
      handEdits: { spec: [], plan: [] },
      plan: { exists: false, valid: false, generating: false, stale: false, mode: 'assigned', paused: false, items: 0, started: 0, reviewed: 0, merged: 0 },
      rules: [],
    },
    overrides,
  );
}

/** A work item that was not started. */
export function buildWorkItem(overrides?: Overrides<WorkItem>): WorkItem {
  return merge<WorkItem>(
    {
      id: 'cart-api',
      number: 1,
      title: 'Cart API',
      summary: 'Add the cart endpoints.',
      dependsOn: [],
      size: 'm',
      touches: [],
      inPlan: true,
      state: 'not-started',
      armed: false,
      responsible: null,
      attempt: 0,
    },
    overrides,
  );
}

export function buildPlan(overrides?: Overrides<PlanInfo>): PlanInfo {
  return merge<PlanInfo>(
    {
      topicId: 'tp_1',
      revision: 1,
      specHash: FAKE_HASH,
      planHash: FAKE_HASH,
      mode: 'assigned',
      paused: false,
      items: [buildWorkItem()],
      warnings: [],
      waitingFor: [],
      slots: { inUse: 0, max: 8, waitingForPeople: 0 },
    },
    overrides,
  );
}

/** A complete report, version 1, to review, with one passed check. */
export function buildReportSummary(overrides?: Overrides<ReportSummary>): ReportSummary {
  return merge<ReportSummary>(
    { version: 1, writtenAt: FAKE_NOW, outcome: 'complete', state: 'to-review', reviewers: [FAKE_HOST], checks: { passed: 1, notVerified: 0 } },
    overrides,
  );
}

export function buildReport(overrides?: Overrides<ReportInfo>): ReportInfo {
  return merge<ReportInfo>(
    {
      ...buildReportSummary(),
      topicId: 'tp_1',
      itemId: 'cart-api',
      file: { root: MAIN_ROOT, path: 'specs/checkout/reports/cart-api.md' },
      sections: { done: 'The cart endpoints.', why: 'As decided.', verified: [{ text: '`pnpm test cart`: 14 tests passed', passed: true }], watchOut: 'Nothing.' },
      questions: [],
    },
    overrides,
  );
}

/** A pending merge request of worktree `wt_1`; pass `status: 'draft', requestedBy: undefined` for a report's snapshot. */
export function buildMergeRequest(overrides?: Overrides<MergeRequest>): MergeRequest {
  return merge<MergeRequest>(
    { id: 'mr_1', worktreeId: 'wt_1', requestedBy: FAKE_HOST, commit: FAKE_COMMIT, status: 'pending', reviewed: false, createdAt: FAKE_NOW },
    overrides,
  );
}

export function buildWorktree(overrides?: Overrides<WorktreeInfo>): WorktreeInfo {
  return merge<WorktreeInfo>(
    { id: 'wt_1', ownerUserId: FAKE_HOST.userId, ownerName: FAKE_HOST.displayName, branch: 'smurg/host/wt_1', kept: false, createdAt: FAKE_NOW, sharedDirs: [] },
    overrides,
  );
}

const SESSION_TARGET = { kind: 'session', sessionId: 'sess_a' } as const;
const CART_ITEM = { topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' } } as const;
const AMY = { kind: 'user', userId: 'dev:amy', displayName: 'Amy' } as const;

/** One valid inbox item of each kind (INBOX_KIND_FIELDS says which fields a kind carries). */
const INBOX_DEFAULTS: { readonly [K in InboxKind]: Omit<InboxItem, 'kind' | 'at' | 'unread'> } = {
  question: { key: 'question:q_1', waiting: true, sessionId: 'sess_a', target: SESSION_TARGET, anchor: { cardId: 'q_1' }, excerpt: 'Where is the cart kept?', voted: 0, eligible: 1, allVoted: false },
  vote: { key: 'vote:q_1', waiting: true, sessionId: 'sess_a', target: SESSION_TARGET, anchor: { cardId: 'q_1' }, excerpt: 'Where is the cart kept?', voted: 0, eligible: 2, waitsFor: FAKE_HOST },
  permission: { key: 'permission:pr_1', waiting: true, sessionId: 'sess_a', target: SESSION_TARGET, anchor: { cardId: 'pr_1' }, excerpt: 'pnpm test' },
  suggestion: { key: 'suggestion:sess_a.dev-amy', waiting: false, sessionId: 'sess_a', target: SESSION_TARGET, anchor: { cardId: 'sg_1' }, from: AMY, excerpt: 'Use the session store', count: 1 },
  report: { key: 'report:tp_1.cart-api', waiting: false, ...CART_ITEM, target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, excerpt: '', outcome: 'complete', checks: { passed: 1, notVerified: 0 } },
  merge: { key: 'merge:mr_1', waiting: false, ...CART_ITEM, target: { kind: 'changes', requestId: 'mr_1' }, excerpt: '', ready: true, conflict: false },
  mention: { key: 'mention:nt_1', waiting: false, sessionId: 'sess_a', target: SESSION_TARGET, from: AMY, excerpt: '@Host please look' },
  result: { key: 'result:nt_2', waiting: false, sessionId: 'sess_a', target: SESSION_TARGET, anchor: { cardId: 'sg_1' }, from: { kind: 'user', ...FAKE_HOST }, excerpt: 'Use the session store', result: 'rejected' },
  attention: { key: 'attention:item-stalled:tp_1.cart-api', waiting: true, subject: 'item-stalled', ...CART_ITEM, sessionId: 'sess_i', target: { kind: 'session', sessionId: 'sess_i' }, excerpt: '' },
};

/** An unread inbox item of `kind`. For another attention subject pass `subject`, `key` and (for the two that do not stop work) `waiting: false`. */
export function buildInboxItem(kind: InboxKind, overrides?: Overrides<InboxItem>): InboxItem {
  return merge<InboxItem>({ kind, at: FAKE_NOW, unread: true, ...INBOX_DEFAULTS[kind] }, overrides);
}

const LINE = { text: { id: 'conversation.started.free', params: { name: 'Host' } }, fallback: 'Host opened this session' } as const;

const EVENT_DEFAULTS: { readonly [K in ConversationEventKind]: Omit<ConversationEventOf<K>, 'seq' | 'at'> } = {
  line: { kind: 'line', ...LINE },
  notice: { kind: 'notice', level: 'info', text: { id: 'notice.compacted' }, fallback: 'Claude Code shortened the earlier conversation to make room.' },
  message: { kind: 'message', messageId: 'm_1', from: { ...FAKE_HOST, role: 'host' }, text: 'Add a test for the empty cart', origin: 'composer' },
  smurg: { kind: 'smurg', messageId: 'm_2', purpose: 'write-spec', text: 'Write the first draft of the spec now.' },
  delivery: { kind: 'delivery', messageId: 'm_1', state: 'started' },
  'turn.started': { kind: 'turn.started', turnId: 't_1' },
  'turn.finished': { kind: 'turn.finished', turnId: 't_1', outcome: 'completed', durationMs: 1_000 },
  text: { kind: 'text', turnId: 't_1', blockId: 'b_1', text: 'I will add the test next to the existing ones.' },
  'tool.started': { kind: 'tool.started', turnId: 't_1', toolUseId: 'tu_1', tool: { name: 'Edit', verb: 'edit', target: 'src/cart.test.ts', file: { root: MAIN_ROOT, path: 'src/cart.test.ts' } } },
  'tool.finished': { kind: 'tool.finished', turnId: 't_1', toolUseId: 'tu_1', ok: true, result: { additions: 1, deletions: 0, body: { kind: 'diff', text: '+it("an empty cart")\n', truncated: false } } },
  card: { kind: 'card', card: 'question', id: 'q_1' },
  pointer: { kind: 'pointer', target: 'spec', topicId: 'tp_1' },
};

/** One conversation event of `kind` with `seq` 1: `buildEvent('text', { seq: 5, text: 'Done.' })`. */
export function buildEvent<K extends ConversationEventKind>(kind: K, overrides?: Overrides<ConversationEventOf<K>>): ConversationEventOf<K> {
  return merge({ seq: 1, at: FAKE_NOW, ...EVENT_DEFAULTS[kind] } as unknown as ConversationEventOf<K>, overrides);
}

/** `kinds` as consecutive events from `firstSeq`: `buildEvents(['message', 'turn.started', 'text', 'turn.finished'])`. */
export function buildEvents(kinds: readonly ConversationEventKind[], firstSeq = 1): ConversationEvent[] {
  return kinds.map((kind, index) => buildEvent(kind, { seq: firstSeq + index } as Overrides<ConversationEventOf<typeof kind>>));
}
