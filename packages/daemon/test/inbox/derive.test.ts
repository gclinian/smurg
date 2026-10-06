// The derivation of the inbox as a pure function (src/inbox/derive.ts): what is in whose inbox for every kind, over
// roles × who is responsible × escalated, and what each item carries. No daemon here: the world is built by hand, and
// the expectations are written out (never computed with routing.ts, which the code under test uses).
import { describe, expect, it } from 'vitest';
import {
  INBOX_ALSO_FOR_MAX,
  INBOX_EXCERPT_MAX_CHARS,
  INBOX_KEY_MAX_CHARS,
  INBOX_KIND_FIELDS,
  inboxItemSchema,
  inboxKeySchema,
  type InboxItem,
  type InboxKind,
  type PlanInfo,
  type Role,
  type RoutingMember,
} from '@smurg/protocol';
import { buildMergeRequest, buildPermission, buildPlan, buildQuestion, buildReportSummary, buildSuggestion, buildWorkItem } from '@smurg/protocol/testing';
import type { AttentionFact } from '../../src/core/interfaces.ts';
import { attentionKey, deriveInbox, excerptOf, noteItem, suggestionKey, type DerivedItem, type InboxWorld, type SessionView } from '../../src/inbox/derive.ts';
import type { StoredNote } from '../../src/inbox/store.ts';

const HOST = 'dev:host';
const MEI = 'dev:mei';
const KEN = 'dev:ken';
const AMY = 'dev:amy';
const LEO = 'dev:leo';
const ROLES: Readonly<Record<string, Role>> = { [HOST]: 'host', [MEI]: 'agent', [KEN]: 'agent', [AMY]: 'editor', [LEO]: 'viewer' };
const NAMES: Readonly<Record<string, string>> = { [HOST]: 'Ian', [MEI]: 'Mei', [KEN]: 'Ken', [AMY]: 'Amy', [LEO]: 'Leo' };
const EVERYONE = [HOST, MEI, KEN, AMY, LEO];
const ref = (userId: string): { userId: string; displayName: string } => ({ userId, displayName: NAMES[userId] ?? userId });
const T = 1_727_000_000_000;

interface WorldInput {
  members?: readonly RoutingMember[];
  sessions?: Readonly<Record<string, SessionView>>;
  plans?: Readonly<Record<string, PlanInfo>>;
  archived?: readonly string[];
  offline?: readonly string[];
  questions?: InboxWorld['questions'];
  permissions?: InboxWorld['permissions'];
  suggestions?: InboxWorld['suggestions'];
  reports?: InboxWorld['reports'];
  merges?: InboxWorld['merges'];
  attention?: InboxWorld['attention'];
}

/** A world of five members (host Ian, Mei and Ken with agent access, the editor Amy, the viewer Leo), all online. */
function world(input: WorldInput = {}): InboxWorld {
  const members = input.members ?? EVERYONE.map((userId) => ({ userId, role: ROLES[userId] as Role }));
  return {
    members,
    userRef: (userId) => (NAMES[userId] === undefined ? null : ref(userId)),
    isOnline: (userId) => !(input.offline ?? []).includes(userId),
    questions: input.questions ?? [],
    permissions: input.permissions ?? [],
    suggestions: input.suggestions ?? [],
    reports: input.reports ?? [],
    merges: input.merges ?? [],
    attention: input.attention ?? [],
    session: (sessionId) => input.sessions?.[sessionId] ?? null,
    plan: (topicId) => input.plans?.[topicId] ?? null,
    topicOpen: (topicId) => !(input.archived ?? []).includes(topicId),
  };
}

/** A session Mei opened (she is its fallback decider), with `responsible` or nobody assigned. */
function sessionOf(responsible: string | null, extra: Partial<SessionView> = {}): SessionView {
  return { responsible, fallbackDecider: MEI, ...extra };
}

function itemsOf(derived: Map<string, DerivedItem[]>, userId: string): InboxItem[] {
  return (derived.get(userId) ?? []).map(({ body }) => ({ ...body, unread: true }));
}

/** Who holds an item of `kind`, in the order of EVERYONE; every item of the world must be valid for its kind. */
function holders(input: WorldInput, kind: InboxKind): string[] {
  const derived = deriveInbox(world(input));
  for (const userId of derived.keys()) for (const item of itemsOf(derived, userId)) expect(inboxItemSchema.safeParse(item).error?.issues ?? [], `${userId} ${item.key}`).toEqual([]);
  return EVERYONE.filter((userId) => itemsOf(derived, userId).some((item) => item.kind === kind));
}

function itemOf(input: WorldInput, userId: string, kind: InboxKind): InboxItem {
  const found = itemsOf(deriveInbox(world(input)), userId).find((item) => item.kind === kind);
  if (!found) throw new Error(`${userId} has no ${kind} item`);
  return found;
}

