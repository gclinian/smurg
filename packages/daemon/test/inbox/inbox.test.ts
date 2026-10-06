// The inbox module in a test daemon (ARCHITECTURE §5.11; DESIGN §3.8): the real router, hub, member directory and
// state store, real SDK clients, THIS module, and the in-memory fakes of every service it derives from. The fakes'
// drivers stand in for what the conversation, suggest, topics, worktree and sessions modules do; the expectations are
// written out by hand (never computed with routing.ts, which the module uses).
//
// Five people: the host, Mei and Ken (Agent access), Amy (Editor), Leo (Viewer). The sweep is switched off in every
// test but the one about it, so that an item moves because of the event that moved it.
import { afterEach, describe, expect, it } from 'vitest';
import { INBOX_ITEMS_MAX, INBOX_NOTES_PER_MEMBER_MAX, decodeEnvelope, encodedSize, inboxItemSchema, type AgentSession, type InboxItem, type UserRef } from '@smurg/protocol';
import { attentionRef, renderEnglish } from '@smurg/protocol/i18n';
import type { FeatureModule } from '../../src/core/context.ts';
import type { AttentionFact, Principal } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { buildInboxItem, buildMergeRequest, buildPlan, buildSuggestion, buildTopic, buildWorkItem, fakesModule, fakesOf, type Fakes } from '../../src/core/fakes/index.ts';
import { changePages } from '../../src/inbox/inbox-service.ts';
import { createInboxModule, inboxModule } from '../../src/inbox/module.ts';
import { createTempDir, createTempProject, createTempRunDir, createTestDaemon, removeTempDir, removeTempRunDir, settle, waitFor, type TestClient, type TestDaemon, type TestDaemonOptions } from '../../src/testing/index.ts';

const HOST = 'dev:host';
const MEI = 'dev:mei';
const KEN = 'dev:ken';
const AMY = 'dev:amy';
const LEO = 'dev:leo';
const PEOPLE = [HOST, MEI, KEN, AMY, LEO] as const;
const ROLES = { [MEI]: 'agent', [KEN]: 'agent', [AMY]: 'editor', [LEO]: 'viewer' } as const;
const NAMES = { [MEI]: 'Mei', [KEN]: 'Ken', [AMY]: 'Amy', [LEO]: 'Leo' } as const;
/** No sweep within a test: an hour. */
const NO_SWEEP = 3_600_000;

type Change = { upsert: InboxItem[]; remove: string[] };

interface Team {
  readonly t: TestDaemon;
  readonly fakes: Fakes;
  readonly clients: Record<string, TestClient>;
  /** Every `inbox.changed` each member's client received, in order. */
  readonly changes: Record<string, Change[]>;
}

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

/** The people (all five unless a test needs fewer) and the module under test over the fakes. */
async function setup(options: Partial<TestDaemonOptions> = {}, people: readonly string[] = PEOPLE): Promise<Team> {
  const daemon = await createTestDaemon({
    ...options,
    modules: options.modules ?? [fakesModule({ except: ['inbox'], handlers: true }), createInboxModule()],
    agents: { escalationSweepMs: NO_SWEEP, ...options.agents },
  });
  t = daemon;
  const clients: Record<string, TestClient> = {};
  const changes: Record<string, Change[]> = {};
  for (const userId of people) {
    const client = userId === HOST ? await daemon.connectHost() : await daemon.connect({ userId, displayName: NAMES[userId as keyof typeof NAMES], role: ROLES[userId as keyof typeof ROLES] });
    clients[userId] = client;
    const seen: Change[] = [];
    changes[userId] = seen;
    client.conn.on('inbox.changed', (payload) => seen.push(payload));
  }
  return { t: daemon, fakes: fakesOf(daemon.ctx), clients, changes };
}

function principal(team: Team, userId: string): Principal {
  const found = team.t.ctx.members.principalOf(userId);
  if (!found) throw new Error(`${userId} is not a member`);
  return found;
}

function refOf(team: Team, userId: string): UserRef {
  const found = team.t.ctx.members.userRef(userId);
  if (!found) throw new Error(`${userId} is not a member`);
  return found;
}

/** A member's inbox right now; every item must be valid for its kind. */
function inbox(team: Team, userId: string): InboxItem[] {
  const items = team.t.ctx.services.inbox.itemsOf(userId);
  for (const item of items) expect(inboxItemSchema.safeParse(item).error?.issues ?? [], item.key).toEqual([]);
  return items;
}

function itemOf(team: Team, userId: string, key: string): InboxItem {
  const found = inbox(team, userId).find((item) => item.key === key);
  if (!found) throw new Error(`${userId} has no ${key}`);
  return found;
}

/** Who holds `key`, in the order host, Mei, Ken, Amy, Leo. */
function holders(team: Team, key: string): string[] {
  return PEOPLE.filter((userId) => inbox(team, userId).some((item) => item.key === key));
}

/** What a member's client was told about `key`, in order: 'upsert' / 'remove'. */
function told(team: Team, userId: string, key: string): string[] {
  return (team.changes[userId] ?? []).flatMap((change) => [...(change.upsert.some((item) => item.key === key) ? ['upsert'] : []), ...(change.remove.includes(key) ? ['remove'] : [])]);
}

/** A free session Mei opened (she is its fallback decider), with `responsible` or nobody assigned. */
async function freeSession(team: Team, responsible: string | null, openedBy: string = MEI): Promise<AgentSession> {
  return team.fakes.agents.start({
    purpose: 'free',
    openedBy: principal(team, openedBy),
    responsible: responsible === null ? null : refOf(team, responsible),
    workspace: { mode: 'main' },
    mode: 'ask-all',
    rolePrompt: () => 'prompt',
  });
}

/** A topic with a plan of one work item, and that item's session (opened by Mei). */
async function itemSession(team: Team, topicId: string, responsible: string | null): Promise<AgentSession> {
  team.fakes.topics.put(buildTopic({ id: topicId, name: 'Checkout', slug: topicId.replace('_', '-'), phase: 'executing' }));
  const session = await team.fakes.agents.start({
    purpose: 'item',
    topic: { id: topicId, slug: topicId.replace('_', '-'), name: 'Checkout' },
    item: { id: 'cart-api', number: 1, title: 'Cart API', attempt: 1 },
    openedBy: principal(team, MEI),
    responsible: responsible === null ? null : refOf(team, responsible),
    workspace: { mode: 'main' },
    mode: 'ask-commands',
    rolePrompt: () => 'prompt',
  });
  team.fakes.plans.putPlan(buildPlan({ topicId, items: [buildWorkItem({ state: 'done', sessionId: session.id, attempt: 1 })] }));
  return session;
}

