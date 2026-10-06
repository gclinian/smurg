// TEST ONLY. In-memory fakes of the services protocol 4 added or changed (ARCHITECTURE §7.2), so every daemon package
// builds and tests against the contracts of core/interfaces.ts without the other packages:
//
//   // THE way to build and test a module: a real test daemon with YOUR module and fakes for everything else
//   const t = await createTestDaemon({ modules: [locksModule, fakesModule({ except: ['conversation'], handlers: true }), conversationModule] });
//   const fakes = fakesOf(t.ctx);
//   fakes.agents.raise(session.id, request);            // drive what Claude Code would do
//   expect(fakes.inbox.mentions).toHaveLength(1);       // read what your module asked of the others
//
//   // the fakes ALONE, without a daemon (their own contract test, pure logic over them); never a module's context
//   const fakes = createFakes(createFakeEnv());
//
// A fake holds the state the real service holds, emits the same bus events and appends the same system lines; it does
// not apply the rules of another package (who may submit, how a plan parses). Never import this from production code.
import type { Actor, FileRef } from '@smurg/protocol';
import type { DaemonContext, FeatureModule } from '../context.ts';
import type { FeatureServiceName, FeatureServices } from '../interfaces.ts';
import { toDisposable } from '../lifecycle.ts';
import { registerFakeHandlers } from './handlers.ts';
import { FakeAgentSessions, FakeHostRules, FakeProjectTrust } from './agents.ts';
import { FakeConversationService, FakeSuggestionService } from './conversation.ts';
import type { FakeEnv } from './env.ts';
import { FakeInboxService } from './inbox.ts';
import { FakeHookServer, FakeSessionManager } from './sessions.ts';
import { FakePlanService, FakeReportService, FakeTopicService } from './topics.ts';
import { FakeWorktreeManager } from './worktrees.ts';

export * from './agents.ts';
export * from './build.ts';
export * from './conversation.ts';
export * from './env.ts';
export * from './inbox.ts';
export * from './sessions.ts';
export * from './topics.ts';
export * from './worktrees.ts';

/** One fake per service slot protocol 4 added or changed, wired to each other the way the real modules are. */
export interface Fakes {
  readonly agents: FakeAgentSessions;
  readonly projectTrust: FakeProjectTrust;
  readonly hostRules: FakeHostRules;
  readonly sessions: FakeSessionManager;
  readonly hooks: FakeHookServer;
  readonly suggestions: FakeSuggestionService;
  readonly conversation: FakeConversationService;
  readonly topics: FakeTopicService;
  readonly plans: FakePlanService;
  readonly reports: FakeReportService;
  readonly inbox: FakeInboxService;
  readonly worktrees: FakeWorktreeManager;
}

export type FakeServiceName = keyof Fakes;
export const FAKE_SERVICE_NAMES: readonly FakeServiceName[] = Object.freeze([
  'agents',
  'projectTrust',
  'hostRules',
  'sessions',
  'hooks',
  'suggestions',
  'conversation',
  'topics',
  'plans',
  'reports',
  'inbox',
  'worktrees',
]);

// Compile-time: every fake fits its slot of FeatureServices.
const _fits = (fakes: Fakes): Pick<FeatureServices, FakeServiceName> => fakes;
void _fits;

/** Builds every fake over one environment (a DaemonContext fits; createFakeEnv() for a test without a daemon). */
export function createFakes(env: FakeEnv): Fakes {
  const agents = new FakeAgentSessions(env);
  const suggestions = new FakeSuggestionService(env, agents);
  const conversation = new FakeConversationService(env, agents, suggestions);
  const plans = new FakePlanService(env);
  const worktrees = new FakeWorktreeManager(env);
  return {
    agents,
    projectTrust: new FakeProjectTrust(env),
    hostRules: new FakeHostRules(env),
    sessions: new FakeSessionManager(env, agents, worktrees),
    hooks: new FakeHookServer(),
    suggestions,
    conversation,
    topics: new FakeTopicService(env, agents, conversation, worktrees),
    plans,
    reports: new FakeReportService(env, conversation, plans),
    inbox: new FakeInboxService(env),
    worktrees,
  };
}

const created = new WeakMap<object, Fakes>();

/**
 * A FeatureModule that fills the protocol 4 service slots with fakes, except the ones `except` names (the slots your
 * own module provides). Put it BEFORE your module in `modules`.
 *
 * Without `handlers` it registers no handler: a request of a faked area is answered "not implemented" unless your
 * module handles it. With `handlers: true` it registers, for every faked slot, the mechanical handlers of that slot's
 * requests and the bus-to-wire forwards (core/fakes/handlers.ts: `sessions` → `session.create` / `list` / `end` /
 * `rename` / `attach`, `exec.*`, `session.state`; `agents` → `session.watch` / `unwatch` / `history` / `cards.get` /
 * `interrupt` / `retry` / `restart` / `responsible.set` / `mode.set` / `rules.get` / `rule.remove` / `host.get`,
 * `session.host`; `conversation` → `session.message.send`, `question.*`, `permission.decide`; `suggestions` →
 * `suggest.*`; `topics` → `topic.*`; `plans` → `plan.*`; `reports` → `report.*`; `inbox` → `inbox.*`), so a member's
 * client can watch a session, list topics and read the inbox over the wire. A slot in `except` gets none of them:
 * its real module registers its own (one handler per type).
 */
export function fakesModule(options: { readonly except?: readonly FeatureServiceName[]; readonly handlers?: boolean } = {}): FeatureModule {
  const except = new Set<string>(options.except ?? []);
  const faked = FAKE_SERVICE_NAMES.filter((name) => !except.has(name));
  return {
    name: 'fakes',
    create: (ctx: DaemonContext) => {
      const fakes = createFakes(ctx);
      created.set(ctx, fakes);
      return Object.fromEntries(faked.map((name) => [name, fakes[name]])) as Partial<FeatureServices>;
    },
    register: (router, ctx) => (options.handlers === true ? registerFakeHandlers(router, ctx, new Set<FeatureServiceName>(faked), fakesOf(ctx).sessions) : toDisposable(() => {})),
  };
}

/** The fakes fakesModule() made for this daemon (also the ones a real module replaced: they are simply unused). */
export function fakesOf(ctx: DaemonContext): Fakes {
  const fakes = created.get(ctx);
  if (!fakes) throw new Error('this daemon was not composed with fakesModule()');
  return fakes;
}

/**
 * What the activity module emits for EVERY entry it records (bus `activity.recorded`): how the topics module learns
 * of a hand edit of SPEC.md / PLAN.md and the worktree module of files a person touched.
 *
 *   recordActivity(t.ctx, { actor: amy.actor, kind: 'human.edit', file: { root: MAIN_ROOT, path: 'specs/checkout/SPEC.md' } });
 *   recordActivity(env, { actor, kind: 'file.rename', file: { root, path: 'specs/checkout/OLD.md' }, renamedFrom: 'specs/checkout/SPEC.md' });
 */
export function recordActivity(env: Pick<FakeEnv, 'bus' | 'clock'>, entry: { readonly actor: Actor; readonly kind: string; readonly file?: FileRef; readonly via?: 'bash'; readonly renamedFrom?: string; readonly at?: number }): void {
  env.bus.emit('activity.recorded', { entry: { ...entry, at: entry.at ?? env.clock.now() } });
}