describe('a question: who decides it, who is asked to vote', () => {
  const ROWS: readonly { name: string; responsible: string | null; escalated: boolean; question: string[]; vote: string[] }[] = [
    { name: 'nobody assigned: the member who opened the session decides, everyone else who may discuss votes', responsible: null, escalated: false, question: [MEI], vote: [HOST, KEN, AMY] },
    { name: 'nobody assigned, escalated: the host and members with agent access hold it too; the editor still votes', responsible: null, escalated: true, question: [HOST, MEI, KEN], vote: [AMY] },
    { name: 'Mei is responsible: she decides, nobody is asked to vote', responsible: MEI, escalated: false, question: [MEI], vote: [] },
    { name: 'Ken is responsible in a session Mei opened: Ken decides', responsible: KEN, escalated: false, question: [KEN], vote: [] },
    { name: 'an editor is responsible: the editor decides', responsible: AMY, escalated: false, question: [AMY], vote: [] },
    { name: 'an editor is responsible, escalated: also the host and members with agent access', responsible: AMY, escalated: true, question: [HOST, MEI, KEN, AMY], vote: [] },
    { name: 'a viewer cannot be responsible: the fallback decider decides, the others vote', responsible: LEO, escalated: false, question: [MEI], vote: [HOST, KEN, AMY] },
  ];
  for (const row of ROWS) {
    it(row.name, () => {
      const input: WorldInput = {
        sessions: { sess_a: sessionOf(row.responsible) },
        questions: [buildQuestion({ eligible: 4, ...(row.escalated ? { escalatedAt: T + 1 } : {}) })],
      };
      expect(holders(input, 'question')).toEqual(row.question);
      expect(holders(input, 'vote')).toEqual(row.vote);
    });
  }

  it('without a fallback decider and without a responsible person the host decides', () => {
    const input: WorldInput = { sessions: { sess_a: { responsible: null, fallbackDecider: null } }, questions: [buildQuestion()] };
    expect(holders(input, 'question')).toEqual([HOST]);
    expect(holders(input, 'vote')).toEqual([MEI, KEN, AMY]);
    // A session the inbox cannot find any more is routed the same way.
    expect(holders({ questions: [buildQuestion()] }, 'question')).toEqual([HOST]);
  });

  it('a member who voted on every part is no longer asked; one who voted on one of two parts still is', () => {
    const parts = [...buildQuestion().parts, { header: 'Stock', text: 'Who checks the stock?', multi: false, options: [{ label: 'The cart', description: '' }, { label: 'The checkout', description: '' }] }];
    const vote = (userId: string, part: number): { userId: string; displayName: string; part: number; options: number[]; at: number } => ({ ...ref(userId), part, options: [0], at: T });
    const input: WorldInput = {
      sessions: { sess_a: sessionOf(null) },
      questions: [buildQuestion({ parts, eligible: 4, votes: [vote(HOST, 0), vote(HOST, 1), vote(KEN, 0)] })],
    };
    expect(holders(input, 'vote')).toEqual([KEN, AMY]);
    expect(itemOf(input, AMY, 'vote')).toMatchObject({ key: 'vote:q_1', voted: 1, eligible: 4, waiting: true, waitsFor: ref(MEI), waitsForOffline: false, excerpt: 'Where is the cart kept?' });
    // `voted` counts who voted on EVERY part; the leading option is the first part's.
    expect(itemOf(input, MEI, 'question')).toMatchObject({ key: 'question:q_1', voted: 1, eligible: 4, allVoted: false, leading: 'On the server', anchor: { cardId: 'q_1' }, target: { kind: 'session', sessionId: 'sess_a' } });
  });

  it('the leading option and "all voted" come from votes.ts; the stamp moves when everyone has voted', () => {
    const vote = (userId: string, option: number): { userId: string; displayName: string; part: number; options: number[]; at: number } => ({ ...ref(userId), part: 0, options: [option], at: T });
    const open = { sessions: { sess_a: sessionOf(null) }, questions: [buildQuestion({ eligible: 3, votes: [vote(HOST, 0), vote(KEN, 1), vote(AMY, 0)] })] };
    expect(itemOf(open, MEI, 'question')).toMatchObject({ voted: 3, eligible: 3, allVoted: true, leading: 'On the server' });
    expect(deriveInbox(world(open)).get(MEI)?.[0]?.stamp).toBe('all-voted');
    const tie = { sessions: { sess_a: sessionOf(null) }, questions: [buildQuestion({ eligible: 3, votes: [vote(HOST, 0), vote(KEN, 1)] })] };
    expect(itemOf(tie, MEI, 'question')).toMatchObject({ voted: 2, allVoted: false });
    expect(itemOf(tie, MEI, 'question').leading).toBeUndefined();
    expect(deriveInbox(world(tie)).get(MEI)?.[0]?.stamp).toBe('');
  });

  it("an escalated question: the others' copies say who has not answered and whether they are offline; everyone sees who else holds it", () => {
    const input: WorldInput = { sessions: { sess_a: sessionOf(AMY) }, questions: [buildQuestion({ escalatedAt: T + 1 })], offline: [AMY] };
    const amys = itemOf(input, AMY, 'question');
    expect(amys).toMatchObject({ escalated: true, alsoFor: [ref(HOST), ref(MEI), ref(KEN)] });
    expect(amys.waitsFor).toBeUndefined();
    expect(itemOf(input, KEN, 'question')).toMatchObject({ escalated: true, waitsFor: ref(AMY), waitsForOffline: true, alsoFor: [ref(AMY), ref(HOST), ref(MEI)] });
    // Not escalated: the decider alone holds it, and the row says nothing about others.
    const quiet = itemOf({ sessions: { sess_a: sessionOf(AMY) }, questions: [buildQuestion()] }, AMY, 'question');
    expect(quiet.escalated).toBeUndefined();
    expect(quiet.alsoFor).toBeUndefined();
  });

  it('a question of a work item names the topic and the item; a settled question is nowhere', () => {
    const view = sessionOf(MEI, { topicId: 'tp_1', itemId: 'cart-api', item: { number: 2, title: 'Cart API' } });
    expect(itemOf({ sessions: { sess_a: view }, questions: [buildQuestion()] }, MEI, 'question')).toMatchObject({ topicId: 'tp_1', itemId: 'cart-api', item: { number: 2, title: 'Cart API' } });
    expect(itemOf({ sessions: { sess_a: sessionOf(MEI, { topicId: 'tp_1' }) }, questions: [buildQuestion()] }, MEI, 'question')).toMatchObject({ topicId: 'tp_1' });
    expect(holders({ sessions: { sess_a: sessionOf(null) }, questions: [buildQuestion({ status: 'answered' })] }, 'question')).toEqual([]);
    expect(holders({ sessions: { sess_a: sessionOf(null) }, questions: [buildQuestion({ status: 'withdrawn' })] }, 'vote')).toEqual([]);
  });
});

