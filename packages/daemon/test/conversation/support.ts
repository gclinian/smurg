// TEST ONLY: a test daemon with the REAL conversation and suggest modules and fakes for everything else (the agent
// runtime, topics, the inbox, …), four members over real connections, and the small helpers the suites share.
//
//   const s = await startStack();
//   const session = await openSession(s, 'mei');
//   s.fakes.agents.raise(session.id, questionRequest('q1'));         // what Claude Code would do
//   await s.amy.conn.request('question.vote', { questionId: 'q1', part: 0, options: [0] });
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { AgentSession, AuditEntry, HostSettings, PayloadOf, ResultOf, Role, SmurgError } from '@smurg/protocol';
import type { InteractiveEventType } from '@smurg/protocol/client';
import type { AgentsConfig } from '../../src/core/config.ts';
import type { DaemonContext, FeatureModule } from '../../src/core/context.ts';
import { fakePrincipal, fakesModule, fakesOf, type Fakes } from '../../src/core/fakes/index.ts';
import type { AgentRequest, AgentStartInput, Principal } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import type { ConversationModuleOptions, ConversationServiceImpl } from '../../src/conversation/conversation-service.ts';
import { createConversationModule } from '../../src/conversation/module.ts';
import { createSuggestModule } from '../../src/suggest/module.ts';
import type { SuggestionModuleOptions, SuggestionServiceImpl } from '../../src/suggest/suggestion-service.ts';
import { TEST_HOST_USER, createTestDaemon, settle, waitFor, type TestClient, type TestDaemon, type TestDaemonOptions } from '../../src/testing/index.ts';

export const HOST = TEST_HOST_USER;
export const MEI = 'dev:mei';
export const AMY = 'dev:amy';
export const LEO = 'dev:leo';

export interface Stack {
  readonly t: TestDaemon;
  readonly fakes: Fakes;
  readonly service: ConversationServiceImpl;
  readonly suggestions: SuggestionServiceImpl;
  /** Ian, the host. */
  readonly host: TestClient;
  /** Mei, Agent access. */
  readonly mei: TestClient;
  /** Amy, an Editor. */
  readonly amy: TestClient;
  /** Leo, a Viewer. */
  readonly leo: TestClient;
}

export interface StackOptions {
  /** Modules composed BEFORE the fakes (the real locks module, a seeding module, …). */
  readonly before?: readonly FeatureModule[];
  readonly conversation?: ConversationModuleOptions;
  readonly suggest?: SuggestionModuleOptions;
  readonly agents?: Partial<AgentsConfig>;
  readonly settings?: Partial<HostSettings>;
  readonly project?: TestDaemonOptions['project'];
  /**
   * Runs when the daemon starts, after the fakes exist and BEFORE the conversation module starts: what the agent
   * runtime would already know then (the sessions that survived a restart).
   */
  readonly seed?: (fakes: Fakes, ctx: DaemonContext) => void | Promise<void>;
  /** An existing state dir (a restart keeps the same one). */
  readonly stateDir?: string;
  readonly root?: string;
  readonly workspaceId?: string;
}

const running: TestDaemon[] = [];

/** Every stack a test started is cleaned up after it. */
afterEach(async () => {
  for (const t of running.splice(0)) await t.cleanup();
}, 60_000);

/** The modules of a stack: [...before, fakes for the rest (with their handlers), conversation, suggest]. */
export function stackModules(options: StackOptions = {}): FeatureModule[] {
  const seed: FeatureModule = {
    name: 'test-seed',
    register: () => toDisposable(() => {}),
    start: async (ctx) => {
      const fakes = fakesOf(ctx);
      // Where the (fake) agent runtime keeps a session's private directory: cards.json goes there.
      fakes.agents.storageRoot = transcriptsDir(ctx);
      await options.seed?.(fakes, ctx);
    },
  };
  return [...(options.before ?? []), fakesModule({ except: ['conversation', 'suggestions'], handlers: true }), seed, createConversationModule(options.conversation), createSuggestModule(options.suggest)];
}

/** The directory the fake runtime's `storageDir(sessionId)` lives under (stable across a restart with the same state dir). */
export function transcriptsDir(ctx: DaemonContext): string {
  return join(ctx.state.dir, 'transcripts');
}

/** Where a session's cards.json is. */
export function cardsFile(ctx: DaemonContext, sessionId: string): string {
  return join(transcriptsDir(ctx), Buffer.from(sessionId, 'utf8').toString('hex'), 'cards.json');
}

export async function startDaemon(options: StackOptions = {}): Promise<{ t: TestDaemon; fakes: Fakes }> {
  const t = await createTestDaemon({
    modules: stackModules(options),
    // The sweep runs often; nothing escalates by itself unless a test moves the clock.
    agents: { escalationSweepMs: 15, ...options.agents },
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  });
  running.push(t);
  return { t, fakes: fakesOf(t.ctx) };
}

