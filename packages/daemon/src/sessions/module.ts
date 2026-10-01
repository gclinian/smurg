// Feature module of src/sessions/ (ARCHITECTURE §7.2, §7.6): PTY sessions (session.*, exec.*), login detection,
// killTree (R4, R2 kick, R11). Slot: `sessions` (SessionManager).
//
// create() builds the service only; start() prepares its directories and ends what a run that died hard left behind
// (it must succeed in every harness: fake home, temp state dir, no real claude, no selfCommand: sessions that cannot
// start are refused when they are requested, never at daemon start); stop() ends every session.
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { toDisposable } from '../core/lifecycle.ts';
import { registerSessionHandlers } from './handlers.ts';
import { SessionManagerImpl, type SessionsModuleOptions } from './session-manager.ts';

/** A sessions module with test seams (fake claude, host environment, process table). Production uses sessionsModule. */
export function createSessionsModule(options: SessionsModuleOptions = {}): FeatureModule {
  const managers = new WeakMap<DaemonContext, SessionManagerImpl>();
  const managerOf = (ctx: DaemonContext): SessionManagerImpl | null => managers.get(ctx) ?? null;
  return {
    name: 'sessions',
    create: (ctx) => {
      const manager = new SessionManagerImpl(ctx, options);
      managers.set(ctx, manager);
      return { sessions: manager };
    },
    register: (router, ctx) => {
      const manager = managerOf(ctx);
      if (!manager) return toDisposable(() => {});
      return registerSessionHandlers(router, ctx, manager);
    },
    start: async (ctx) => {
      await managerOf(ctx)?.start();
    },
    stop: async (ctx) => {
      const manager = managerOf(ctx);
      if (!manager) return;
      try {
        await manager.stopAll();
      } catch (err) {
        ctx.log.error('sessions stop failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const sessionsModule: FeatureModule = createSessionsModule();
