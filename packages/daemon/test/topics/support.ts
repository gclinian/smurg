// Shared by the tests of the topics module: a real test daemon (router, hub, audit log, member directory, state
// store, SDK clients) with the REAL topics module and fakes for every other protocol 4 service (agents, conversation,
// suggestions, worktrees, inbox, …). Tests drive what Claude Code and the other modules would do through the fakes
// and read what the topics module asked of them.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAIN_ROOT, topicPlanPath, topicReportPath, topicSpecPath, type AgentSession, type AuditEntry, type ConversationEvent, type HostSettings, type PlanInfo, type Topic } from '@smurg/protocol';
import type { AgentsConfig } from '../../src/core/config.ts';
import { fakePrincipal, fakesModule, fakesOf, type Fakes } from '../../src/core/fakes/index.ts';
import type { OutboundMessage, Principal } from '../../src/core/interfaces.ts';
import { TEST_HOST_NAME, TEST_HOST_USER, createTestDaemon, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { createTopicsModule, type TopicsModuleOptions } from '../../src/topics/module.ts';
import { PLAN_MARKER_END, PLAN_MARKER_START } from '../../src/topics/plan-format.ts';

export const HOST: Principal = fakePrincipal(TEST_HOST_USER, 'host', TEST_HOST_NAME);

export interface TopicsTest {
  readonly t: TestDaemon;
  readonly fakes: Fakes;
  /** Ian, the host. */
  readonly host: TestClient;
  /** Mei, Agent access. */
  readonly mei: TestClient;
  /** Amy, an Editor. */
  readonly amy: TestClient;
  readonly principals: { readonly host: Principal; readonly mei: Principal; readonly amy: Principal };
  /** Writes a file of the main workspace and tells the daemon it changed (what the watcher would do). */
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** The topic as the daemon holds it now. */
  topic(topicId: string): Topic;
  plan(topicId: string): PlanInfo;
  /** Audit entries of one action, oldest first. */
  audit(action: string): Promise<AuditEntry[]>;
  cleanup(): Promise<void>;
}

export interface TopicsTestOptions {
  readonly topics?: TopicsModuleOptions;
  readonly settings?: Partial<HostSettings>;
  readonly agents?: Partial<AgentsConfig>;
  readonly files?: Readonly<Record<string, string>>;
  /** An existing shared folder and state dir (a second daemon over the same state: a restart). */
  readonly root?: string;
  readonly stateDir?: string;
  readonly workspaceId?: string;
  /** Connect Mei and Amy as well (default true). */
  readonly members?: boolean;
}

export async function setupTopics(options: TopicsTestOptions = {}): Promise<TopicsTest> {
  const t = await createTestDaemon({
    modules: [fakesModule({ except: ['topics', 'plans', 'reports'], handlers: true }), createTopicsModule({ fileDebounceMs: 10, ...options.topics })],
    agents: { escalationSweepMs: 20, ...options.agents },
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.root === undefined ? { project: { files: { 'README.md': '# project\n', ...options.files } } } : { root: options.root }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  });
  const fakes = fakesOf(t.ctx);
  const host = await t.connectHost();
  const withMembers = options.members !== false;
  const mei = withMembers ? await t.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' }) : host;
  const amy = withMembers ? await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' }) : host;
  return {
    t,
    fakes,
    host,
    mei,
    amy,
    principals: { host: HOST, mei: fakePrincipal('dev:mei', 'agent', 'Mei'), amy: fakePrincipal('dev:amy', 'editor', 'Amy') },
    write: async (path, text) => {
      const absolute = join(t.root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, text);
      t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path, change: 'change' }] });
    },
    remove: async (path) => {
      await rm(join(t.root, path), { force: true });
      t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path, change: 'unlink' }] });
    },
    topic: (topicId) => {
      const topic = t.ctx.services.topics.get(topicId);
      if (topic === null) throw new Error(`no topic ${topicId}`);
      return topic;
    },
    plan: (topicId) => {
      const plan = t.ctx.services.plans.get(topicId);
      if (plan === null) throw new Error(`no plan for ${topicId}`);
      return plan;
    },
    audit: async (action) => (await t.ctx.audit.query({ limit: 500 })).filter((entry) => entry.action === action).reverse(),
    cleanup: () => t.cleanup(),
  };
}

export interface PlanItemText {
  readonly id: string;
  readonly title?: string;
  readonly dependsOn?: readonly string[];
  readonly size?: 's' | 'm' | 'l';
  readonly touches?: readonly string[];
  readonly summary?: string;
}

