// A tiny external store and its React binding. Every piece of shared state in the app (connection state, the
// per-area workspace stores, UI preferences) is one of these, read with useStore(store, selector).
//
// State is immutable: setState always installs a new object, and subscribers are notified synchronously. Selectors
// may derive new objects; useStore memoises on the state identity, so a selector runs again only after a change.
import { useCallback, useRef, useSyncExternalStore } from 'react';

export interface ReadableStore<T> {
  getState(): T;
  /** The listener is called after every change (with no arguments). Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface WritableStore<T> extends ReadableStore<T> {
  setState(next: T | ((previous: T) => T)): void;
}

export function createStore<T>(initial: T): WritableStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(next) {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          // One broken subscriber must not starve the others.
          reportListenerError(error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function reportListenerError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

/** A read-only view (hand out to consumers that must not write). */
export function readonly<T>(store: ReadableStore<T>): ReadableStore<T> {
  return { getState: () => store.getState(), subscribe: (listener) => store.subscribe(listener) };
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.hasOwn(b, key) || !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

const identity = <T,>(value: T): T => value;

/**
 * Subscribes a component to `store`. With a selector, the component re-renders only when the selected value changes
 * (`isEqual`, default Object.is; pass shallowEqual for selectors that build arrays or objects).
 */
export function useStore<T>(store: ReadableStore<T>): T;
export function useStore<T, S>(store: ReadableStore<T>, selector: (state: T) => S, isEqual?: (a: S, b: S) => boolean): S;
export function useStore<T, S>(
  store: ReadableStore<T>,
  selector: (state: T) => S = identity as (state: T) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S {
  // `fresh` = the selection belongs to the current selector; a new selector (an inline arrow capturing other values)
  // must run again even when the state did not change, but may still reuse an equal previous result.
  const memo = useRef<{ state: T; selected: S; fresh: boolean } | null>(null);
  const selectorRef = useRef(selector);
  const equalRef = useRef(isEqual);
  if (selectorRef.current !== selector) {
    selectorRef.current = selector;
    if (memo.current !== null) memo.current = { ...memo.current, fresh: false };
  }
  equalRef.current = isEqual;
  const getSnapshot = useCallback((): S => {
    const state = store.getState();
    const previous = memo.current;
    if (previous !== null && previous.fresh && Object.is(previous.state, state)) return previous.selected;
    const selected = selectorRef.current(state);
    if (previous !== null && equalRef.current(previous.selected, selected)) {
      memo.current = { state, selected: previous.selected, fresh: true };
      return previous.selected;
    }
    memo.current = { state, selected, fresh: true };
    return selected;
  }, [store]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