describe('the inbox of every member', () => {
  it('T6.1 what is in whose inbox, and when it leaves', async () => {
    const team = await setup();
    const { fakes } = team;
    const now = (): number => team.t.ctx.clock.now();

    /** One thing that waits: where it is expected (per key), and how it is settled. */
    interface Thing {
      readonly expected: Readonly<Record<string, readonly string[]>>;
      settle(): void | Promise<unknown>;
    }
    interface Row {
      readonly name: string;
      make(): Promise<Thing>;
    }

    const question = (responsible: string | null, escalated: boolean, expected: { question: string[]; vote: string[] }): Row => ({
      name: `a question; responsible: ${responsible ?? 'nobody'}${escalated ? '; escalated' : ''}`,
      make: async () => {
        const session = await freeSession(team, responsible);
        const asked = fakes.conversation.ask({ sessionId: session.id, eligible: 4, ...(escalated ? { escalatedAt: now() } : {}) });
        return {
          expected: { [`question:${asked.id}`]: expected.question, [`vote:${asked.id}`]: expected.vote },
          // Answered over the wire by the host (who may always submit): the fake settles the card.
          settle: () => team.clients[HOST]?.conn.request('question.submit', { questionId: asked.id, answers: [{ options: [0] }] }),
        };
      },
    });
    const permission = (responsible: string | null, flags: { escalated?: boolean; hostOnly?: boolean }, expected: string[]): Row => ({
      name: `a permission request; responsible: ${responsible ?? 'nobody'}${flags.escalated === true ? '; escalated' : ''}${flags.hostOnly === true ? '; host-only' : ''}`,
      make: async () => {
        const session = await freeSession(team, responsible);
        const request = fakes.conversation.request({
          sessionId: session.id,
          hostOnly: flags.hostOnly === true,
          ...(flags.hostOnly === true ? { alwaysRule: undefined, noAlways: 'host-only' as const } : {}),
          ...(flags.escalated === true ? { escalatedAt: now() } : {}),
        });
        return {
          expected: { [`permission:${request.id}`]: expected },
          settle: () => team.clients[HOST]?.conn.request('permission.decide', { requestId: request.id, decision: 'deny' }),
        };
      },
    });
    const suggestion = (responsible: string | null, expected: string[]): Row => ({
      name: `a suggestion of the editor; responsible: ${responsible ?? 'nobody'}`,
      make: async () => {
        const session = await freeSession(team, responsible);
        const created = await fakes.suggestions.create({ sessionId: session.id, text: 'Use the session store' }, principal(team, AMY));
        return {
          expected: { [`suggestion:${session.id}.dev-amy`]: expected },
          settle: () => team.clients[HOST]?.conn.request('suggest.reject', { suggestionId: created.id }),
        };
      },
    });
    let topics = 0;
    const report = (responsible: string | null, escalated: boolean, expected: string[]): Row => ({
      name: `a report to review; responsible: ${responsible ?? 'nobody'}${escalated ? '; escalated' : ''}`,
      make: async () => {
        topics += 1;
        const topicId = `tp_${topics}`;
        await itemSession(team, topicId, responsible);
        const registered = fakes.reports.register(topicId, 'cart-api', escalated ? { escalatedAt: now() } : {});
        return {
          expected: { [`report:${topicId}.cart-api`]: expected },
          settle: () => {
            fakes.reports.putReport({ ...registered, state: 'reviewed', review: { by: refOf(team, HOST), at: now(), version: registered.version } });
          },
        };
      },
    });
    let merges = 0;
    const merge = (name: string, overrides: Parameters<typeof buildMergeRequest>[0], expected: string[]): Row => ({
      name: `a merge request; ${name}`,
      make: async () => {
        merges += 1;
        const request = fakes.worktrees.putRequest(buildMergeRequest({ id: `mr_${merges}`, ...overrides }));
        return {
          expected: { [`merge:${request.id}`]: expected },
          settle: () => {
            fakes.worktrees.putRequest({ ...request, status: 'merged', decidedAt: now() });
          },
        };
      },
    });

    // The sessions are opened by Mei. Leo, the viewer, holds none of this in any row.
    const rows: readonly Row[] = [
      question(null, false, { question: [MEI], vote: [HOST, KEN, AMY] }),
      question(null, true, { question: [HOST, MEI, KEN], vote: [AMY] }),
      question(MEI, false, { question: [MEI], vote: [] }),
      question(KEN, false, { question: [KEN], vote: [] }),
      question(AMY, false, { question: [AMY], vote: [] }),
      question(AMY, true, { question: [HOST, MEI, KEN, AMY], vote: [] }),
      permission(null, {}, [HOST, MEI, KEN]),
      permission(MEI, {}, [MEI]),
      permission(MEI, { escalated: true }, [HOST, MEI, KEN]),
      permission(AMY, {}, [HOST, MEI, KEN]),
      permission(MEI, { hostOnly: true }, [HOST]),
      permission(null, { hostOnly: true, escalated: true }, [HOST]),
      suggestion(null, [HOST, MEI, KEN]),
      suggestion(MEI, [MEI]),
      suggestion(AMY, [HOST, MEI, KEN]),
      report(null, false, [HOST, MEI, KEN, AMY]),
      report(MEI, false, [MEI]),
      report(AMY, false, [AMY]),
      report(AMY, true, [HOST, MEI, KEN, AMY]),
      report(MEI, true, [HOST, MEI, KEN]),
      merge('pending', {}, [HOST]),
      merge('a reviewed draft: ready', { status: 'draft', requestedBy: undefined, reviewed: true }, [HOST]),
      merge('a conflict', { status: 'conflict', conflictFiles: ['src/cart.ts'] }, [HOST]),
      merge('a draft nobody reviewed', { status: 'draft', requestedBy: undefined }, []),
    ];

    for (const row of rows) {
      const thing = await row.make();
      for (const [key, expected] of Object.entries(thing.expected)) {
        expect(holders(team, key), `${row.name}: ${key}`).toEqual(expected);
        // Each of them is told over the wire, and nobody else is.
        await waitFor(() => expected.every((userId) => told(team, userId, key).includes('upsert')), { what: `${row.name}: inbox.changed for ${key}` });
        for (const userId of PEOPLE) if (!expected.includes(userId)) expect(told(team, userId, key), `${row.name}: ${userId}`).toEqual([]);
      }
      await thing.settle();
      // Settled: it leaves every inbox at the same moment, and every client that held it is told.
      for (const [key, expected] of Object.entries(thing.expected)) {
        expect(holders(team, key), `${row.name}: ${key} after it was settled`).toEqual([]);
        await waitFor(() => expected.every((userId) => told(team, userId, key).at(-1) === 'remove'), { what: `${row.name}: the removal of ${key}` });
      }
    }
    // Nothing is left anywhere, and the viewer was never told anything.
    for (const userId of PEOPLE) expect(inbox(team, userId)).toEqual([]);
    expect(team.changes[LEO]).toEqual([]);
  });

  it('T6.1 the same list over the wire: `inbox.list` answers the caller\'s own items, whoever asks', async () => {
    const team = await setup();
    const session = await freeSession(team, null);
    team.fakes.conversation.request({ sessionId: session.id });
    team.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1', message: 'add tests' }));
    const listOf = async (userId: string): Promise<string[]> => {
      const page = await team.clients[userId]?.conn.request('inbox.list', {});
      expect(page?.hasMore).toBe(false);
      expect(page?.items).toEqual(inbox(team, userId));
      return (page?.items ?? []).map((item) => item.kind);
    };
    expect(await listOf(HOST)).toEqual(['merge', 'permission']);
    expect(await listOf(MEI)).toEqual(['permission']);
    expect(await listOf(AMY)).toEqual([]);
    expect(await listOf(LEO)).toEqual([]);
    // An item names the session, the card, who else may answer; unread until it is looked at.
    expect(itemOf(team, MEI, inbox(team, MEI)[0]?.key as string)).toMatchObject({
      kind: 'permission',
      unread: true,
      waiting: true,
      sessionId: session.id,
      target: { kind: 'session', sessionId: session.id },
      excerpt: 'pnpm test',
      alsoFor: [refOf(team, HOST), refOf(team, KEN)],
    });
  });

  it('T6.1 a vote leaves when its member has voted; the question stays with its decider until it is answered', async () => {
    const team = await setup();
    const session = await freeSession(team, null);
    const asked = team.fakes.conversation.ask({ sessionId: session.id, eligible: 4 });
    expect(holders(team, `vote:${asked.id}`)).toEqual([HOST, KEN, AMY]);
    await team.clients[AMY]?.conn.request('question.vote', { questionId: asked.id, part: 0, options: [0] });
    expect(holders(team, `vote:${asked.id}`)).toEqual([HOST, KEN]);
    expect(itemOf(team, MEI, `question:${asked.id}`)).toMatchObject({ voted: 1, eligible: 4, allVoted: false, leading: 'On the server' });
    expect(itemOf(team, KEN, `vote:${asked.id}`)).toMatchObject({ voted: 1, eligible: 4, waitsFor: refOf(team, MEI), waitsForOffline: false });
    await waitFor(() => told(team, AMY, `vote:${asked.id}`).at(-1) === 'remove', { what: "the removal of Amy's vote item" });
    // The answer settles it for everyone who still held a vote.
    team.fakes.conversation.settleQuestion(asked.id, { status: 'withdrawn', withdrawn: { reason: 'stopped', at: team.t.ctx.clock.now() } });
    expect(holders(team, `vote:${asked.id}`)).toEqual([]);
    expect(holders(team, `question:${asked.id}`)).toEqual([]);
  });

  it('T6.1 changing who is responsible moves the items; so does a role change', async () => {
    const team = await setup();
    const session = await freeSession(team, MEI);
    const asked = team.fakes.conversation.ask({ sessionId: session.id });
    const request = team.fakes.conversation.request({ sessionId: session.id });
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    expect(holders(team, `permission:${request.id}`)).toEqual([MEI]);

    team.fakes.agents.setResponsible(session.id, refOf(team, KEN), principal(team, HOST).actor);
    expect(holders(team, `question:${asked.id}`)).toEqual([KEN]);
    expect(holders(team, `permission:${request.id}`)).toEqual([KEN]);
    await waitFor(() => told(team, MEI, `question:${asked.id}`).at(-1) === 'remove' && told(team, KEN, `question:${asked.id}`).at(-1) === 'upsert', { what: 'the question moving from Mei to Ken' });

    // Nobody: the member who opened the session decides, the others vote; permission goes to all who may allow.
    team.fakes.agents.setResponsible(session.id, null, principal(team, HOST).actor);
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    expect(holders(team, `vote:${asked.id}`)).toEqual([HOST, KEN, AMY]);
    expect(holders(team, `permission:${request.id}`)).toEqual([HOST, MEI, KEN]);

    // Amy gets agent access: the permission request is hers to answer too. Ken becomes a viewer: nothing is his.
    team.t.ctx.members.setRole(AMY, 'agent', SYSTEM_PRINCIPAL);
    team.t.ctx.members.setRole(KEN, 'viewer', SYSTEM_PRINCIPAL);
    await waitFor(() => holders(team, `permission:${request.id}`).join() === [HOST, MEI, AMY].join(), { what: 'the permission request after the role changes' });
    expect(holders(team, `vote:${asked.id}`)).toEqual([HOST, AMY]);
    expect(inbox(team, KEN)).toEqual([]);
  });

  it('T6.1 the responsible person is kicked: what waited for them is the next person\'s', async () => {
    const team = await setup();
    // A session of the host, Mei responsible: the teardown clears her (the fakes do what the sessions module does).
    const session = await freeSession(team, MEI, HOST);
    const asked = team.fakes.conversation.ask({ sessionId: session.id });
    const request = team.fakes.conversation.request({ sessionId: session.id });
    team.t.ctx.services.inbox.addMention({ userId: MEI, from: principal(team, AMY).actor, target: { kind: 'session', sessionId: session.id }, excerpt: '@Mei please look' });
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    expect(inbox(team, MEI)).toHaveLength(3);

    team.t.ctx.members.kick(MEI, SYSTEM_PRINCIPAL);
    await waitFor(() => holders(team, `question:${asked.id}`).join() === HOST, { what: 'the question at the host' });
    expect(holders(team, `permission:${request.id}`)).toEqual([HOST, KEN]);
    // She has no inbox any more: nothing derived, and her stored notes are gone for good.
    expect(inbox(team, MEI)).toEqual([]);
    team.t.advanceClock(1_000);
    await team.t.connect({ userId: MEI, displayName: 'Mei', inviteUrl: team.t.createInvite('agent') });
    await waitFor(() => holders(team, `permission:${request.id}`).join() === [HOST, MEI, KEN].join(), { what: 'Mei, back with agent access, among those who may allow' });
    // Nobody is responsible now and the host opened the session: the host decides, and Mei is asked to vote like the others.
    expect(inbox(team, MEI).map((item) => item.kind)).toEqual(['permission', 'vote']);
  });

  it("T6.1 an escalated item says who has not answered, and whether they are offline", async () => {
    const team = await setup();
    const session = await freeSession(team, AMY);
    const asked = team.fakes.conversation.ask({ sessionId: session.id, escalatedAt: team.t.ctx.clock.now() });
    const key = `question:${asked.id}`;
    expect(itemOf(team, KEN, key)).toMatchObject({ escalated: true, waitsFor: refOf(team, AMY), waitsForOffline: false, alsoFor: [refOf(team, AMY), refOf(team, HOST), refOf(team, MEI)] });
    expect(itemOf(team, AMY, key).waitsFor).toBeUndefined();
    team.clients[AMY]?.close();
    await waitFor(() => itemOf(team, KEN, key).waitsForOffline === true, { what: 'Amy offline in the copy of Ken' });
    await waitFor(() => (team.changes[KEN] ?? []).some((change) => change.upsert.some((item) => item.key === key && item.waitsForOffline === true)), { what: 'Ken told that Amy is offline' });
  });

  it('T4.4 stalls nobody would see', async () => {
    const team = await setup();
    const { fakes } = team;
    const at = team.t.ctx.clock.now();
    const session = await itemSession(team, 'tp_1', MEI);
    const item = { topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' } } as const;
    // What the topics module reports: an agent that stopped without a report (to the responsible person), a failed
    // item (nobody assigned: the member who started it), an item that could not start (its starter and the host), a
    // plan paused by a restart of the host's smurg (the host and everyone with agent access), a lost discussion.
    const stalled: AttentionFact = { subject: 'item-stalled', id: 'tp_1.cart-api', at, recipients: [MEI], ...item, sessionId: session.id, target: { kind: 'session', sessionId: session.id }, excerpt: '' };
    const failed: AttentionFact = { subject: 'item-failed', id: 'tp_1.payment', at, recipients: [KEN], topicId: 'tp_1', itemId: 'payment', item: { number: 2, title: 'Payment form' }, target: { kind: 'plan', topicId: 'tp_1' }, excerpt: '' };
    const notStarted: AttentionFact = { subject: 'item-not-started', id: 'tp_1.checkout', at, recipients: [KEN, HOST], topicId: 'tp_1', itemId: 'checkout', item: { number: 3, title: 'Checkout page' }, target: { kind: 'plan', topicId: 'tp_1' }, excerpt: '' };
    const paused: AttentionFact = { subject: 'plan-paused', id: 'tp_1', at, recipients: [HOST, MEI, KEN], topicId: 'tp_1', target: { kind: 'plan', topicId: 'tp_1' }, count: 3, excerpt: 'Checkout' };
    const lost: AttentionFact = { subject: 'discussion-lost', id: 'tp_1', at, recipients: [HOST, AMY], topicId: 'tp_1', target: { kind: 'plan', topicId: 'tp_1' }, excerpt: 'Checkout' };
    fakes.topics.setAttention([stalled, failed, notStarted, paused, lost]);

    const subjects = (userId: string): string[] => inbox(team, userId).map((entry) => entry.subject as string);
    expect(subjects(HOST).sort()).toEqual(['discussion-lost', 'item-not-started', 'plan-paused']);
    expect(subjects(MEI).sort()).toEqual(['item-stalled', 'plan-paused']);
    expect(subjects(KEN).sort()).toEqual(['item-failed', 'item-not-started', 'plan-paused']);
    expect(subjects(AMY)).toEqual(['discussion-lost']);
    expect(subjects(LEO)).toEqual([]);
    // Each of them stops work (the amber count), names its work item, and opens the session or the plan.
    for (const userId of PEOPLE) for (const entry of inbox(team, userId)) expect(entry).toMatchObject({ kind: 'attention', waiting: true, unread: true });
    expect(itemOf(team, MEI, 'attention:item-stalled:tp_1.cart-api')).toMatchObject({ ...item, sessionId: session.id, target: { kind: 'session', sessionId: session.id }, excerpt: '' });
    expect(itemOf(team, KEN, 'attention:item-not-started:tp_1.checkout')).toMatchObject({ item: { number: 3, title: 'Checkout page' }, target: { kind: 'plan', topicId: 'tp_1' } });
    expect(itemOf(team, HOST, 'attention:plan-paused:tp_1')).toMatchObject({ count: 3, excerpt: 'Checkout', topicId: 'tp_1' });
    // Every subject has its wording in both languages' catalogs (the row's sentence is the client's).
    for (const fact of [stalled, failed, notStarted, paused, lost]) expect(renderEnglish(attentionRef(fact.subject) ?? { id: 'inbox.itemGone' })).not.toBe('');
    await waitFor(() => told(team, MEI, 'attention:item-stalled:tp_1.cart-api').includes('upsert') && told(team, KEN, 'attention:item-failed:tp_1.payment').includes('upsert'), { what: 'the stalled and the failed item over the wire' });

    // The account stops sessions (the host); storage and the host's own rules only inform the host; project settings wait for the host.
    fakes.agents.attentionFacts = [
      { subject: 'account', id: 'workspace', at, recipients: [HOST], target: { kind: 'console', section: 'sessions' }, count: 4, excerpt: '' },
      { subject: 'storage', id: 'workspace', at, recipients: [HOST], target: { kind: 'console', section: 'sessions' }, excerpt: '' },
    ];
    fakes.agents.setAccount({ state: 'usage-limit', sessions: 4 });
    fakes.projectTrust.attentionFacts = [{ subject: 'project-settings', id: 'main', at, recipients: [HOST], target: { kind: 'console', section: 'claude-config' }, excerpt: '' }];
    fakes.projectTrust.set({ kind: 'main' }, 'ignored');
    fakes.hostRules.found(['Bash(npm run *)', 'Bash(git status)']);
    expect(itemOf(team, HOST, 'attention:account:workspace')).toMatchObject({ waiting: true, count: 4, target: { kind: 'console', section: 'sessions' } });
    expect(itemOf(team, HOST, 'attention:storage:workspace')).toMatchObject({ waiting: false });
    expect(itemOf(team, HOST, 'attention:project-settings:main')).toMatchObject({ waiting: true, target: { kind: 'console', section: 'claude-config' } });
    expect(itemOf(team, HOST, 'attention:host-rules:workspace')).toMatchObject({ waiting: false, count: 2, target: { kind: 'console', section: 'host-rules' } });
    expect(subjects(MEI).sort()).toEqual(['item-stalled', 'plan-paused']);

    // A fact ends: its item leaves every inbox that held it; the others stay.
    fakes.topics.setAttention([notStarted, lost]);
    expect(subjects(MEI)).toEqual([]);
    expect(subjects(KEN)).toEqual(['item-not-started']);
    await waitFor(() => told(team, MEI, 'attention:item-stalled:tp_1.cart-api').at(-1) === 'remove' && told(team, KEN, 'attention:plan-paused:tp_1').at(-1) === 'remove', { what: 'the removals' });
    await fakes.hostRules.markSeen(principal(team, HOST));
    fakes.agents.attentionFacts = [];
    fakes.agents.setAccount({ state: 'ok', sessions: 0 });
    fakes.projectTrust.attentionFacts = [];
    fakes.projectTrust.set({ kind: 'main' }, 'used');
    fakes.topics.setAttention([]);
    for (const userId of PEOPLE) expect(inbox(team, userId)).toEqual([]);
  });

  it('T4.4 a fact keeps the time it began while it lasts, however often its owner is asked', async () => {
    const team = await setup();
    team.fakes.hostRules.found(['Bash(npm run *)']);
    const first = itemOf(team, HOST, 'attention:host-rules:workspace');
    await waitFor(() => told(team, HOST, 'attention:host-rules:workspace').includes('upsert'), { what: 'the item at the host' });
    const before = (team.changes[HOST] ?? []).length;
    team.t.advanceClock(60_000);
    // The fake stamps the fact with "now" every time it is asked: the item does not grow younger, nobody is told again.
    team.t.ctx.bus.emit('attention.changed', { source: 'host-rules' });
    expect(itemOf(team, HOST, 'attention:host-rules:workspace')).toEqual(first);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((team.changes[HOST] ?? []).length).toBe(before);
    expect(told(team, HOST, 'attention:host-rules:workspace')).toEqual(['upsert']);
    // It ended and began again: a new time.
    await team.fakes.hostRules.markSeen(principal(team, HOST));
    expect(inbox(team, HOST)).toEqual([]);
    team.fakes.hostRules.found(['Bash(npm run *)']);
    expect(itemOf(team, HOST, 'attention:host-rules:workspace').at).toBeGreaterThan(first.at);
  });

  it('T6.2 mentions', async () => {
    const team = await setup({ agents: { inboxNotesPerMember: 3 } });
    const service = team.t.ctx.services.inbox;
    const session = await itemSession(team, 'tp_1', MEI);
    const from = principal(team, MEI).actor;
    // A mention reaches the mentioned member whatever their role.
    for (const userId of PEOPLE) {
      expect(service.addMention({ userId, from, target: { kind: 'session', sessionId: session.id }, anchor: { cardId: 'q_1', seq: 7 }, excerpt: `@${refOf(team, userId).displayName} the server, please` })).toBe('stored');
    }
    for (const userId of PEOPLE) {
      const [item, ...rest] = inbox(team, userId);
      expect(rest).toEqual([]);
      expect(item).toMatchObject({
        kind: 'mention',
        unread: true,
        waiting: false,
        from,
        excerpt: `@${refOf(team, userId).displayName} the server, please`,
        target: { kind: 'session', sessionId: session.id },
        anchor: { cardId: 'q_1', seq: 7 },
        sessionId: session.id,
        topicId: 'tp_1',
        itemId: 'cart-api',
        item: { number: 1, title: 'Cart API' },
      });
      expect(item?.key).toMatch(/^mention:nt_[A-Za-z0-9_-]{22}$/);
      await waitFor(() => told(team, userId, item?.key as string).includes('upsert'), { what: `the mention at ${userId}` });
      expect((await team.clients[userId]?.conn.request('inbox.list', {}))?.items).toEqual([item]);
    }
    // The viewer's inbox holds only this.
    expect(inbox(team, LEO).map((item) => item.kind)).toEqual(['mention']);

    // Opening it (`inbox.seen` of its key) removes it; so does dismissing it. Other members' mentions stay.
    const leos = inbox(team, LEO)[0]?.key as string;
    team.clients[LEO]?.conn.notify('inbox.seen', { keys: [leos] });
    await waitFor(() => inbox(team, LEO).length === 0, { what: 'the opened mention leaving' });
    await waitFor(() => told(team, LEO, leos).at(-1) === 'remove', { what: 'the removal at the viewer' });
    const amys = inbox(team, AMY)[0]?.key as string;
    expect(await team.clients[AMY]?.conn.request('inbox.dismiss', { key: amys })).toEqual({});
    expect(inbox(team, AMY)).toEqual([]);
    await expect(team.clients[AMY]?.conn.request('inbox.dismiss', { key: amys })).rejects.toMatchObject({ code: 'not_found', text: { id: 'inbox.itemGone' } });
    // Nobody opens or dismisses another member's mention.
    const hosts = inbox(team, HOST)[0]?.key as string;
    team.clients[KEN]?.conn.notify('inbox.seen', { keys: [hosts] });
    await expect(team.clients[KEN]?.conn.request('inbox.dismiss', { key: hosts })).rejects.toMatchObject({ code: 'not_found' });
    expect(inbox(team, HOST).map((item) => item.key)).toEqual([hosts]);

    // An agent's `notify_member` is a mention from that agent; a long text is clipped, an unshowable character goes.
    const agent = team.fakes.agents.agentActor(session.id);
    expect(service.addMention({ userId: LEO, from: agent, target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, excerpt: `look\u0000 ${'x'.repeat(400)}` })).toBe('stored');
    const fromAgent = inbox(team, LEO)[0];
    expect(fromAgent).toMatchObject({ kind: 'mention', from: { kind: 'agent', sessionId: session.id }, target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, topicId: 'tp_1', itemId: 'cart-api', item: { number: 1, title: 'Cart API' } });
    expect(fromAgent?.excerpt).toHaveLength(300);
    expect(fromAgent?.excerpt.startsWith('look x')).toBe(true);
    expect(fromAgent?.anchor).toBeUndefined();

    // Full: three unopened notes. The next one is not stored and nobody is told by the inbox (the caller tells the
    // sender); an unopened note is never pushed out. Opening one makes room again.
    expect(service.addMention({ userId: LEO, from, target: { kind: 'spec', topicId: 'tp_1' }, excerpt: 'two' })).toBe('stored');
    expect(service.addMention({ userId: LEO, from, target: { kind: 'plan', topicId: 'tp_1' }, excerpt: 'three' })).toBe('stored');
    const full = inbox(team, LEO).map((item) => item.key);
    expect(full).toHaveLength(3);
    expect(service.addMention({ userId: LEO, from, target: { kind: 'plan', topicId: 'tp_1' }, excerpt: 'four' })).toBe('full');
    service.addResult({ userId: LEO, from, suggestionId: 'sg_1', sessionId: session.id, outcome: 'rejected', excerpt: 'not stored either' });
    expect(inbox(team, LEO).map((item) => item.key)).toEqual(full);
    service.seen(principal(team, LEO), [full[0] as string]);
    expect(service.addMention({ userId: LEO, from, target: { kind: 'plan', topicId: 'tp_1' }, excerpt: 'four' })).toBe('stored');
    const afterwards = inbox(team, LEO);
    expect(afterwards).toHaveLength(3);
    expect(afterwards.map((item) => item.key)).not.toContain(full[0]);
    expect(afterwards.map((item) => item.excerpt)).toContain('four');
    // Somebody who is not a member has no inbox to fill.
    expect(service.addMention({ userId: 'dev:nobody', from, target: { kind: 'plan', topicId: 'tp_1' }, excerpt: 'x' })).toBe('stored');
    expect(service.itemsOf('dev:nobody')).toEqual([]);
  });

  it('S13 the caps: 200 unopened notes per member, and one more is refused without pushing any out', async () => {
    const team = await setup({}, [HOST, LEO]);
    const service = team.t.ctx.services.inbox;
    const from = principal(team, HOST).actor;
    const target = { kind: 'console', section: 'members' } as const;
    for (let index = 0; index < INBOX_NOTES_PER_MEMBER_MAX; index += 1) expect(service.addMention({ userId: LEO, from, target, excerpt: `mention ${index}` })).toBe('stored');
    expect(service.addMention({ userId: LEO, from, target, excerpt: 'one too many' })).toBe('full');
    const held = inbox(team, LEO);
    expect(held).toHaveLength(INBOX_NOTES_PER_MEMBER_MAX);
    expect(new Set(held.map((item) => item.excerpt))).toEqual(new Set(Array.from({ length: INBOX_NOTES_PER_MEMBER_MAX }, (_, index) => `mention ${index}`)));
    // Another member's box is their own.
    expect(service.addMention({ userId: HOST, from, target, excerpt: 'to the host' })).toBe('stored');
    // The whole box in one list reply, and over the wire in as many inbox.changed messages as it took.
    const page = await team.clients[LEO]?.conn.request('inbox.list', {});
    expect(page?.items).toHaveLength(INBOX_NOTES_PER_MEMBER_MAX);
    expect(page?.hasMore).toBe(false);
    await waitFor(() => new Set((team.changes[LEO] ?? []).flatMap((change) => change.upsert.map((item) => item.key))).size === INBOX_NOTES_PER_MEMBER_MAX, { what: 'every note at the viewer' });
  }, 30_000);

  it('T6.2 what became of my suggestion: a result for its author, opened or dismissed like a mention', async () => {
    const team = await setup();
    const service = team.t.ctx.services.inbox;
    const session = await freeSession(team, MEI);
    const by = principal(team, MEI).actor;
    service.addResult({ userId: AMY, from: by, suggestionId: 'sg_1', sessionId: session.id, outcome: 'rejected', excerpt: 'Use the session store' });
    service.addResult({ userId: AMY, from: by, suggestionId: 'sg_2', sessionId: session.id, outcome: 'accepted-edited', excerpt: 'Keep the cart on the server' });
    // Told twice about one suggestion: one result.
    service.addResult({ userId: AMY, from: by, suggestionId: 'sg_2', sessionId: session.id, outcome: 'accepted-edited', excerpt: 'Keep the cart on the server' });
    const items = inbox(team, AMY);
    expect(items.map((item) => [item.kind, item.result, item.anchor?.cardId, item.excerpt]).sort()).toEqual([
      ['result', 'accepted-edited', 'sg_2', 'Keep the cart on the server'],
      ['result', 'rejected', 'sg_1', 'Use the session store'],
    ]);
    for (const item of items) expect(item).toMatchObject({ unread: true, waiting: false, from: by, sessionId: session.id, target: { kind: 'session', sessionId: session.id } });
    expect(inbox(team, MEI)).toEqual([]);
    team.clients[AMY]?.conn.notify('inbox.seen', { keys: [items[0]?.key as string] });
    await waitFor(() => inbox(team, AMY).length === 1, { what: 'the opened result leaving' });
    await team.clients[AMY]?.conn.request('inbox.dismiss', { key: items[1]?.key as string });
    expect(inbox(team, AMY)).toEqual([]);
  });

  it('T6.2 a deleted topic takes the notes that point into it', async () => {
    const team = await setup();
    const service = team.t.ctx.services.inbox;
    const from = principal(team, MEI).actor;
    service.addMention({ userId: AMY, from, target: { kind: 'session', sessionId: 'sess_gone' }, excerpt: 'in a session of the topic' });
    service.addMention({ userId: AMY, from, target: { kind: 'spec', topicId: 'tp_gone' }, excerpt: 'in its spec' });
    service.addMention({ userId: AMY, from, target: { kind: 'report', topicId: 'tp_gone', itemId: 'cart-api' }, excerpt: 'in a report' });
    service.addResult({ userId: AMY, from, suggestionId: 'sg_1', sessionId: 'sess_gone', outcome: 'rejected', excerpt: 'a result in its session' });
    service.addMention({ userId: AMY, from, target: { kind: 'plan', topicId: 'tp_kept' }, excerpt: 'another topic' });
    service.addMention({ userId: AMY, from, target: { kind: 'session', sessionId: 'sess_kept' }, excerpt: 'another session' });
    expect(inbox(team, AMY)).toHaveLength(6);
    team.t.ctx.bus.emit('topic.removed', { topicId: 'tp_gone', sessionIds: ['sess_gone'] });
    expect(inbox(team, AMY).map((item) => item.excerpt).sort()).toEqual(['another session', 'another topic']);
  });
});

describe('unread', () => {
  it('an item is unread until its member looks at it; `inbox.seen` is the member\'s own and reaches their other devices', async () => {
    const team = await setup();
    const session = await freeSession(team, null);
    const request = team.fakes.conversation.request({ sessionId: session.id });
    const key = `permission:${request.id}`;
    const laptop = await team.clients[MEI]?.reconnect({ inviteUrl: team.t.createInvite('agent') });
    const onLaptop: Change[] = [];
    laptop?.conn.on('inbox.changed', (payload) => onLaptop.push(payload));
    expect(itemOf(team, MEI, key).unread).toBe(true);
    team.clients[MEI]?.conn.notify('inbox.seen', { keys: [key, 'question:q_unknown', `merge:not-hers`] });
    await waitFor(() => itemOf(team, MEI, key).unread === false, { what: 'the item read' });
    await waitFor(() => onLaptop.some((change) => change.upsert.some((item) => item.key === key && !item.unread)), { what: 'the other device told' });
    // Her mark is hers: the others' copies are still unread, and nobody else was told anything.
    expect(itemOf(team, HOST, key).unread).toBe(true);
    expect(itemOf(team, KEN, key).unread).toBe(true);
    expect(told(team, KEN, key)).toEqual(['upsert']);
    // Seen again: nothing changes, nothing is sent.
    const sent = (team.changes[MEI] ?? []).length;
    team.t.ctx.services.inbox.seen(principal(team, MEI), [key]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((team.changes[MEI] ?? []).length).toBe(sent);
    // A permission request is unread once: escalating it does not make it unread again.
    team.fakes.conversation.putPermission({ ...request, escalatedAt: team.t.ctx.clock.now() });
    expect(itemOf(team, MEI, key)).toMatchObject({ unread: false, escalated: true });
  });

  it('a question is unread again when everyone eligible has voted, each time that happens', async () => {
    const team = await setup();
    const { fakes } = team;
    const session = await freeSession(team, MEI);
    const asked = fakes.conversation.ask({ sessionId: session.id, eligible: 2 });
    const key = `question:${asked.id}`;
    const mei = principal(team, MEI);
    const vote = (userId: string): { userId: string; displayName: string; part: number; options: number[]; at: number } => ({ ...refOf(team, userId), part: 0, options: [0], at: team.t.ctx.clock.now() });
    team.t.ctx.services.inbox.seen(mei, [key]);
    expect(itemOf(team, MEI, key)).toMatchObject({ unread: false, allVoted: false });
    fakes.conversation.putQuestion({ ...asked, votes: [vote(HOST)] });
    expect(itemOf(team, MEI, key)).toMatchObject({ unread: false, voted: 1 });
    fakes.conversation.putQuestion({ ...asked, votes: [vote(HOST), vote(KEN)] });
    expect(itemOf(team, MEI, key)).toMatchObject({ unread: true, allVoted: true, leading: 'On the server' });
    team.t.ctx.services.inbox.seen(mei, [key]);
    expect(itemOf(team, MEI, key).unread).toBe(false);
    // Amy comes online and counts: no longer "all voted", and that does not make the item unread ...
    fakes.conversation.putQuestion({ ...asked, eligible: 3, votes: [vote(HOST), vote(KEN)] });
    expect(itemOf(team, MEI, key)).toMatchObject({ unread: false, allVoted: false });
    // ... until she has voted too.
    fakes.conversation.putQuestion({ ...asked, eligible: 3, votes: [vote(HOST), vote(KEN), vote(AMY)] });
    expect(itemOf(team, MEI, key)).toMatchObject({ unread: true, allVoted: true });
  });

  it('a new version of a report, one more suggestion and a merge request that changed are unread again', async () => {
    const team = await setup();
    const { fakes } = team;
    const service = team.t.ctx.services.inbox;
    const session = await itemSession(team, 'tp_1', MEI);
    const registered = fakes.reports.register('tp_1', 'cart-api');
    const first = await fakes.suggestions.create({ sessionId: session.id, text: 'first' }, principal(team, AMY));
    const draft = fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1', status: 'draft', requestedBy: undefined, reviewed: true, topicId: 'tp_1', itemId: 'cart-api' }));
    const suggestions = `suggestion:${session.id}.dev-amy`;
    service.seen(principal(team, MEI), ['report:tp_1.cart-api', suggestions]);
    service.seen(principal(team, HOST), ['merge:mr_1']);
    expect(itemOf(team, MEI, 'report:tp_1.cart-api').unread).toBe(false);
    expect(itemOf(team, MEI, suggestions)).toMatchObject({ unread: false, count: 1 });
    expect(itemOf(team, HOST, 'merge:mr_1')).toMatchObject({ unread: false, ready: true, item: { number: 1, title: 'Cart API' } });

    fakes.reports.putReport({ ...registered, version: 2 });
    expect(itemOf(team, MEI, 'report:tp_1.cart-api').unread).toBe(true);
    await fakes.suggestions.create({ sessionId: session.id, text: 'second' }, principal(team, AMY));
    expect(itemOf(team, MEI, suggestions)).toMatchObject({ unread: true, count: 2, anchor: { cardId: first.id }, excerpt: 'first' });
    fakes.worktrees.putRequest({ ...draft, status: 'conflict', conflictFiles: ['src/cart.ts'] });
    expect(itemOf(team, HOST, 'merge:mr_1')).toMatchObject({ unread: true, ready: false, conflict: true });

    // Seen again, and the oldest suggestion settled: the item opens at the next one and stays read.
    service.seen(principal(team, MEI), [suggestions]);
    await fakes.suggestions.reject({ suggestionId: first.id }, principal(team, MEI));
    expect(itemOf(team, MEI, suggestions)).toMatchObject({ unread: false, count: 1, excerpt: 'second' });
    // Reviewed, then changed after the review: it comes back, unread.
    fakes.reports.putReport({ ...registered, version: 2, state: 'reviewed', review: { by: refOf(team, MEI), at: team.t.ctx.clock.now(), version: 2 } });
    expect(holders(team, 'report:tp_1.cart-api')).toEqual([]);
    fakes.reports.putReport({ ...registered, version: 3, state: 'changed-after-review', review: { by: refOf(team, MEI), at: team.t.ctx.clock.now(), version: 2 } });
    expect(itemOf(team, MEI, 'report:tp_1.cart-api')).toMatchObject({ unread: true, outcome: 'complete' });
  });

  it('notes and marks are in inbox.json: they are there after a restart; a mark lasts as long as its item', async () => {
    const stateDir = await createTempRunDir();
    const projectBase = await createTempDir('inbox-restart');
    try {
      const root = await createTempProject(projectBase, 'project', { files: { 'a.md': 'a\n' } });
      const workspaceId = 'ws_test_inbox_restart';
      const first = await setup({ stateDir, root, workspaceId }, [HOST, AMY]);
      const from = principal(first, HOST).actor;
      first.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1' }));
      first.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_2' }));
      first.t.ctx.services.inbox.seen(principal(first, HOST), ['merge:mr_1', 'merge:mr_2']);
      first.t.ctx.services.inbox.addMention({ userId: AMY, from, target: { kind: 'console', section: 'members' }, excerpt: '@Amy welcome' });
      first.t.ctx.services.inbox.addResult({ userId: AMY, from, suggestionId: 'sg_1', sessionId: 'sess_a', outcome: 'rejected', excerpt: 'mine' });
      const amys = inbox(first, AMY);
      expect(amys.map((item) => item.kind)).toEqual(['mention', 'result']);
      // What a module puts away while the daemon stops is not "settled": the marks stay as they were.
      first.t.ctx.bus.on('daemon.stopping', () => first.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1', status: 'rejected' })));
      await first.t.cleanup();

      // The restarted daemon: the worktree module has its merge request again when the inbox takes its first view.
      const seed: FeatureModule = {
        name: 'seed',
        register: () => toDisposable(() => {}),
        start: async (ctx) => {
          fakesOf(ctx).worktrees.putRequest(buildMergeRequest({ id: 'mr_1' }));
        },
      };
      t = await createTestDaemon({ stateDir, root, workspaceId, modules: [fakesModule({ except: ['inbox'] }), seed, inboxModule], agents: { escalationSweepMs: NO_SWEEP } });
      const again = t.ctx.services.inbox;
      expect(again.itemsOf(AMY)).toEqual(amys);
      expect(again.itemsOf(HOST)).toMatchObject([{ key: 'merge:mr_1', unread: false }]);
      // mr_2 was not there at the start: its mark went with it, so it is unread when it comes (back).
      fakesOf(t.ctx).worktrees.putRequest(buildMergeRequest({ id: 'mr_2' }));
      expect(again.itemsOf(HOST)).toMatchObject([
        { key: 'merge:mr_1', unread: false },
        { key: 'merge:mr_2', unread: true },
      ]);
    } finally {
      await t?.cleanup();
      t = null;
      await removeTempDir(projectBase);
      await removeTempRunDir(stateDir);
    }
  }, 30_000);
});

describe('inbox.dismiss and inbox.list', () => {
  it('a thing that waits cannot be dismissed (`inbox.notDismissable`); something that is not there is gone (`inbox.itemGone`)', async () => {
    const team = await setup();
    const session = await freeSession(team, MEI);
    const request = team.fakes.conversation.request({ sessionId: session.id });
    const refused = await team.clients[MEI]?.conn.request('inbox.dismiss', { key: `permission:${request.id}` }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'conflict', detail: { reason: 'not-dismissable' }, text: { id: 'inbox.notDismissable' }, message: 'This item leaves the inbox when it is settled.' });
    expect(holders(team, `permission:${request.id}`)).toEqual([MEI]);
    // Not in MY inbox: gone, whether or not it is in somebody else's.
    const gone = await team.clients[KEN]?.conn.request('inbox.dismiss', { key: `permission:${request.id}` }).catch((error: unknown) => error);
    expect(gone).toMatchObject({ code: 'not_found', text: { id: 'inbox.itemGone' }, message: 'This item is no longer waiting.' });
    // Not a member's request: an agent or the daemon itself has no inbox.
    const service = team.t.ctx.services.inbox;
    expect(service.list(SYSTEM_PRINCIPAL)).toEqual({ items: [], hasMore: false });
    expect(service.list({ kind: 'agent', actor: team.fakes.agents.agentActor(session.id), userId: MEI, role: 'agent' })).toEqual({ items: [], hasMore: false });
    expect(() => service.dismiss(SYSTEM_PRINCIPAL, `permission:${request.id}`)).toThrow(expect.objectContaining({ code: 'forbidden' }));
    service.seen(SYSTEM_PRINCIPAL, [`permission:${request.id}`]);
    expect(itemOf(team, MEI, `permission:${request.id}`).unread).toBe(true);
  });

  it('THE list rule: key order, `after` continues, and an `after` that left the box continues where it was', async () => {
    const team = await setup({}, [HOST]);
    for (const id of ['mr_a', 'mr_b', 'mr_c', 'mr_d']) team.fakes.worktrees.putRequest(buildMergeRequest({ id }));
    const service = team.t.ctx.services.inbox;
    const host = principal(team, HOST);
    const keys = (after?: string): string[] => service.list(host, after === undefined ? {} : { after }).items.map((item) => item.key);
    expect(keys()).toEqual(['merge:mr_a', 'merge:mr_b', 'merge:mr_c', 'merge:mr_d']);
    expect(keys('merge:mr_b')).toEqual(['merge:mr_c', 'merge:mr_d']);
    expect(keys('merge:mr_d')).toEqual([]);
    team.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_b', status: 'merged' }));
    expect(keys('merge:mr_b')).toEqual(['merge:mr_c', 'merge:mr_d']);
    expect((await team.clients[HOST]?.conn.request('inbox.list', { after: 'merge:mr_c' }))?.items.map((item) => item.key)).toEqual(['merge:mr_d']);
  });

  it('an inbox holds at most INBOX_ITEMS_MAX items: what stops work stays, the oldest of the rest are left out', async () => {
    const team = await setup({}, [HOST]);
    const at = team.t.ctx.clock.now();
    const informs: AttentionFact[] = Array.from({ length: INBOX_ITEMS_MAX }, (_, index) => ({ subject: 'storage', id: `s${index}`, at: at + index, recipients: [HOST], target: { kind: 'console', section: 'sessions' }, excerpt: '' }));
    const stops: AttentionFact[] = Array.from({ length: 5 }, (_, index) => ({ subject: 'item-failed', id: `f${index}`, at: at - 1_000 - index, recipients: [HOST], topicId: 'tp_1', target: { kind: 'plan', topicId: 'tp_1' }, excerpt: '' }));
    team.fakes.topics.setAttention([...informs, ...stops]);
    const items = team.t.ctx.services.inbox.itemsOf(HOST);
    expect(items).toHaveLength(INBOX_ITEMS_MAX);
    expect(items.filter((item) => item.waiting)).toHaveLength(5);
    const kept = new Set(items.map((item) => item.key));
    expect(['s0', 's1', 's2', 's3', 's4'].filter((id) => kept.has(`attention:storage:${id}`))).toEqual([]);
    expect(kept.has('attention:storage:s5') && kept.has(`attention:storage:s${INBOX_ITEMS_MAX - 1}`)).toBe(true);
    const page = await team.clients[HOST]?.conn.request('inbox.list', {});
    expect(page?.items).toHaveLength(INBOX_ITEMS_MAX);
    expect(page?.hasMore).toBe(false);
  }, 30_000);

  it('inbox.changed keeps the size rule of a list: the removed keys with the first message, the upserts spread over as many as it takes', () => {
    const items = Array.from({ length: 7 }, (_, index) => buildInboxItem('mention', { key: `mention:nt_${index}`, excerpt: 'x'.repeat(200) }));
    const one = encodedSize(items[0]);
    const remove = ['question:q_1', 'vote:q_2'];
    expect(changePages(items, remove)).toEqual([{ upsert: items, remove }]);
    const pages = changePages(items, remove, { maxBytes: 3 * one + encodedSize(remove) + 8 });
    expect(pages.map((page) => page.upsert.length)).toEqual([3, 3, 1]);
    expect(pages.map((page) => page.remove)).toEqual([remove, [], []]);
    expect(pages.flatMap((page) => page.upsert)).toEqual(items);
    // At most `maxItems` entries a message; an item that alone is over the budget still goes, alone.
    expect(changePages(items, [], { maxItems: 4 }).map((page) => page.upsert.length)).toEqual([4, 3]);
    expect(changePages(items.slice(0, 2), [], { maxBytes: 10 }).map((page) => page.upsert.length)).toEqual([1, 1]);
    // No room beside the removed keys: they go first, alone.
    expect(changePages(items.slice(0, 1), remove, { maxBytes: encodedSize(remove) }).map((page) => [page.upsert.length, page.remove.length])).toEqual([
      [0, 2],
      [1, 0],
    ]);
    expect(changePages([], remove)).toEqual([{ upsert: [], remove }]);
  });
});

describe('where the inbox reads from', () => {
  it('a source that throws keeps what it said last; the others go on', async () => {
    const team = await setup({}, [HOST]);
    const session = await freeSession(team, null, HOST);
    const request = team.fakes.conversation.request({ sessionId: session.id });
    expect(holders(team, `permission:${request.id}`)).toEqual([HOST]);
    const original = team.fakes.conversation.openPermissions.bind(team.fakes.conversation);
    team.fakes.conversation.openPermissions = () => {
      throw new Error('not ready');
    };
    team.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1' }));
    expect(inbox(team, HOST).map((item) => item.kind)).toEqual(['merge', 'permission']);
    team.fakes.conversation.openPermissions = original;
    team.fakes.conversation.settlePermission(request.id, { status: 'denied', decision: { by: refOf(team, HOST), at: team.t.ctx.clock.now() } });
    expect(inbox(team, HOST).map((item) => item.kind)).toEqual(['merge']);
  });

  it('a module that is not composed contributes nothing, and nothing fails', async () => {
    const team = await setup({ modules: [fakesModule({ except: ['inbox', 'conversation', 'reports', 'plans', 'topics', 'agents', 'projectTrust', 'hostRules'] }), createInboxModule()] }, [HOST, AMY]);
    team.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1', topicId: 'tp_1', itemId: 'cart-api' }));
    await team.fakes.suggestions.put(buildSuggestion({ sessionId: 'sess_x' }));
    expect(inbox(team, HOST)).toMatchObject([
      { key: 'merge:mr_1', item: { number: 0, title: 'cart-api' } },
      { key: 'suggestion:sess_x.dev-amy', count: 1 },
    ]);
    expect(team.t.ctx.services.inbox.addMention({ userId: AMY, from: principal(team, HOST).actor, target: { kind: 'session', sessionId: 'sess_x' }, excerpt: 'x' })).toBe('stored');
    expect(inbox(team, AMY)).toMatchObject([{ kind: 'mention', sessionId: 'sess_x' }]);
  });

  it('the sweep looks again by itself: a change nobody announced still reaches the inbox', async () => {
    const team = await setup({ agents: { escalationSweepMs: 10 } }, [HOST, MEI]);
    // The fact is there, but its owner says nothing on the bus.
    team.fakes.topics.attentionFacts = [{ subject: 'plan-paused', id: 'tp_1', at: team.t.ctx.clock.now(), recipients: [HOST, MEI], topicId: 'tp_1', target: { kind: 'plan', topicId: 'tp_1' }, count: 2, excerpt: 'Checkout' }];
    await waitFor(() => told(team, MEI, 'attention:plan-paused:tp_1').includes('upsert'), { what: 'the paused plan found by the sweep' });
    team.fakes.topics.attentionFacts = [];
    await waitFor(() => told(team, MEI, 'attention:plan-paused:tp_1').at(-1) === 'remove', { what: 'the paused plan gone at the next sweep' });
  });

  it('a running agent does not make the inbox recompute: only what an inbox reads of a session does', async () => {
    const team = await setup({}, [HOST, MEI, KEN]);
    const { fakes } = team;
    let reads = 0;
    const original = fakes.conversation.openQuestions.bind(fakes.conversation);
    fakes.conversation.openQuestions = () => {
      reads += 1;
      return original();
    };
    const session = await freeSession(team, MEI);
    const asked = fakes.conversation.ask({ sessionId: session.id });
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    await settle();
    const before = reads;
    // A turn: the session is updated again and again (status, activity, the event counter). Nobody's inbox changes.
    fakes.agents.say(session.id, 'Looking at the cart.');
    fakes.agents.edit(session.id, { root: { kind: 'main' }, path: 'src/cart.ts' });
    fakes.agents.finishTurn(session.id);
    fakes.agents.setTitle(session.id, 'Cart work', principal(team, MEI).actor);
    // A terminal is in nobody's inbox.
    await team.clients[MEI]?.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    await settle();
    expect(reads).toBe(before);
    // Who is responsible is what an inbox reads.
    fakes.agents.setResponsible(session.id, refOf(team, KEN), principal(team, HOST).actor);
    await settle();
    expect(reads).toBeGreaterThan(before);
    expect(holders(team, `question:${asked.id}`)).toEqual([KEN]);
    // So is the fallback decider, once nobody is responsible.
    fakes.agents.setResponsible(session.id, null, principal(team, HOST).actor);
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    fakes.agents.clearFallbackDecider(MEI);
    fakes.agents.setTitle(session.id, 'Cart work, continued', principal(team, MEI).actor);
    expect(holders(team, `question:${asked.id}`)).toEqual([HOST]);
  });

  it('a member leaves: the sessions they started pass to the host, and so does what waited for them', async () => {
    const team = await setup({}, [HOST, MEI, KEN]);
    // A work item Mei started, nobody responsible: she decides its questions (the fallback decider).
    const session = await itemSession(team, 'tp_1', null);
    const asked = team.fakes.conversation.ask({ sessionId: session.id });
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    expect(holders(team, `vote:${asked.id}`)).toEqual([HOST, KEN]);
    await team.clients[MEI]?.conn.leave();
    // She is still a member; the teardown cleared her as fallback decider (nothing on the bus says so): the host decides.
    await waitFor(() => holders(team, `question:${asked.id}`).join() === HOST, { what: 'the question at the host' });
    expect(holders(team, `vote:${asked.id}`)).toEqual([MEI, KEN]);
  });

  it('the teardown of a member who went runs after the event and says nothing: the inbox looks again shortly after', async () => {
    const team = await setup({}, [HOST, MEI, KEN]);
    const session = await freeSession(team, null);
    const asked = team.fakes.conversation.ask({ sessionId: session.id });
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    // The event of a role change that takes nothing away (the core runs no teardown for it) ...
    team.t.ctx.bus.emit('member.role-changed', { userId: KEN, from: 'agent', to: 'agent', by: SYSTEM_PRINCIPAL.actor });
    await settle();
    // ... and then what a teardown would do last, with nothing on the bus: only looking again finds it (no sweep here).
    team.fakes.agents.clearFallbackDecider(MEI);
    expect(holders(team, `question:${asked.id}`)).toEqual([MEI]);
    await waitFor(() => holders(team, `question:${asked.id}`).join() === HOST, { what: 'the question at the host', timeoutMs: 2_000 });
  });

  it("inbox.changed goes to the member's own web channels, never to the host's control socket", async () => {
    const team = await setup({}, [HOST]);
    const local: string[] = [];
    const attachment = team.t.ctx.lifecycle.attachLocal({
      userId: HOST,
      deviceName: 'smurg CLI (local)',
      send: (bytes) => {
        const decoded = decodeEnvelope(bytes, { from: 'daemon', channel: 'interactive' });
        if (decoded.ok) local.push(decoded.envelope.type);
      },
      close: () => {},
    });
    attachment.open();
    team.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1' }));
    team.t.ctx.services.inbox.addMention({ userId: HOST, from: principal(team, HOST).actor, target: { kind: 'console', section: 'merges' }, excerpt: '@Host look' });
    await waitFor(() => told(team, HOST, 'merge:mr_1').includes('upsert') && (team.changes[HOST] ?? []).some((change) => change.upsert.some((item) => item.kind === 'mention')), { what: 'both items at the web client' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(local).not.toContain('inbox.changed');
    attachment.end();
  });

  it('a note that is not valid for the wire is not stored, and never fails the request that caused it', async () => {
    const log = createMemoryLogger();
    const team = await setup({ log }, [HOST, AMY]);
    const service = team.t.ctx.services.inbox;
    const from = principal(team, HOST).actor;
    expect(service.addMention({ userId: AMY, from, target: { kind: 'session', sessionId: 'not an id' }, excerpt: 'x' })).toBe('stored');
    expect(service.addMention({ userId: AMY, from, target: { kind: 'session', sessionId: 'sess_a' }, anchor: { seq: 0 }, excerpt: 'x' })).toBe('stored');
    service.addResult({ userId: AMY, from, suggestionId: 'not an id', sessionId: 'sess_a', outcome: 'rejected', excerpt: 'x' });
    expect(inbox(team, AMY)).toEqual([]);
    expect(log.lines.filter((line) => line.level === 'error' && line.fields['module'] === 'inbox').map((line) => line.fields['issue'])).toEqual(['target.sessionId', 'anchor.seq', 'suggestionId']);
    // The next valid one is stored as usual.
    expect(service.addMention({ userId: AMY, from, target: { kind: 'session', sessionId: 'sess_a' }, anchor: { seq: 3 }, excerpt: 'x' })).toBe('stored');
    expect(inbox(team, AMY)).toMatchObject([{ kind: 'mention', anchor: { seq: 3 } }]);
  });

  it('a fact that would not be a valid item is left out and reported once; the rest of the inbox is there', async () => {
    const log = createMemoryLogger();
    const team = await setup({ log }, [HOST]);
    const at = team.t.ctx.clock.now();
    const good: AttentionFact = { subject: 'storage', id: 'workspace', at, recipients: [HOST], target: { kind: 'console', section: 'sessions' }, excerpt: '' };
    const bad = { subject: 'account', id: 'workspace', at, recipients: [HOST], target: { kind: 'console', section: 'agents' }, excerpt: '' } as unknown as AttentionFact;
    team.fakes.topics.setAttention([bad, good]);
    expect(inbox(team, HOST).map((item) => item.key)).toEqual(['attention:storage:workspace']);
    team.fakes.worktrees.putRequest(buildMergeRequest({ id: 'mr_1' }));
    expect(inbox(team, HOST).map((item) => item.key)).toEqual(['attention:storage:workspace', 'merge:mr_1']);
    const warnings = log.lines.filter((line) => line.level === 'warn' && line.fields['module'] === 'inbox');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ kind: 'attention', issue: 'target.section' });
    await waitFor(() => told(team, HOST, 'merge:mr_1').includes('upsert'), { what: 'the valid items over the wire' });
    expect(told(team, HOST, 'attention:account:workspace')).toEqual([]);
  });

  it('a renamed member is named anew in the items that name them', async () => {
    const team = await setup({}, [HOST, MEI, KEN]);
    const session = await freeSession(team, null);
    const request = team.fakes.conversation.request({ sessionId: session.id });
    expect(itemOf(team, HOST, `permission:${request.id}`).alsoFor).toEqual([{ userId: MEI, displayName: 'Mei' }, { userId: KEN, displayName: 'Ken' }]);
    // The relay says Ken has a new name the next time one of his devices is admitted.
    await team.t.connect({ userId: KEN, displayName: 'Kenneth', inviteUrl: team.t.createInvite('agent') });
    await waitFor(() => itemOf(team, HOST, `permission:${request.id}`).alsoFor?.[1]?.displayName === 'Kenneth', { what: 'the new name in the item' });
  });
});
