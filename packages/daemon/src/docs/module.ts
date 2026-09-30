// Feature module of src/docs/ (ARCHITECTURE §7.2, §7.5): Yjs documents (doc.*), autosave, disk → Yjs reconciliation
// and the conflict panel (SPEC R7, R8, D13). Fills the `docs` slot (DocService).
//
// State is per daemon (a WeakMap keyed by the DaemonContext), because tests run several daemons with the same
// module object in one process. start() opens conflicts.json; stop() writes every dirty document (the file watcher
// is still running then: DEFAULT_FEATURE_MODULES stops docs before files) and ends the compute worker.
import type { DaemonContext, FeatureModule } from '../core/context.ts';
import { DisposableStack } from '../core/lifecycle.ts';
import { DocServiceImpl, type DocServiceOptions } from './doc-service.ts';
import { registerDocHandlers } from './handlers.ts';

export function createDocsModule(options: DocServiceOptions = {}): FeatureModule {
  const services = new WeakMap<DaemonContext, DocServiceImpl>();
  const serviceOf = (ctx: DaemonContext): DocServiceImpl => {
    const service = services.get(ctx);
    if (!service) throw new Error('docs module used before create()');
    return service;
  };
  return {
    name: 'docs',
    create: (ctx) => {
      const service = new DocServiceImpl(ctx, options);
      services.set(ctx, service);
      return { docs: service };
    },
    register: (router, ctx) => {
      const service = serviceOf(ctx);
      const stack = new DisposableStack();
      stack.add(registerDocHandlers(router, service));
      stack.add(service.listen());
      return stack;
    },
    start: (ctx) => serviceOf(ctx).start(),
    stop: async (ctx) => {
      const service = services.get(ctx);
      if (service) await service.stop();
    },
  };
}

export const docsModule: FeatureModule = createDocsModule();
