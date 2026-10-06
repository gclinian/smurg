// Feature module of src/inbox/ (ARCHITECTURE §7.2, §5.11): every member's inbox (inbox.*). Slot: `inbox`
// (InboxService).
//
// It comes after the modules it derives from in the release's module list (… sessions, conversation, suggest, topics,
// inbox, …): its start() takes the first full view once they have loaded their state. It calls them only from its
// methods and listeners, never while it is created (`inbox.json` is opened there, so mentions can be stored from the
// first moment).
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { DisposableStack, toDisposable } from '../core/lifecycle.ts';
import { registerInboxHandlers } from './handlers.ts';
import { InboxServiceImpl } from './inbox-service.ts';

export function createInboxModule(): FeatureModule {
  const services = new WeakMap<DaemonContext, InboxServiceImpl>();
  return {
    name: 'inbox',
    create: async (ctx) => {
      const service = await InboxServiceImpl.open(ctx);
      services.set(ctx, service);
      return { inbox: service };
    },
    register: (router, ctx) => {
      const service = services.get(ctx);
      if (!service) return toDisposable(() => {});
      const stack = new DisposableStack();
      stack.add(registerInboxHandlers(router, ctx, service));
      stack.add(service.attach());
      return stack;
    },
    start: async (ctx) => {
      services.get(ctx)?.start();
    },
    stop: async (ctx) => {
      try {
        await services.get(ctx)?.stop();
      } catch (err) {
        ctx.log.error('inbox stop failed', { module: 'inbox', error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const inboxModule: FeatureModule = createInboxModule();
