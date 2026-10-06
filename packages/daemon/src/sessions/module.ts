// Feature module of src/sessions/ (ARCHITECTURE §7.2, §7.6): the registry of sessions of both kinds (session.*,
// exec.*), terminals (PTYs), the agent runtime (Claude Code in structured mode), the trust gate for project-level
// Claude Code settings, the host's own allow rules, login detection, killTree (R4, R2 kick, R11).
// Slots: `sessions` (SessionManager), `agents` (AgentSessions), `projectTrust` (ProjectTrust), `hostRules` (HostRules).
//
// create() builds the services only; start() prepares their directories, ends what a run that died hard left behind
// and loads the agent session records as idle sessions (it must succeed in every harness: fake home, temp state dir,
// no real claude, no selfCommand: sessions that cannot start are refused when they are requested, never at daemon
// start); stop() ends every terminal and every agent process (the agent session records stay).
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { DisposableStack, toDisposable } from '../core/lifecycle.ts';
import { AgentSessionsImpl } from './agent/agent-sessions.ts';
import { HostRulesImpl } from './agent/host-rules.ts';
import { ProjectTrustImpl } from './agent/project-settings.ts';
import { registerSessionHandlers } from './handlers.ts';
import { SessionManagerImpl, type SessionsModuleOptions } from './session-manager.ts';

interface Parts {
  readonly manager: SessionManagerImpl;
  readonly agents: AgentSessionsImpl;
  readonly trust: ProjectTrustImpl;
  readonly hostRules: HostRulesImpl;
}

/** A sessions module with test seams (a stand-in claude, host environment, process table). Production uses sessionsModule. */
export function createSessionsModule(options: SessionsModuleOptions = {}): FeatureModule {
  const parts = new WeakMap<DaemonContext, Parts>();
  return {
    name: 'sessions',
    create: (ctx) => {
      const manager = new SessionManagerImpl(ctx, options);
      const trust = new ProjectTrustImpl(ctx);
      const hostRules = new HostRulesImpl(ctx);
      const agents = new AgentSessionsImpl(ctx, { ...manager.agentDeps(), trust, hostRules });
      manager.attachAgents(agents);
      // What a change of a root's project settings does to the sessions that run there.
      trust.setReactions({
        filesChanged: (root) => void agents.parkRoot(root, 'project-settings-changed').catch(() => {}),
        decided: (root) => void agents.restartRoot(root, 'project-settings').catch(() => {}),
      });
      parts.set(ctx, { manager, agents, trust, hostRules });
      return { sessions: manager, agents, projectTrust: trust, hostRules };
    },
    register: (router, ctx) => {
      const mine = parts.get(ctx);
      if (!mine) return toDisposable(() => {});
      const stack = new DisposableStack();
      stack.add(registerSessionHandlers(router, ctx, mine.manager, mine.agents));
      stack.add(mine.trust.register());
      return stack;
    },
    start: async (ctx) => {
      const mine = parts.get(ctx);
      if (!mine) return;
      await mine.manager.start();
      await mine.hostRules.start();
      await mine.trust.start();
      await mine.agents.open();
    },
    stop: async (ctx) => {
      const mine = parts.get(ctx);
      if (!mine) return;
      try {
        await mine.manager.stopAll();
      } catch (err) {
        ctx.log.error('sessions stop failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const sessionsModule: FeatureModule = createSessionsModule();
