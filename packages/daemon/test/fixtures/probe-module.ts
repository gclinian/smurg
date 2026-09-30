// A feature module that registers a probe handler for every client message type nobody else handles. A request that
// reaches a probe is answered with `conflict` / detail.reason 'probe-reached', so a test can tell "the router let it
// through" (probe) from "the router refused it" (forbidden) without any feature being built.
import { MESSAGE_REGISTRY, MESSAGE_TYPES, SmurgError, type RequestType } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import type { InboundNotifyType } from '../../src/core/interfaces.ts';
import { DisposableStack } from '../../src/core/lifecycle.ts';

export interface ProbeHit {
  readonly type: string;
  readonly userId: string;
  readonly role: string;
  readonly payload: unknown;
}

export interface Probe {
  readonly module: FeatureModule;
  readonly hits: ProbeHit[];
  count(type: string, userId?: string): number;
  /** Handlers that answer for real instead of the probe error. */
  readonly overrides: Map<string, (payload: unknown, userId: string) => unknown>;
}

export function createProbe(): Probe {
  const hits: ProbeHit[] = [];
  const overrides = new Map<string, (payload: unknown, userId: string) => unknown>();
  const module: FeatureModule = {
    name: 'probe',
    register(router) {
      const stack = new DisposableStack();
      for (const type of MESSAGE_TYPES) {
        const spec = MESSAGE_REGISTRY[type];
        if (spec.dir === 'd2c' || type === 'channel.ack' || router.has(type)) continue;
        if (spec.result !== null) {
          stack.add(
            router.handle(type as RequestType, (payload, ctx) => {
              hits.push({ type, userId: ctx.userId, role: ctx.role, payload });
              const override = overrides.get(type);
              if (override) return override(payload, ctx.userId) as never;
              throw new SmurgError('conflict', 'probe', { reason: 'probe-reached' });
            }),
          );
        } else {
          stack.add(
            router.on(type as InboundNotifyType, (payload, ctx) => {
              hits.push({ type, userId: ctx.userId, role: ctx.role, payload });
            }),
          );
        }
      }
      return stack;
    },
  };
  return {
    module,
    hits,
    overrides,
    count: (type, userId) => hits.filter((h) => h.type === type && (userId === undefined || h.userId === userId)).length,
  };
}