describe('a permission request: whose inbox holds it', () => {
  const ROWS: readonly { name: string; responsible: string | null; hostOnly: boolean; escalated: boolean; holders: string[] }[] = [
    { name: 'nobody assigned: the host and every member with agent access', responsible: null, hostOnly: false, escalated: false, holders: [HOST, MEI, KEN] },
    { name: 'Mei is responsible and may allow: Mei alone', responsible: MEI, hostOnly: false, escalated: false, holders: [MEI] },
    { name: 'Mei is responsible, escalated: the host and every member with agent access', responsible: MEI, hostOnly: false, escalated: true, holders: [HOST, MEI, KEN] },
    { name: 'an editor is responsible but cannot allow: the host and every member with agent access', responsible: AMY, hostOnly: false, escalated: false, holders: [HOST, MEI, KEN] },
    { name: 'host-only: the host, whoever is responsible', responsible: MEI, hostOnly: true, escalated: false, holders: [HOST] },
    { name: 'host-only, escalated: still the host alone', responsible: null, hostOnly: true, escalated: true, holders: [HOST] },
  ];
  for (const row of ROWS) {
    it(row.name, () => {
      const input: WorldInput = {
        sessions: { sess_a: sessionOf(row.responsible) },
        permissions: [buildPermission({ hostOnly: row.hostOnly, ...(row.hostOnly ? { alwaysRule: undefined, noAlways: 'host-only' as const } : {}), ...(row.escalated ? { escalatedAt: T + 1 } : {}) })],
      };
      expect(holders(input, 'permission')).toEqual(row.holders);
    });
  }

  it('an escalated request says who has not answered; a request for all says who else may answer', () => {
    const escalated: WorldInput = { sessions: { sess_a: sessionOf(MEI) }, permissions: [buildPermission({ escalatedAt: T + 1 })] };
    expect(itemOf(escalated, KEN, 'permission')).toMatchObject({ key: 'permission:pr_1', waiting: true, escalated: true, waitsFor: ref(MEI), waitsForOffline: false, alsoFor: [ref(HOST), ref(MEI)], anchor: { cardId: 'pr_1' } });
    const meis = itemOf(escalated, MEI, 'permission');
    expect(meis.waitsFor).toBeUndefined();
    expect(meis).toMatchObject({ escalated: true, alsoFor: [ref(HOST), ref(KEN)] });
    const forAll = itemOf({ sessions: { sess_a: sessionOf(null) }, permissions: [buildPermission()] }, HOST, 'permission');
    expect(forAll).toMatchObject({ alsoFor: [ref(MEI), ref(KEN)] });
    expect(forAll.waitsFor).toBeUndefined();
    expect(forAll.escalated).toBeUndefined();
    // Nobody waited for one person before it escalated: no name.
    expect(itemOf({ sessions: { sess_a: sessionOf(null) }, permissions: [buildPermission({ escalatedAt: T })] }, KEN, 'permission').waitsFor).toBeUndefined();
  });

  it('the excerpt is the command, the URL or the path in the workspace; never the absolute path of an outside request', () => {
    const excerpt = (overrides: Parameters<typeof buildPermission>[0]): string => itemOf({ sessions: { sess_a: sessionOf(null) }, permissions: [buildPermission(overrides)] }, HOST, 'permission').excerpt;
    expect(excerpt({})).toBe('pnpm test');
    expect(excerpt({ tool: 'WebFetch', what: 'fetch', command: undefined, url: 'https://example.com/docs', alwaysRule: undefined })).toBe('https://example.com/docs');
    expect(excerpt({ tool: 'Edit', what: 'edit', command: undefined, file: { root: { kind: 'main' }, path: 'src/cart.ts' }, alwaysRule: undefined })).toBe('src/cart.ts');
    expect(excerpt({ tool: 'Read', what: 'outside', command: undefined, outside: true, path: '/Users/ian/.ssh/id_ed25519', hostOnly: true, alwaysRule: undefined, noAlways: 'host-only' })).toBe('Read');
    expect(excerpt({ tool: 'mcp__github__create_issue', what: 'other', command: undefined, input: '{ "title": "x" }', alwaysRule: undefined })).toBe('mcp__github__create_issue');
  });

  it('a decided or withdrawn request is nowhere', () => {
    for (const status of ['allowed', 'denied', 'withdrawn'] as const) expect(holders({ sessions: { sess_a: sessionOf(null) }, permissions: [buildPermission({ status })] }, 'permission')).toEqual([]);
  });
});

