// The member's own inbox (ARCHITECTURE §5.11): things that wait for them, derived by the daemon from open questions,
// permission requests, suggestions, reports, merges and work that stopped. Live through inbox.list + inbox.changed.
// An item leaves when the thing is settled, for everyone at the same moment; looking at one only clears "unread".
//
// Two groups and two counts (DESIGN §5.12 item 1), everywhere a count shows:
//   waiting   an agent or a plan is stopped on it (`InboxItem.waiting`): the rows only I can settle first, then the
//             oldest first;
//   look      the rest, newest first (a merge that other items wait for sorts first).
// `arrivals` are the waiting items that came in after the first snapshot: the shell announces them politely and, when
// their session is on no visible column, shows a toast with "Open".
import { collectPages, type InboxItem } from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { loadSnapshot, mapFrom, readyState, type AreaLifecycle, type Loadable, type StoreContext } from './base.ts';
import { compareIds } from '../format.ts';

export interface InboxArrival {
  readonly id: number;
  readonly item: InboxItem;
}

export interface InboxState extends Loadable {
  readonly items: ReadonlyMap<string, InboxItem>;
  /** Waiting items that arrived by themselves, oldest first, at most INBOX_ARRIVALS_MAX. */
  readonly arrivals: readonly InboxArrival[];
}

export interface InboxStore extends ReadableStore<InboxState> {
  reload(): Promise<void>;
  /** The member looked at these items: clears `unread` (a mention or a result that was opened leaves). */
  seen(keys: readonly string[]): void;
  /** Mentions and results only; anything else leaves when it is settled (`inbox.notDismissable`). */
  dismiss(key: string): Promise<void>;
}

export interface InboxCounts {
  /** What an agent or a plan is stopped on (amber). */
  readonly waiting: number;
  /** The rest (neutral). */
  readonly look: number;
}

export interface InboxGroups {
  readonly waiting: readonly InboxItem[];
  readonly look: readonly InboxItem[];
}

export const INBOX_ARRIVALS_MAX = 20;

export const INITIAL_INBOX_STATE: InboxState = Object.freeze({ status: 'idle', error: null, items: new Map(), arrivals: [] });

// ---- selectors

/** A waiting row nobody else may settle: no others are named, and it does not wait for somebody else's answer. */
export function onlyMine(item: InboxItem, selfUserId: string | null): boolean {
  if (item.kind === 'vote') return false; // a vote is advice: the decider can submit without it
  if ((item.alsoFor?.length ?? 0) > 0 || (item.alsoForMore ?? 0) > 0) return false;
  return item.waitsFor === undefined || item.waitsFor.userId === selfUserId;
}

export function selectInboxGroups(state: InboxState, selfUserId: string | null): InboxGroups {
  const waiting: InboxItem[] = [];
  const look: InboxItem[] = [];
  for (const item of state.items.values()) (item.waiting ? waiting : look).push(item);
  waiting.sort((a, b) => Number(onlyMine(b, selfUserId)) - Number(onlyMine(a, selfUserId)) || a.at - b.at || compareIds(a.key, b.key));
  const unblocks = (item: InboxItem): number => (item.kind === 'merge' && (item.unblocks?.length ?? 0) > 0 ? 1 : 0);
  look.sort((a, b) => unblocks(b) - unblocks(a) || b.at - a.at || compareIds(a.key, b.key));
  return { waiting, look };
}

export function selectInboxCounts(state: InboxState): InboxCounts {
  let waiting = 0;
  for (const item of state.items.values()) if (item.waiting) waiting += 1;
  return { waiting, look: state.items.size - waiting };
}

export function createInboxArea(): { store: InboxStore; lifecycle: AreaLifecycle } {
  const state = createStore<InboxState>(INITIAL_INBOX_STATE);
  let arrivalId = 0;
  let ctx: StoreContext | null = null;
  const context = (): StoreContext => {
    if (!ctx) throw new Error('inbox store is not bound to a connection');
    return ctx;
  };

  const load = (): Promise<void> => {
    const c = context();
    return loadSnapshot(
      c,
      (loadable) => state.setState((previous) => ({ ...previous, ...loadable })),
      // `inbox.list` follows the list rule: read every page.
      () =>
        collectPages(async (after) => {
          const page = await c.conn.request('inbox.list', after === undefined ? {} : { after });
          return { items: page.items, hasMore: page.hasMore };
        }, (item: InboxItem) => item.key),
      (items) => state.setState((previous) => ({ ...previous, ...readyState(), items: mapFrom(items, (item) => item.key) })),
    );
  };

  const store: InboxStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    reload: load,
    seen(keys) {
      const items = state.getState().items;
      const unread = keys.filter((key) => items.get(key)?.unread === true);
      if (unread.length === 0) return;
      // Shown at once; the daemon answers with inbox.changed (and removes an opened mention or result).
      state.setState((previous) => {
        const next = new Map(previous.items);
        for (const key of unread) {
          const item = next.get(key);
          if (item) next.set(key, { ...item, unread: false });
        }
        return { ...previous, items: next };
      });
      try {
        context().conn.notify('inbox.seen', { keys: unread }, { whenDisconnected: 'drop' });
      } catch {
        // closed connection: the mark is made again by the next look after a reconnect
      }
    },
    async dismiss(key) {
      await context().conn.request('inbox.dismiss', { key });
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      return c.conn.on('inbox.changed', ({ upsert, remove }) => {
        state.setState((previous) => {
          const items = new Map(previous.items);
          for (const key of remove) items.delete(key);
          let arrivals = previous.arrivals;
          for (const item of upsert) {
            // New to this inbox and stopping work: worth telling. (Before the first snapshot everything is new.)
            if (previous.status === 'ready' && item.waiting && !previous.items.has(item.key)) {
              arrivalId += 1;
              arrivals = [...arrivals, { id: arrivalId, item }].slice(-INBOX_ARRIVALS_MAX);
            }
            items.set(item.key, item);
          }
          return { ...previous, items, arrivals };
        });
      });
    },
    reset() {
      state.setState((previous) => ({ ...INITIAL_INBOX_STATE, arrivals: previous.arrivals }));
    },
    load,
  };
  return { store, lifecycle };
}