/** Host (Ian), Mei (Agent access), Amy (Editor), Leo (Viewer), all connected. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const { t, fakes } = await startDaemon(options);
  const host = await t.connectHost();
  const mei = await t.connect({ userId: MEI, displayName: 'Mei', role: 'agent' });
  const amy = await t.connect({ userId: AMY, displayName: 'Amy', role: 'editor' });
  const leo = await t.connect({ userId: LEO, displayName: 'Leo', role: 'viewer' });
  return { t, fakes, service: t.ctx.services.conversation as ConversationServiceImpl, suggestions: t.ctx.services.suggestions as SuggestionServiceImpl, host, mei, amy, leo };
}

export function principalOf(s: Pick<Stack, 't'>, userId: string): Principal {
  const principal = s.t.ctx.members.principalOf(userId);
  if (principal === null) throw new Error(`${userId} is not an active member`);
  return principal;
}

const ROLES: Readonly<Record<string, Role>> = { [HOST]: 'host', [MEI]: 'agent', [AMY]: 'editor', [LEO]: 'viewer' };
const NAMES: Readonly<Record<string, string>> = { [HOST]: 'Host', [MEI]: 'Mei', [AMY]: 'Amy', [LEO]: 'Leo' };

/** An agent session in the fake runtime. Default: a free session in the main workspace, nobody responsible. */
export async function openSession(s: Pick<Stack, 'fakes'>, opener: string = MEI, input: Partial<AgentStartInput> = {}): Promise<AgentSession> {
  return s.fakes.agents.start({
    purpose: 'free',
    openedBy: fakePrincipal(opener, ROLES[opener] ?? 'agent', NAMES[opener]),
    responsible: null,
    workspace: { mode: 'main' },
    mode: 'ask-all',
    rolePrompt: () => 'role prompt',
    ...input,
  });
}

/** A topic's discussion session (the topic is put into the fake topic service). */
export async function openDiscussion(s: Pick<Stack, 'fakes'>, opener: string = MEI, topic = { id: 'tp_checkout', slug: 'checkout', name: 'Checkout' }): Promise<AgentSession> {
  const { buildTopic } = await import('../../src/core/fakes/index.ts');
  const session = await openSession(s, opener, { purpose: 'discussion', topic });
  s.fakes.topics.put(buildTopic({ id: topic.id, slug: topic.slug, name: topic.name, discussionSessionId: session.id }));
  return session;
}

/** A work item's session in its own worktree (`ask-commands`); the worktree comes from the fake worktree manager. */
export async function openItemSession(
  s: Pick<Stack, 'fakes'>,
  opener: string = MEI,
  topic = { id: 'tp_checkout', slug: 'checkout', name: 'Checkout' },
  item: { id: string; number: number; title: string } = { id: 'cart-api', number: 1, title: 'Cart API' },
): Promise<AgentSession> {
  const { buildTopic } = await import('../../src/core/fakes/index.ts');
  if (s.fakes.topics.get(topic.id) === null) s.fakes.topics.put(buildTopic({ id: topic.id, slug: topic.slug, name: topic.name }));
  const owner = fakePrincipal(opener, ROLES[opener] ?? 'agent', NAMES[opener]);
  const handle = await s.fakes.worktrees.acquireForItem({ topic, itemId: item.id, owner });
  return openSession(s, opener, { purpose: 'item', topic, item: { ...item, attempt: 1 }, workspace: { mode: 'worktree', worktreeId: handle.worktree.id }, mode: 'ask-commands' });
}

export async function watch(client: TestClient, sessionId: string): Promise<ResultOf<'session.watch'>> {
  return client.conn.request('session.watch', { sessionId });
}

/** Everything a client receives of one type, in order. */
export function collect<T extends InteractiveEventType>(client: TestClient, type: T): PayloadOf<T>[] {
  const seen: PayloadOf<T>[] = [];
  client.conn.on(type, (payload) => {
    seen.push(payload as PayloadOf<T>);
  });
  return seen;
}

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

export async function auditOf(s: Pick<Stack, 't'>, action: string): Promise<AuditEntry[]> {
  await settle(2);
  const entries = await s.t.ctx.audit.query({ limit: 500 });
  return entries.filter((entry) => entry.action === action).reverse();
}

/** "Where is the cart kept?" (single-select) and "Which checks run?" (multi-select). */
export const PARTS = [
  {
    header: 'Cart',
    text: 'Where is the cart kept?',
    multi: false,
    options: [
      { label: 'On the server', description: 'Survives a reload.' },
      { label: 'In the browser', description: 'Simpler.' },
    ],
  },
  {
    header: 'Checks',
    text: 'Which checks run before a merge?',
    multi: true,
    options: [
      { label: 'Unit tests', description: '' },
      { label: 'Type check', description: '' },
      { label: 'Lint, format', description: 'One label with a comma.' },
    ],
  },
];

export function questionRequest(id: string, parts = PARTS): Extract<AgentRequest, { kind: 'question' }> {
  return { id, kind: 'question', toolUseId: `tu_${id}`, parts };
}

type PermissionAgentRequest = Extract<AgentRequest, { kind: 'permission' }>;

/** A Bash command that asks, with Claude Code's suggested rule when given. */
export function bashRequest(id: string, command: string, extra: Partial<PermissionAgentRequest> = {}): PermissionAgentRequest {
  return { id, kind: 'permission', toolUseId: `tu_${id}`, tool: 'Bash', view: { name: 'Bash', verb: 'run', target: command }, input: { command }, ...extra };
}

/** An Edit of a file inside the main root. */
export function editRequest(id: string, path: string, edit: NonNullable<PermissionAgentRequest['edit']>, extra: Partial<PermissionAgentRequest> = {}): PermissionAgentRequest {
  return {
    id,
    kind: 'permission',
    toolUseId: `tu_${id}`,
    tool: 'Edit',
    view: { name: 'Edit', verb: 'edit', target: path, file: { root: { kind: 'main' }, path } },
    edit,
    input: { file_path: path },
    ...extra,
  };
}

/** Waits until the conversation module has nothing in flight (cards being built, files being written). */
export async function quiet(s: Pick<Stack, 'service'>): Promise<void> {
  await settle(3);
  await s.service.settled();
  await settle(3);
}

export { settle, waitFor };