describe('suggestions: one item per author and session, routed like a permission request', () => {
  const ROWS: readonly { name: string; responsible: string | null; holders: string[] }[] = [
    { name: 'nobody assigned: the host and every member with agent access', responsible: null, holders: [HOST, MEI, KEN] },
    { name: 'Mei is responsible: Mei', responsible: MEI, holders: [MEI] },
    { name: 'an editor is responsible but cannot accept: the host and every member with agent access', responsible: AMY, holders: [HOST, MEI, KEN] },
  ];
  for (const row of ROWS) {
    it(row.name, () => {
      expect(holders({ sessions: { sess_a: sessionOf(row.responsible) }, suggestions: [buildSuggestion()] }, 'suggestion')).toEqual(row.holders);
    });
  }

  it('three pending suggestions of one author in one session are one item: it opens at the oldest and counts them', () => {
    const input: WorldInput = {
      sessions: { sess_a: sessionOf(MEI, { topicId: 'tp_1' }), sess_b: sessionOf(MEI) },
      suggestions: [
        buildSuggestion({ id: 'sg_2', text: 'second', createdAt: T + 20 }),
        buildSuggestion({ id: 'sg_1', text: 'first', createdAt: T + 10 }),
        buildSuggestion({ id: 'sg_3', text: 'third', createdAt: T + 30 }),
        buildSuggestion({ id: 'sg_4', text: 'settled', status: 'rejected', createdAt: T + 5 }),
        buildSuggestion({ id: 'sg_5', sessionId: 'sess_b', text: 'another session', createdAt: T + 40 }),
        buildSuggestion({ id: 'sg_6', author: ref(KEN), text: "Ken's", createdAt: T + 50 }),
      ],
    };
    const items = itemsOf(deriveInbox(world(input)), MEI).filter((item) => item.kind === 'suggestion');
    expect(items.map((item) => item.key).sort()).toEqual(['suggestion:sess_a.dev-amy', 'suggestion:sess_a.dev-ken', 'suggestion:sess_b.dev-amy']);
    expect(items.find((item) => item.key === 'suggestion:sess_a.dev-amy')).toMatchObject({
      count: 3,
      anchor: { cardId: 'sg_1' },
      excerpt: 'first',
      at: T + 30,
      from: { kind: 'user', ...ref(AMY) },
      topicId: 'tp_1',
      waiting: false,
      target: { kind: 'session', sessionId: 'sess_a' },
    });
    // One more suggestion moves the stamp (the item is unread again); settling the oldest does not.
    const stamp = (suggestions: InboxWorld['suggestions']): string | undefined => deriveInbox(world({ sessions: { sess_a: sessionOf(MEI) }, suggestions })).get(MEI)?.[0]?.stamp;
    expect(stamp([buildSuggestion({ id: 'sg_1', createdAt: T }), buildSuggestion({ id: 'sg_2', createdAt: T + 1 })])).toBe('sg_2');
    expect(stamp([buildSuggestion({ id: 'sg_2', createdAt: T + 1 })])).toBe('sg_2');
    expect(stamp([buildSuggestion({ id: 'sg_2', createdAt: T + 1 }), buildSuggestion({ id: 'sg_3', createdAt: T + 2 })])).toBe('sg_3');
  });
});