/** A PLAN.md with these work items. */
export function planText(items: readonly PlanItemText[], intro = 'The plan.'): string {
  const body = items
    .map((item, index) =>
      [
        `### ${index + 1}. ${item.title ?? item.id}`,
        `- id: ${item.id}`,
        ...(item.dependsOn === undefined ? [] : [`- depends on: ${item.dependsOn.length === 0 ? 'none' : item.dependsOn.join(', ')}`]),
        ...(item.size === undefined ? [] : [`- size: ${item.size}`]),
        ...(item.touches === undefined ? [] : [`- touches: ${item.touches.join(', ')}`]),
        '',
        item.summary ?? `Do ${item.id}.`,
      ].join('\n'),
    )
    .join('\n\n');
  return `# Plan\n\n${intro}\n\n${PLAN_MARKER_START}\n\n${body}\n\n${PLAN_MARKER_END}\n`;
}

export const SPEC_TEXT = '# Spec\n\n## Goal\nA checkout.\n\n## Open questions\nNone.\n';

/** A result report that passes the format, for the item `itemId`. */
export function reportText(itemId: string, options: { readonly outcome?: 'complete' | 'partial' | 'blocked'; readonly done?: string } = {}): string {
  return [
    `# Result report: ${itemId}`,
    '',
    `<!-- smurg:report v1 item=${itemId} -->`,
    `- outcome: ${options.outcome ?? 'complete'}`,
    '',
    '## What was done',
    options.done ?? `Everything of ${itemId}.`,
    '',
    '## Why it was done this way',
    'It was the simplest way.',
    '',
    '## How it was verified',
    '- [x] `pnpm test`: all tests passed',
    ...(options.outcome === undefined || options.outcome === 'complete' ? [] : ['- [ ] Manual check: not verified: no browser in this session']),
    '',
    '## What to watch out for',
    'Nothing special.',
    '',
  ].join('\n');
}

/** Creates a topic as Mei over the wire and returns it with its discussion session. */
export async function createTopic(test: TopicsTest, name = 'Checkout', firstMessage?: string): Promise<{ topic: Topic; session: AgentSession }> {
  return test.mei.conn.request('topic.create', { name, ...(firstMessage === undefined ? {} : { firstMessage }) });
}

/** A topic whose SPEC.md and PLAN.md exist and parse (written as the discussion agent would, without hand edits). */
export async function topicWithPlan(test: TopicsTest, items: readonly PlanItemText[], name = 'Checkout'): Promise<{ topic: Topic; session: AgentSession; plan: PlanInfo }> {
  const { topic, session } = await createTopic(test, name);
  await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
  await test.write(topicPlanPath(topic.slug), planText(items));
  await waitFor(() => test.t.ctx.services.plans.get(topic.id)?.items.length === items.length, { what: 'the plan to be read' });
  return { topic: test.topic(topic.id), session, plan: test.plan(topic.id) };
}

/** Presses Start for a topic as `client` (default Mei): preflight, then start with its pins. */
export async function startPlan(test: TopicsTest, topicId: string, itemIds?: readonly string[], client: TestClient = test.mei): Promise<PlanInfo> {
  const { preflight } = await client.conn.request('plan.preflight', { topicId, ...(itemIds === undefined ? {} : { itemIds: [...itemIds] }) });
  const { plan } = await client.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash, ...(itemIds === undefined ? {} : { itemIds: [...itemIds] }) });
  return plan;
}

/** The item of a plan by id. */
export function itemOf(plan: PlanInfo, itemId: string): PlanInfo['items'][number] {
  const item = plan.items.find((candidate) => candidate.id === itemId);
  if (item === undefined) throw new Error(`no item ${itemId}`);
  return item;
}

/** Writes the report of an item into its worktree (what the agent's Write tool does). */
export async function writeReport(test: TopicsTest, slug: string, itemId: string, worktreeId: string, text: string): Promise<void> {
  const root = test.t.ctx.roots.get({ kind: 'worktree', worktreeId });
  if (root === null) throw new Error(`no worktree root ${worktreeId}`);
  const absolute = join(root.realPath, topicReportPath(slug, itemId));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
}

