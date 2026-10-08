// Feature module of src/suggest/ (ARCHITECTURE §7.2, §5.6): the suggestion queue (suggest.*): create, edit, withdraw,
// accept, reject (SPEC R6, D2). Slot: `suggestions` (SuggestionService).
//
// It comes after `sessions` and `conversation` in DEFAULT_FEATURE_MODULES: start() asks the registry which agent
// sessions still exist (they survive a restart of the daemon as idle sessions) to close the suggestions whose session
// is gone, and the session.exited listener sees every session end. It imports one pure helper of the conversation
// module, the mention rule (conversation/mentions.ts); everything else between the two goes through the services.
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { DisposableStack, toDisposable } from '../core/lifecycle.ts';
import { registerSuggestionHandlers } from './handlers.ts';
import { suggestionsDocument } from './store.ts';
import { SuggestionServiceImpl, type SuggestionModuleOptions } from './suggestion-service.ts';

/** A suggest module with seams (limits). Production uses suggestModule. */
export function createSuggestModule(options: SuggestionModuleOptions = {}): FeatureModule {
  const services = new WeakMap<DaemonContext, SuggestionServiceImpl>();
  return {
    name: 'suggest',
    documents: [suggestionsDocument],
    create: (ctx) => {
      const service = new SuggestionServiceImpl(ctx, options);
      services.set(ctx, service);
      return { suggestions: service };
    },
    register: (router, ctx) => {
      const service = services.get(ctx);
      if (!service) return toDisposable(() => {});
      const stack = new DisposableStack();
      stack.add(registerSuggestionHandlers(router, ctx, service));
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
        ctx.log.error('suggest stop failed', { module: 'suggest', error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const suggestModule: FeatureModule = createSuggestModule();