describe('a report to review: its reviewers', () => {
  const plan = (responsible: string | null, sessionId?: string): PlanInfo =>
    buildPlan({ items: [buildWorkItem({ number: 3, title: 'Cart API', responsible: responsible === null ? null : { ...ref(responsible), source: 'chosen' }, ...(sessionId === undefined ? {} : { sessionId }) })] });
  const report = (escalated: boolean): InboxWorld['reports'] => [{ topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ outcome: 'partial', checks: { passed: 2, notVerified: 1 }, ...(escalated ? { escalatedAt: T + 1 } : {}) }) }];
  const ROWS: readonly { name: string; responsible: string | null; escalated: boolean; holders: string[] }[] = [
    { name: 'nobody assigned: everyone who may discuss (any one of them reviews, once, for all)', responsible: null, escalated: false, holders: [HOST, MEI, KEN, AMY] },
    { name: 'Mei is responsible: Mei', responsible: MEI, escalated: false, holders: [MEI] },
    { name: 'an editor is responsible: the editor', responsible: AMY, escalated: false, holders: [AMY] },
    { name: 'an editor is responsible, escalated: also the host and members with agent access', responsible: AMY, escalated: true, holders: [HOST, MEI, KEN, AMY] },
    { name: 'Mei is responsible, escalated: the host and every member with agent access', responsible: MEI, escalated: true, holders: [HOST, MEI, KEN] },
  ];
  for (const row of ROWS) {
    it(row.name, () => {
      expect(holders({ plans: { tp_1: plan(row.responsible) }, reports: report(row.escalated) }, 'report')).toEqual(row.holders);
    });
  }

  it('the item carries the work item, the outcome and the checks; an escalated copy says who has not reviewed', () => {
    const input: WorldInput = { plans: { tp_1: plan(AMY, 'sess_i') }, sessions: { sess_i: sessionOf(AMY) }, reports: report(true), offline: [AMY] };
    expect(itemOf(input, MEI, 'report')).toMatchObject({
      key: 'report:tp_1.cart-api',
      waiting: false,
      topicId: 'tp_1',
      itemId: 'cart-api',
      item: { number: 3, title: 'Cart API' },
      sessionId: 'sess_i',
      target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' },
      excerpt: '',
      outcome: 'partial',
      checks: { passed: 2, notVerified: 1 },
      escalated: true,
      waitsFor: ref(AMY),
      waitsForOffline: true,
    });
    expect(itemOf(input, AMY, 'report').waitsFor).toBeUndefined();
  });

  it('who is responsible is read from the session once the item has one, from the plan before', () => {
    expect(holders({ plans: { tp_1: plan(AMY, 'sess_i') }, sessions: { sess_i: sessionOf(KEN) }, reports: report(false) }, 'report')).toEqual([KEN]);
    expect(holders({ plans: { tp_1: plan(AMY, 'sess_i') }, sessions: { sess_i: sessionOf(null) }, reports: report(false) }, 'report')).toEqual([HOST, MEI, KEN, AMY]);
  });

  it('nothing waits in an archived topic; an item the plan no longer names keeps the reviewers the report names', () => {
    expect(holders({ plans: { tp_1: plan(MEI) }, reports: report(false), archived: ['tp_1'] }, 'report')).toEqual([]);
    const orphan: WorldInput = { reports: [{ topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ reviewers: [ref(KEN), { userId: 'dev:gone', displayName: 'Gone' }] }) }] };
    expect(holders(orphan, 'report')).toEqual([KEN]);
    expect(itemOf(orphan, KEN, 'report')).toMatchObject({ item: { number: 0, title: 'cart-api' } });
    expect(holders({ reports: [{ topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ reviewers: [ref(AMY)], escalatedAt: T }) }] }, 'report')).toEqual([HOST, MEI, KEN, AMY]);
  });

  it('a new version, and a change after the review, move the stamp; a reviewed report is nowhere', () => {
    const stamp = (summary: Parameters<typeof buildReportSummary>[0]): string | undefined =>
      deriveInbox(world({ plans: { tp_1: plan(MEI) }, reports: [{ topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary(summary) }] })).get(MEI)?.[0]?.stamp;
    expect(stamp({})).toBe('1:to-review');
    expect(stamp({ version: 2 })).toBe('2:to-review');
    expect(stamp({ version: 2, state: 'changed-after-review' })).toBe('2:changed-after-review');
    expect(stamp({ state: 'reviewed' })).toBeUndefined();
  });
});