/** What an item's agent does to hand in a report: writes the file, calls check_report (ok), ends its turn. */
export async function handInReport(test: TopicsTest, slug: string, itemId: string, options: { readonly text?: string; readonly finalText?: string; readonly edit?: boolean } = {}): Promise<void> {
  const hit = test.t.ctx.services.plans.get(topicIdOfSlug(test, slug))?.items.find((item) => item.id === itemId);
  if (hit === undefined || hit.sessionId === undefined || hit.worktreeId === undefined) throw new Error(`item ${itemId} has no session`);
  const text = options.text ?? reportText(itemId);
  await writeReport(test, slug, itemId, hit.worktreeId, text);
  const check = await checkReport(test, hit.sessionId);
  if (!check.ok) throw new Error(`check_report did not pass: ${JSON.stringify(check)}`);
  if (options.edit !== false) test.fakes.agents.edit(hit.sessionId, { root: { kind: 'worktree', worktreeId: hit.worktreeId }, path: topicReportPath(slug, itemId) });
  test.fakes.agents.finishTurn(hit.sessionId, { outcome: 'completed', ...(options.finalText === undefined ? {} : { finalText: options.finalText }) });
}

export function topicIdOfSlug(test: TopicsTest, slug: string): string {
  const topic = [...test.t.ctx.services.topics.list({}).topics, ...test.t.ctx.services.topics.list({ archived: true }).topics].find((candidate) => candidate.slug === slug);
  if (topic === undefined) throw new Error(`no topic with the slug ${slug}`);
  return topic.id;
}

/** `check_report` as the MCP answer path calls it: the asynchronous read first, then the contract's method. */
export async function checkReport(test: TopicsTest, sessionId: string): Promise<ReturnType<TestDaemon['ctx']['services']['reports']['checkReport']>> {
  const facts = test.fakes.agents.facts(sessionId);
  const session = test.fakes.agents.get(sessionId);
  if (facts === null || session === null) throw new Error(`no session ${sessionId}`);
  const topic = facts.topicId === undefined ? null : test.t.ctx.services.topics.get(facts.topicId);
  const context = {
    sessionId,
    purpose: facts.purpose,
    ...(topic === null ? {} : { topic: { id: topic.id, slug: topic.slug } }),
    ...(facts.itemId === undefined ? {} : { itemId: facts.itemId }),
    root: facts.root,
    agent: test.fakes.agents.agentActor(sessionId),
  };
  const reports = test.t.ctx.services.reports as typeof test.t.ctx.services.reports & { prepareCheck(context: unknown): Promise<void> };
  await reports.prepareCheck(context);
  return reports.checkReport(context);
}

/** `check_plan` as the MCP answer path calls it. */
export async function checkPlan(test: TopicsTest, sessionId: string): Promise<ReturnType<TestDaemon['ctx']['services']['plans']['checkPlan']>> {
  const context = mcpContext(test, sessionId);
  const plans = test.t.ctx.services.plans as typeof test.t.ctx.services.plans & { prepareCheck(context: unknown): Promise<void> };
  await plans.prepareCheck(context);
  return plans.checkPlan(context);
}

export function mcpContext(test: TopicsTest, sessionId: string): Parameters<TestDaemon['ctx']['services']['plans']['checkPlan']>[0] {
  const facts = test.fakes.agents.facts(sessionId);
  if (facts === null) throw new Error(`no session ${sessionId}`);
  const topic = facts.topicId === undefined ? null : test.t.ctx.services.topics.get(facts.topicId);
  return {
    sessionId,
    purpose: facts.purpose,
    ...(topic === null ? {} : { topic: { id: topic.id, slug: topic.slug } }),
    ...(facts.itemId === undefined ? {} : { itemId: facts.itemId }),
    root: facts.root,
    agent: test.fakes.agents.agentActor(sessionId),
  };
}

/** The smurg messages a session was sent, by purpose. */
export function smurgSent(test: TopicsTest, sessionId: string): Extract<OutboundMessage, { kind: 'smurg' }>[] {
  return test.fakes.agents.sentTo(sessionId).filter((message): message is Extract<OutboundMessage, { kind: 'smurg' }> => message.kind === 'smurg');
}

/** The catalog ids of a session's system lines and notices, in order. */
export function lineIds(test: TopicsTest, sessionId: string): string[] {
  return test.fakes.agents.eventsOf(sessionId).flatMap((event: ConversationEvent) => (event.kind === 'line' || event.kind === 'notice' ? [event.text.id] : []));
}

export async function readMain(test: TopicsTest, path: string): Promise<string> {
  return readFile(join(test.t.root, path), 'utf8');
}

export { waitFor };
