// The in-process event bus (ARCHITECTURE §7.3). Synchronous delivery in subscription order. A throwing listener is
// logged and skipped: one broken module must not stop a kick from reaching the session manager.
import type { DaemonEventName, DaemonEvents, EventBus } from './interfaces.ts';
import { toDisposable, type Disposable } from './lifecycle.ts';
import type { Logger } from './logger.ts';

type AnyListener = (event: never) => void;

export class TypedEventBus implements EventBus {
  private readonly listeners = new Map<DaemonEventName, Set<AnyListener>>();
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  on<K extends DaemonEventName>(name: K, listener: (event: DaemonEvents[K]) => void): Disposable {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    // Wrap so the same function can be subscribed twice and each subscription disposed on its own.
    const entry: AnyListener = (event: never) => listener(event);
    set.add(entry);
    return toDisposable(() => {
      set.delete(entry);
    });
  }

  once<K extends DaemonEventName>(name: K, listener: (event: DaemonEvents[K]) => void): Disposable {
    const subscription = this.on(name, (event) => {
      subscription.dispose();
      listener(event);
    });
    return subscription;
  }

  emit<K extends DaemonEventName>(name: K, event: DaemonEvents[K]): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        (listener as (event: DaemonEvents[K]) => void)(event);
      } catch (err) {
        this.log.error('event listener failed', { event: name, error: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  listenerCount(name: DaemonEventName): number {
    return this.listeners.get(name)?.size ?? 0;
  }
}
