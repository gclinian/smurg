// Feature module of src/conversation/ (ARCHITECTURE §7.2, §5.9): messages to agents, questions, votes, comments,
// permission decisions, cards. Slot: `conversation` (ConversationService).
//
// In DEFAULT_FEATURE_MODULES it comes after `sessions` (its start() asks the agent runtime which sessions still exist
// and where their cards are) and before `suggest`, `topics` and `inbox`; stopping runs backwards, so it stops before
// the agent runtime does.
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { DisposableStack, toDisposable } from '../core/lifecycle.ts';
import { cardsIndexDocument } from './cards-store.ts';
import { ConversationServiceImpl, type ConversationModuleOptions } from './conversation-service.ts';
import { registerConversationHandlers } from './handlers.ts';

/** A conversation module with seams (card limits, the audit window). Production uses conversationModule. */
export function createConversationModule(options: ConversationModuleOptions = {}): FeatureModule {
  const services = new WeakMap<DaemonContext, ConversationServiceImpl>();
  return {
    name: 'conversation',
    documents: [cardsIndexDocument],
    create: (ctx) => {
      const service = new ConversationServiceImpl(ctx, options);
      services.set(ctx, service);
      return { conversation: service };
    },
    register: (router, ctx) => {
      const service = services.get(ctx);
      if (!service) return toDisposable(() => {});
      const stack = new DisposableStack();
      stack.add(registerConversationHandlers(router, ctx, service));
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
        ctx.log.error('conversation stop failed', { module: 'conversation', error: err instanceof Error ? err.name : 'unknown' });
      }
    },
  };
}

export const conversationModule: FeatureModule = createConversationModule();
