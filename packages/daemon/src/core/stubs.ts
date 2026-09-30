// Stubs for feature services no module provides yet: every method throws SmurgError('internal',
// "not implemented: <Service>"), so the daemon composes and runs today and a client calling an unfinished feature gets
// a clean error instead of a crash. A Proxy covers every method of the interface, including ones added later.
import { notImplemented } from './errors.ts';
import { FEATURE_SERVICE_LABELS, type FeatureServiceName, type FeatureServices } from './interfaces.ts';

const STUB_MARKER = Symbol.for('smurg.daemon.stub');

export function createStubService<K extends FeatureServiceName>(name: K): FeatureServices[K] {
  const label = FEATURE_SERVICE_LABELS[name];
  const target = Object.freeze({ [STUB_MARKER]: label });
  return new Proxy(target, {
    get(obj, property) {
      if (property === STUB_MARKER) return label;
      // Not a thenable, not JSON, not a primitive: awaiting or logging a stub must not call into it.
      if (property === 'then' || property === 'toJSON' || typeof property === 'symbol') return undefined;
      if (property === 'toString') return () => `[stub ${label}]`;
      return () => {
        throw notImplemented(label);
      };
    },
    has: (_obj, property) => property === STUB_MARKER,
  }) as unknown as FeatureServices[K];
}

export function isStubService(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[STUB_MARKER] !== undefined;
}
