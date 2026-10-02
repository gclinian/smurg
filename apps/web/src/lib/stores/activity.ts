// Activity feed (SPEC R8.5, R11): every agent edit, human edit, create/rename/delete/upload, external change,
// conflict and denied lock, newest first. Also the member notifications agents send with the coordination MCP tool
// notify_member (activity.notify, only to the notified member), and the notices the host itself writes.
import type { ActivityEvent, MemberNotification } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, readyState, withGeneration, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';

export interface ActivityState extends Loadable {
  /** Newest first, at most ACTIVITY_MAX_EVENTS. */
  readonly events: readonly ActivityEvent[];
  /** Whether older events may exist on the host (loadOlder()). */
  readonly hasMore: boolean;
  readonly loadingOlder: boolean;
  /** Newest first, at most NOTIFICATIONS_MAX. */
  readonly notifications: readonly MemberNotification[];
}

export interface ActivityStore extends ReadableStore<ActivityState> {
  reload(): Promise<void>;
  /** Fetches the page before the oldest loaded event. */
  loadOlder(): Promise<void>;
  dismissNotification(id: string): void;
}

export const ACTIVITY_PAGE_SIZE = 100;
export const ACTIVITY_MAX_EVENTS = 1_000;
export const NOTIFICATIONS_MAX = 50;

export const INITIAL_ACTIVITY_STATE: ActivityState = Object.freeze({
  status: 'idle',
  error: null,
  events: [],
  hasMore: false,
  loadingOlder: false,
  notifications: [],
});

export const selectActivityEvents = (state: ActivityState): readonly ActivityEvent[] => state.events;
export const selectNotifications = (state: ActivityState): readonly MemberNotification[] => state.notifications;

/** Merges newest-first lists by id (the live event and a page can overlap). */
function mergeEvents(a: readonly ActivityEvent[], b: readonly ActivityEvent[]): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const event of [...a, ...b]) byId.set(event.id, event);
  return [...byId.values()].sort((x, y) => y.at - x.at).slice(0, ACTIVITY_MAX_EVENTS);
}

export function createActivityArea(): { store: ActivityStore; lifecycle: AreaLifecycle } {
  const state = createStore<ActivityState>(INITIAL_ACTIVITY_STATE);
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('activity store is not bound to a connection');
    return ctx;
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      () => c.conn.request('activity.list', { limit: ACTIVITY_PAGE_SIZE }),
      ({ events }) =>
        state.setState((previous) => ({
          ...previous,
          ...readyState(),
          events: mergeEvents(previous.events, events),
          hasMore: events.length >= ACTIVITY_PAGE_SIZE,
        })),
    );
  };

  const store: ActivityStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    async loadOlder() {
      const c = context();
      const current = state.getState();
      const oldest = current.events.at(-1);
      if (current.loadingOlder || !current.hasMore || oldest === undefined) return;
      state.setState({ ...current, loadingOlder: true });
      try {
        await withGeneration(
          c,
          () => c.conn.request('activity.list', { limit: ACTIVITY_PAGE_SIZE, before: oldest.at }),
          ({ events }) =>
            state.setState((previous) => ({
              ...previous,
              events: mergeEvents(previous.events, events),
              hasMore: events.length >= ACTIVITY_PAGE_SIZE && previous.events.length + events.length < ACTIVITY_MAX_EVENTS,
            })),
        );
      } finally {
        state.setState((previous) => ({ ...previous, loadingOlder: false }));
      }
    },
    dismissNotification(id) {
      state.setState((previous) => ({ ...previous, notifications: previous.notifications.filter((n) => n.id !== id) }));
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offEvent = c.conn.on('activity.event', ({ event }) => {
        state.setState((previous) => ({ ...previous, events: mergeEvents([event], previous.events) }));
      });
      const offNotify = c.conn.on('activity.notify', ({ notification }) => {
        state.setState((previous) => ({
          ...previous,
          notifications: [notification, ...previous.notifications.filter((n) => n.id !== notification.id)].slice(0, NOTIFICATIONS_MAX),
        }));
      });
      return () => {
        offEvent();
        offNotify();
      };
    },
    reset() {
      // Notifications are this client's own; the feed is reloaded from the host.
      state.setState((previous) => ({ ...INITIAL_ACTIVITY_STATE, notifications: previous.notifications }));
    },
    load,
  };
  return { store, lifecycle };
}
