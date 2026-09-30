// Feature module of src/sandbox/ (ARCHITECTURE §7.2, §7.6 "Sandbox"): the srt wrapper, preflight and profile
// hardening for guest processes (R5). Slot: `sandbox` (SandboxService).
//
// Nothing happens at daemon start: srt is loaded and initialized on the first preflight() / wrap(), so a daemon on a
// machine without a working sandbox still starts (hosts can work; guest sessions are refused, fail closed). stop()
// shuts srt's proxies down; it runs after the sessions module stopped every guest process (module order, daemon.ts).
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { toDisposable } from '../core/lifecycle.ts';
import { SandboxServiceImpl, type SandboxServiceOptions } from './service.ts';

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A sandbox module with injected seams (tests: a missing launcher, a fake srt, another platform). */
export function createSandboxModule(options: SandboxServiceOptions = {}): FeatureModule {
  // One module object can serve several daemons in one process (tests): per-daemon state is keyed by the context.
  const services = new WeakMap<DaemonContext, SandboxServiceImpl>();
  return {
    name: 'sandbox',
    create: (ctx) => {
      const service = new SandboxServiceImpl(ctx, options);
      services.set(ctx, service);
      return { sandbox: service };
    },
    register: (_router, ctx) => {
      // settings.changed → the live network allow-list of every running guest (updateConfig with the WHOLE config).
      const subscription = ctx.bus.on('settings.changed', ({ settings, previous }) => {
        if (sameList(settings.allowedDomains, previous.allowedDomains)) return;
        const service = services.get(ctx);
        if (service === undefined) return;
        service.setAllowedDomains(settings.allowedDomains).catch(() => {
          // already logged by the service; the runtime refuses further wraps
        });
      });
      return toDisposable(() => subscription.dispose());
    },
    stop: async (ctx) => {
      await services.get(ctx)?.dispose();
    },
  };
}

export const sandboxModule: FeatureModule = createSandboxModule();
