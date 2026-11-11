// Feature module of src/sticky/ (ARCHITECTURE §7.2, §5.12; DESIGN 0.8.0 D2.1): everything of the sticky notes on the
// host: the index of `notes/` (index.ts), new notes, the one Claude for the sticky notes, the feedback on the notes
// (feedback.ts; its one send to an agent is accept.ts), the Slack and Discord channels the host connected
// (sources/: read from this computer once a minute, their messages become feedback) and `sticky.json` (store.ts). Its
// bus listeners (service.ts attach) follow the files of `notes/` and withdraw the waiting feedback of a member who is
// kicked or leaves. Slot: none (no other module calls it: its handlers, its bus listeners and the sources' timer are
// its only callers, like local/module.ts). What `smurg host` connected comes through `ctx.outside` (DaemonOptions).
//
// Order (src/daemon.ts): after topics, before inbox. Its start() lists `notes/` through PathGuard (the core) and
// opens its document; its handlers call the file service and the agent runtime lazily, so files, sessions and
// conversation are up before it and still up while it stops.
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { DisposableStack, toDisposable } from '../core/lifecycle.ts';
import { registerStickyHandlers } from './handlers.ts';
import { StickyServiceImpl, type StickyModuleOptions } from './service.ts';
import { stickyDocument } from './store.ts';

export interface StickyModule extends FeatureModule {
  /** The service of a daemon composed with this module (tests read the index through it). */
  serviceOf(ctx: DaemonContext): StickyServiceImpl | null;
}

/** A sticky module with seams (the index's quiet period). Production uses stickyModule. */
export function createStickyModule(options: StickyModuleOptions = {}): StickyModule {
  const services = new WeakMap<DaemonContext, StickyServiceImpl>();
  return {
    name: 'sticky',
    documents: [stickyDocument],
    create: (ctx) => {
      services.set(ctx, new StickyServiceImpl(ctx, options));
      return {};
    },
    register: (router, ctx) => {
      const service = services.get(ctx);
      if (!service) return toDisposable(() => {});
      const stack = new DisposableStack();
      stack.add(registerStickyHandlers(router, service));
      stack.add(service.attach());
      return stack;
    },
    start: async (ctx) => {
      await services.get(ctx)?.start();
    },
    stop: async (ctx) => {
      try {
        await services.get(ctx)?.stop();
      } catch (err) {
        ctx.log.error('sticky stop failed', { module: 'sticky', error: err instanceof Error ? err.name : 'unknown' });
      }
    },
    serviceOf: (ctx) => services.get(ctx) ?? null,
  };
}

export const stickyModule: StickyModule = createStickyModule();
