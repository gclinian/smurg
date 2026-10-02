// Shared plumbing of the per-area workspace stores (src/lib/stores/*.ts).
//
// Life of a store (driven by createWorkspaceStores, stores/index.ts):
//   1. bind(): register event listeners on the connection, BEFORE it starts (events may arrive with the Welcome);
//   2. every non-resumed Welcome (always the first one): reset() then load(): drop what came from the old logical
//      channel and fetch a fresh snapshot (ARCHITECTURE §4 "Resume": resumed = false ⇒ full resync);
//   3. a resumed Welcome changes nothing: the daemon replays the missed events;
//   4. a role change (new Welcome or channel.memberUpdated) calls onRoleChange().
//
// Ordering: the channel is ordered, so an event that arrives before a list response is already reflected in it, and a
// later one arrives after it. A snapshot therefore REPLACES the state, and events are applied to whatever is there.
// A response that belongs to an older generation (the channel was re-established meanwhile) is dropped.
import type { Role } from '@smurg/protocol';
import { describeError } from '../errors.ts';
import type { WorkspaceConnection } from '../connection/types.ts';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The loading part of a store's state. */
export interface Loadable {
  readonly status: LoadStatus;
  /** A sentence in the language of the moment it was made, when status is 'error'. */
  readonly error: string | null;
}

export const IDLE: Loadable = Object.freeze({ status: 'idle', error: null });

/** setTimeout abstraction so tests control coalescing delays. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realScheduler: Scheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type AreaName =
  | 'workspace'
  | 'presence'
  | 'files'
  | 'locks'
  | 'docs'
  | 'sessions'
  | 'suggestions'
  | 'activity'
  | 'conflicts'
  | 'worktrees'
  | 'admin'
  | 'transfers';

export interface StoreContext {
  readonly conn: WorkspaceConnection;
  /** The member's current role; null before the first Welcome. */
  role(): Role | null;
  /** The id of the member's own user; null before the first Welcome. */
  userId(): string | null;
  /** Increments with every non-resumed Welcome. */
  generation(): number;
  readonly scheduler: Scheduler;
  /** Background failures (a failed load is also kept in the store's own `error`). */
  reportError(area: AreaName, error: unknown): void;
}

/** What createWorkspaceStores drives; features never call these. */
export interface AreaLifecycle {
  bind(ctx: StoreContext): () => void;
  reset(): void;
  load(): Promise<void>;
  onRoleChange?(role: Role, previous: Role | null): void;
  dispose?(): void;
}

/**
 * Runs `fetch` and hands its value to `apply` only if the logical channel is still the one it was asked on.
 * Returns false when the result was dropped.
 */
export async function withGeneration<T>(ctx: StoreContext, fetch: () => Promise<T>, apply: (value: T) => void): Promise<boolean> {
  const generation = ctx.generation();
  const value = await fetch();
  if (ctx.generation() !== generation) return false;
  apply(value);
  return true;
}

/**
 * The standard snapshot load: marks the store loading, fetches, and applies the result — unless the logical channel
 * changed meanwhile (then both the result and a failure are dropped: the newer load owns the store). A failure on the
 * current channel is kept as the store's `error` and rethrown (the coordinator reports it).
 */
export async function loadSnapshot<T>(ctx: StoreContext, setLoadable: (loadable: Loadable) => void, fetch: () => Promise<T>, apply: (value: T) => void): Promise<void> {
  const generation = ctx.generation();
  setLoadable(loadingState());
  let value: T;
  try {
    value = await fetch();
  } catch (error) {
    if (ctx.generation() !== generation) return;
    setLoadable(errorState(error));
    throw error;
  }
  if (ctx.generation() !== generation) return;
  apply(value);
}

export function loadingState(): Loadable {
  return { status: 'loading', error: null };
}

export function readyState(): Loadable {
  return { status: 'ready', error: null };
}

export function errorState(error: unknown): Loadable {
  return { status: 'error', error: describeError(error) };
}

/** Upsert into an immutable Map (returns a new Map). */
export function mapWith<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

export function mapWithout<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

export function mapFrom<K, V>(items: readonly V[], key: (item: V) => K): Map<K, V> {
  const map = new Map<K, V>();
  for (const item of items) map.set(key(item), item);
  return map;
}