describe('merge requests: the host', () => {
  it('a pending request, a reviewed draft (ready) and a conflict are in the host\'s inbox; an unreviewed draft, a merged and a rejected one are not', () => {
    const one = (overrides: Parameters<typeof buildMergeRequest>[0]): string[] => holders({ merges: [buildMergeRequest(overrides)] }, 'merge');
    expect(one({})).toEqual([HOST]);
    expect(one({ status: 'draft', requestedBy: undefined, reviewed: true })).toEqual([HOST]);
    expect(one({ status: 'conflict', conflictFiles: ['src/cart.ts'] })).toEqual([HOST]);
    expect(one({ status: 'draft', requestedBy: undefined })).toEqual([]);
    expect(one({ status: 'merged', decidedAt: T })).toEqual([]);
    expect(one({ status: 'rejected', decidedAt: T })).toEqual([]);
  });

  it('who asked, the message, the work item, what waits for it', () => {
    const plans = {
      tp_1: buildPlan({
        items: [
          buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API' }),
          buildWorkItem({ id: 'checkout', number: 3, title: 'Checkout page', waitsFor: ['cart-api', 'payment'] }),
          buildWorkItem({ id: 'payment', number: 2, title: 'Payment form', waitsFor: ['cart-api'] }),
          buildWorkItem({ id: 'old', number: 0, title: 'Removed', inPlan: false, waitsFor: ['cart-api'] }),
        ],
      }),
    };
    const requested = itemOf({ plans, merges: [buildMergeRequest({ requestedBy: ref(MEI), message: 'add tests', topicId: 'tp_1', itemId: 'cart-api', createdAt: T + 7 })] }, HOST, 'merge');
    expect(requested).toEqual({
      key: 'merge:mr_1',
      kind: 'merge',
      at: T + 7,
      unread: true,
      waiting: false,
      topicId: 'tp_1',
      itemId: 'cart-api',
      item: { number: 1, title: 'Cart API' },
      target: { kind: 'changes', requestId: 'mr_1' },
      from: { kind: 'user', ...ref(MEI) },
      excerpt: 'add tests',
      ready: false,
      unblocks: [2, 3],
      conflict: false,
    });
    const ready = itemOf({ merges: [buildMergeRequest({ id: 'mr_2', status: 'draft', requestedBy: undefined, reviewed: true })] }, HOST, 'merge');
    expect(ready).toMatchObject({ ready: true, conflict: false, excerpt: '' });
    expect(ready.from).toBeUndefined();
    expect(ready.unblocks).toBeUndefined();
    expect(ready.topicId).toBeUndefined();
    expect(itemOf({ merges: [buildMergeRequest({ status: 'conflict' })] }, HOST, 'merge')).toMatchObject({ ready: false, conflict: true });
    // The status is the stamp: a draft that somebody then asks to merge, or that conflicts, is unread again.
    expect(deriveInbox(world({ merges: [buildMergeRequest({ status: 'draft', reviewed: true })] })).get(HOST)?.[0]?.stamp).toBe('draft:reviewed');
    expect(deriveInbox(world({ merges: [buildMergeRequest({ status: 'conflict', reviewed: true })] })).get(HOST)?.[0]?.stamp).toBe('conflict:reviewed');
  });
});

describe('attention: work that stopped and has no card', () => {
  const fact = (overrides: Partial<AttentionFact> & Pick<AttentionFact, 'subject' | 'id' | 'recipients' | 'target'>): AttentionFact => ({ at: T, excerpt: '', ...overrides });

  it("each fact is in the inboxes its owner names, as it is; only members have an inbox", () => {
    const stalled = fact({ subject: 'item-stalled', id: 'tp_1.cart-api', recipients: [MEI, MEI, 'dev:gone'], topicId: 'tp_1', sessionId: 'sess_i', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, target: { kind: 'session', sessionId: 'sess_i' } });
    const paused = fact({ subject: 'plan-paused', id: 'tp_1', recipients: [HOST, MEI, KEN], topicId: 'tp_1', target: { kind: 'plan', topicId: 'tp_1' }, count: 4, excerpt: 'Checkout' });
    const input: WorldInput = { attention: [stalled, paused] };
    expect(holders(input, 'attention')).toEqual([HOST, MEI, KEN]);
    expect(itemsOf(deriveInbox(world(input)), MEI)).toEqual([
      { key: 'attention:item-stalled:tp_1.cart-api', kind: 'attention', subject: 'item-stalled', at: T, unread: true, waiting: true, topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, sessionId: 'sess_i', target: { kind: 'session', sessionId: 'sess_i' }, excerpt: '' },
      { key: 'attention:plan-paused:tp_1', kind: 'attention', subject: 'plan-paused', at: T, unread: true, waiting: true, topicId: 'tp_1', target: { kind: 'plan', topicId: 'tp_1' }, excerpt: 'Checkout', count: 4 },
    ]);
  });

  it('every subject stops work except the two that only inform the host', () => {
    const subjects = ['item-stalled', 'item-failed', 'item-stopped', 'item-not-started', 'plan-paused', 'discussion-lost', 'account', 'project-settings', 'host-rules', 'storage'] as const;
    const input: WorldInput = { attention: subjects.map((subject) => fact({ subject, id: 'x', recipients: [HOST], target: { kind: 'console', section: 'sessions' } })) };
    expect(holders(input, 'attention')).toEqual([HOST]);
    const waiting = Object.fromEntries(itemsOf(deriveInbox(world(input)), HOST).map((item) => [item.subject, item.waiting]));
    expect(waiting).toEqual({ 'item-stalled': true, 'item-failed': true, 'item-stopped': true, 'item-not-started': true, 'plan-paused': true, 'discussion-lost': true, account: true, 'project-settings': true, 'host-rules': false, storage: false });
  });

  it('a fact that names half a work item keeps what holds, so its item stays valid', () => {
    const half = fact({ subject: 'item-failed', id: 'tp_1.cart-api', recipients: [HOST], topicId: 'tp_1', itemId: 'cart-api', target: { kind: 'plan', topicId: 'tp_1' } });
    const item = itemOf({ attention: [half] }, HOST, 'attention');
    expect(item).toMatchObject({ topicId: 'tp_1' });
    expect(item.itemId).toBeUndefined();
    expect(inboxItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('what an item carries', () => {
  it('more than five others who may settle it: five names and how many more', () => {
    const agents = Array.from({ length: 8 }, (_, index) => `dev:agent${index}`);
    const members: RoutingMember[] = [{ userId: HOST, role: 'host' }, ...agents.map((userId) => ({ userId, role: 'agent' as const }))];
    const custom: InboxWorld = { ...world({ members, sessions: { sess_a: sessionOf(null) }, permissions: [buildPermission()] }), userRef: (userId) => ({ userId, displayName: userId.slice(4) }) };
    const item = deriveInbox(custom).get(HOST)?.[0]?.body;
    expect(item?.alsoFor).toHaveLength(INBOX_ALSO_FOR_MAX);
    expect(item?.alsoFor?.[0]).toEqual({ userId: 'dev:agent0', displayName: 'agent0' });
    expect(item?.alsoForMore).toBe(3);
    expect(inboxItemSchema.safeParse({ ...item, unread: true }).success).toBe(true);
  });

  it('every kind carries exactly the fields INBOX_KIND_FIELDS gives it, in every world of this suite', () => {
    const input: WorldInput = {
      sessions: { sess_a: sessionOf(null, { topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' } }) },
      plans: { tp_1: buildPlan() },
      questions: [buildQuestion({ escalatedAt: T })],
      permissions: [buildPermission({ escalatedAt: T })],
      suggestions: [buildSuggestion()],
      reports: [{ topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ escalatedAt: T }) }],
      merges: [buildMergeRequest({ topicId: 'tp_1', itemId: 'cart-api' })],
      attention: [{ subject: 'account', id: 'workspace', at: T, recipients: [HOST], target: { kind: 'console', section: 'sessions' }, count: 2, excerpt: '' }],
    };
    const derived = deriveInbox(world(input));
    const kinds = new Set<string>();
    for (const userId of derived.keys()) {
      for (const item of itemsOf(derived, userId)) {
        kinds.add(item.kind);
        expect(inboxItemSchema.safeParse(item).error?.issues ?? []).toEqual([]);
        const allowed = new Set<string>(['key', 'kind', 'at', 'unread', 'waiting', 'target', 'excerpt', ...INBOX_KIND_FIELDS[item.kind].required, ...INBOX_KIND_FIELDS[item.kind].optional]);
        expect(Object.keys(item).filter((name) => !allowed.has(name))).toEqual([]);
        // No key holds `undefined`: the wire has no such value.
        expect(Object.values(item).every((value) => value !== undefined)).toBe(true);
      }
    }
    expect([...kinds].sort()).toEqual(['attention', 'merge', 'permission', 'question', 'report', 'suggestion', 'vote']);
    expect(derived.has(LEO)).toBe(false);
  });

  it('excerptOf: valid for the wire whatever it is given, clipped with an ellipsis, never inside a surrogate pair', () => {
    expect(excerptOf('  pnpm test \r\n')).toBe('pnpm test');
    expect(excerptOf('a\u0000b\u001bc‮d⁦e\u009bf')).toBe('abcdef');
    expect(excerptOf('one\r\ntwo\rthree\tfour')).toBe('one\ntwo\nthree\tfour');
    expect(excerptOf('lone \ud83d surrogate')).toBe('lone � surrogate');
    const long = excerptOf('x'.repeat(1_000));
    expect(long).toHaveLength(INBOX_EXCERPT_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(excerptOf('y'.repeat(INBOX_EXCERPT_MAX_CHARS))).toBe('y'.repeat(INBOX_EXCERPT_MAX_CHARS));
    // 298 characters and then an emoji (two code units) across the cut: the pair goes whole.
    const pair = excerptOf(`${'z'.repeat(INBOX_EXCERPT_MAX_CHARS - 2)}\u{1F600}\u{1F600}`);
    expect(pair).toBe(`${'z'.repeat(INBOX_EXCERPT_MAX_CHARS - 2)}…`);
    for (const text of [long, pair, excerptOf('\u0007'), excerptOf('')]) expect(inboxItemSchema.shape.excerpt.safeParse(text).success).toBe(true);
  });

  it('keys: one per thing, always a valid inbox key, however long an id is', () => {
    expect(suggestionKey('sess_a', 'github:12345')).toBe('suggestion:sess_a.github-12345');
    const long = suggestionKey('s'.repeat(64), `google:${'g'.repeat(255)}`);
    expect(long.length).toBeLessThanOrEqual(INBOX_KEY_MAX_CHARS);
    expect(long).toMatch(/^suggestion:s{64}\.[0-9a-f]{32}$/);
    expect(suggestionKey('s'.repeat(64), `google:${'g'.repeat(255)}`)).toBe(long);
    expect(suggestionKey('s'.repeat(64), `google:${'g'.repeat(254)}h`)).not.toBe(long);
    expect(attentionKey('account', 'workspace')).toBe('attention:account:workspace');
    expect(attentionKey('item-stalled', 'an id with spaces')).toMatch(/^attention:item-stalled:[0-9a-f]{32}$/);
    for (const key of [long, attentionKey('item-not-started', 'x'.repeat(500)), attentionKey('storage', 'a b')]) expect(inboxKeySchema.safeParse(key).success).toBe(true);
  });
});

describe('stored notes as items', () => {
  const from = { kind: 'user', ...ref(MEI) } as const;
  const sessions = { sess_i: sessionOf(MEI, { topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' } }) };
  const lookups = world({ sessions, plans: { tp_1: buildPlan() } });
  const valid = (note: StoredNote): InboxItem => {
    const item = { ...noteItem(note, lookups), unread: true };
    expect(inboxItemSchema.safeParse(item).error?.issues ?? []).toEqual([]);
    return item;
  };

  it('a mention opens what it was written in and says where that is', () => {
    expect(valid({ id: 'nt_1', kind: 'mention', at: T, from, target: { kind: 'session', sessionId: 'sess_i' }, anchor: { cardId: 'q_1', seq: 12 }, excerpt: '@Amy the server, please' })).toEqual({
      key: 'mention:nt_1',
      kind: 'mention',
      at: T,
      unread: true,
      waiting: false,
      topicId: 'tp_1',
      itemId: 'cart-api',
      item: { number: 1, title: 'Cart API' },
      sessionId: 'sess_i',
      target: { kind: 'session', sessionId: 'sess_i' },
      anchor: { cardId: 'q_1', seq: 12 },
      from,
      excerpt: '@Amy the server, please',
    });
    expect(valid({ id: 'nt_2', kind: 'mention', at: T, from, target: { kind: 'spec', topicId: 'tp_1' }, excerpt: 'x' })).toMatchObject({ topicId: 'tp_1', target: { kind: 'spec', topicId: 'tp_1' } });
    expect(valid({ id: 'nt_3', kind: 'mention', at: T, from, target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, excerpt: 'x' })).toMatchObject({ topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' } });
    expect(valid({ id: 'nt_4', kind: 'mention', at: T, from, target: { kind: 'report', topicId: 'tp_1', itemId: 'gone' }, excerpt: 'x' })).toMatchObject({ item: { number: 0, title: 'gone' } });
    const free = valid({ id: 'nt_5', kind: 'mention', at: T, from: { kind: 'agent', sessionId: 'sess_x', ownerUserId: MEI, displayName: 'Claude (Mei)' }, target: { kind: 'session', sessionId: 'sess_free' }, anchor: {}, excerpt: 'x' });
    expect(free).toMatchObject({ sessionId: 'sess_free', from: { kind: 'agent' } });
    expect(free.topicId).toBeUndefined();
    expect(free.anchor).toBeUndefined();
    expect(valid({ id: 'nt_6', kind: 'mention', at: T, from, target: { kind: 'changes', requestId: 'mr_1' }, excerpt: 'x' }).sessionId).toBeUndefined();
  });

  it('a result names the suggestion, who decided and what became of it', () => {
    expect(valid({ id: 'nt_9', kind: 'result', at: T, from, sessionId: 'sess_i', suggestionId: 'sg_1', outcome: 'accepted-edited', excerpt: 'Use the session store' })).toEqual({
      key: 'result:nt_9',
      kind: 'result',
      at: T,
      unread: true,
      waiting: false,
      topicId: 'tp_1',
      itemId: 'cart-api',
      item: { number: 1, title: 'Cart API' },
      sessionId: 'sess_i',
      target: { kind: 'session', sessionId: 'sess_i' },
      anchor: { cardId: 'sg_1' },
      from,
      excerpt: 'Use the session store',
      result: 'accepted-edited',
    });
  });
});
