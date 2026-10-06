// The conversation itself (DESIGN §5.5): a `log` region that shows a WINDOW of the folded items.
//
//   - at most MOUNT_LIMIT of the newest items are mounted, plus what the reader paged in; each row has
//     `content-visibility: auto` with a remembered size (conversation.css), so rows off screen cost no layout;
//   - "Load earlier" (and scrolling to the top) first shows older items the window already holds, then reads an earlier
//     page; coming back to the end drops what was paged in;
//   - the list follows new content only while it is at its end; otherwise "New activity" appears;
//   - an anchor (an inbox item, a status bar's "Show it") scrolls to its card or event, loading history until the
//     window holds it, puts the focus on it and outlines it for a moment.
//
// Nothing that arrives by itself moves the focus or the scroll position of a list someone is reading (UX §11).
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { useColumn } from '../../lib/columns/context.tsx';
import type { ColumnAnchor } from '../../lib/columns/target.ts';
import { useStore } from '../../lib/store.ts';
import type { RenderItem } from '../../lib/stores/conversations.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, Spinner } from '../../ui/index.ts';
import { IconChevronDown } from '../../ui/icons.tsx';
import { renderRow } from './rows.tsx';
import { t } from './strings.ts';
import { cardDomId } from './text.ts';

/** How many of the newest render items are mounted before the reader asks for more (DESIGN §5.5). */
export const MOUNT_LIMIT = 400;
/** Closer than this to the bottom counts as "at the end". */
export const END_SLACK_PX = 48;
/** Closer than this to the top loads earlier items. */
export const TOP_SLACK_PX = 120;
/** How long the row an anchor led to stays outlined. */
export const FLASH_MS = 2_400;

export interface EventListHandle {
  /** Scrolls to a card or an event (loading history until the window holds it); resolves false when it is not there. */
  show(anchor: ColumnAnchor): Promise<boolean>;
  scrollToEnd(): void;
}

const Row = memo(function Row({ item, latest }: { item: RenderItem; latest: ReadonlySet<number> }) {
  return (
    <div className="conv-row" data-kind={item.kind} data-seq={item.seq} data-key={item.key}>
      {renderRow(item, latest)}
    </div>
  );
});

const NO_ITEMS: readonly RenderItem[] = [];

export function EventList({ sessionId, title, ref }: { sessionId: string; title: string; ref?: Ref<EventListHandle> }) {
  const stores = useStores();
  const column = useColumn();
  const store = stores.conversations;
  const status = useStore(store, (state) => state.conversations.get(sessionId)?.status ?? 'loading');
  const error = useStore(store, (state) => state.conversations.get(sessionId)?.error ?? null);
  const items = useStore(store, (state) => state.conversations.get(sessionId)?.items ?? NO_ITEMS);
  const hasEarlier = useStore(store, (state) => state.conversations.get(sessionId)?.hasEarlier ?? false);
  const loadingEarlier = useStore(store, (state) => state.conversations.get(sessionId)?.loadingEarlier ?? false);
  const pagedIn = useStore(store, (state) => state.conversations.get(sessionId)?.pagedIn ?? false);
  const thinking = useStore(store, (state) => (state.conversations.get(sessionId)?.thinkingTurnId ?? null) !== null);

  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** The reader is at the end: new content keeps the end in view. A ref: scrolling must not render. */
  const atEnd = useRef(true);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  /** Extra items mounted above the newest MOUNT_LIMIT (the reader went up). */
  const [extra, setExtra] = useState(0);
  /** The scroll height before older rows were put on top, so the row the reader looks at stays where it is. */
  const keepFrom = useRef<number | null>(null);

  const mountFrom = Math.max(0, items.length - MOUNT_LIMIT - extra);
  const mounted = mountFrom === 0 ? items : items.slice(mountFrom);
  const moreAbove = mountFrom > 0 || hasEarlier;

  const latestPointers = useMemo(() => {
    const newest = new Map<string, number>();
    for (const item of items) if (item.kind === 'pointer') newest.set(`${item.event.target}:${item.event.itemId ?? ''}`, item.seq);
    return new Set(newest.values());
  }, [items]);

  const scrollToEnd = useCallback((): void => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    atEnd.current = true;
    setAway(false);
    setFresh(false);
  }, []);

  const loadEarlier = useCallback((): void => {
    const node = scroller.current;
    keepFrom.current = node ? node.scrollHeight - node.scrollTop : null;
    if (mountFrom > 0) setExtra((count) => count + MOUNT_LIMIT);
    else void store.loadEarlier(sessionId);
  }, [mountFrom, store, sessionId]);

  const onScroll = (): void => {
    const node = scroller.current;
    if (!node) return;
    const end = node.scrollHeight - node.scrollTop - node.clientHeight <= END_SLACK_PX;
    if (end !== atEnd.current) {
      atEnd.current = end;
      setAway(!end);
      if (end) {
        setFresh(false);
        // Back at the end: what was paged in goes again.
        setExtra(0);
        if (pagedIn) store.dropEarlier(sessionId);
      }
    }
    if (!end && node.scrollTop <= TOP_SLACK_PX && moreAbove && !loadingEarlier && status === 'ready') loadEarlier();
  };

  // New rows: stay at the end when the reader is there; keep the place when older rows came on top; otherwise say
  // that something arrived.
  const lastKey = items.at(-1)?.key ?? null;
  const firstKey = mounted[0]?.key ?? null;
  const seenLast = useRef<string | null>(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (keepFrom.current !== null) {
      node.scrollTop = node.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    } else if (atEnd.current) {
      node.scrollTop = node.scrollHeight;
    } else if (lastKey !== seenLast.current && seenLast.current !== null) {
      setFresh(true);
    }
    seenLast.current = lastKey;
  }, [lastKey, firstKey, items, thinking]);

  // Text that streams, a tool line that opens, an image-less paragraph that wraps: whatever makes the content taller
  // keeps the end in view while the reader is at the end.
  useEffect(() => {
    const content = inner.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const node = scroller.current;
      if (node && atEnd.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // A streaming block grows without the list rendering: away from the end, it is "new activity".
  useEffect(
    () =>
      store.onStream(sessionId, () => {
        if (!atEnd.current) setFresh(true);
      }),
    [store, sessionId, status],
  );

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  /** The element of an anchor inside the list, when it is mounted. */
  const elementOf = (anchor: ColumnAnchor, seq: number): HTMLElement | null => {
    const node = scroller.current;
    if (!node) return null;
    if (anchor.cardId !== undefined) {
      // cardDomId() leaves only characters that need no escaping in a selector.
      const card = node.querySelector<HTMLElement>(`#${cardDomId(anchor.cardId)}`);
      if (card) return card;
    }
    // The row that holds the event: the last row that starts at or before it.
    let found: HTMLElement | null = null;
    for (const row of node.querySelectorAll<HTMLElement>('.conv-row')) {
      if (Number(row.dataset['seq']) <= seq) found = row;
      else break;
    }
    return found;
  };

  const pendingShow = useRef<{ anchor: ColumnAnchor; seq: number; done(found: boolean): void } | null>(null);
  const reveal = useCallback((): void => {
    const pending = pendingShow.current;
    if (pending === null) return;
    const element = elementOf(pending.anchor, pending.seq);
    if (element === null) return;
    pendingShow.current = null;
    atEnd.current = false;
    setAway(true);
    element.scrollIntoView?.({ block: 'center' });
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
    element.focus({ preventScroll: true });
    element.setAttribute('data-flash', '');
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => element.removeAttribute('data-flash'), FLASH_MS);
    pending.done(true);
  }, []);
  // The row an anchor asked for was mounted by the render it caused.
  useLayoutEffect(reveal);

  const show = useCallback(
    async (anchor: ColumnAnchor): Promise<boolean> => {
      const seq = await store.showAnchor(sessionId, anchor);
      if (seq === null) return false;
      return new Promise<boolean>((resolve) => {
        pendingShow.current?.done(false);
        pendingShow.current = { anchor, seq, done: resolve };
        // Mount everything the window holds from that row on, then look for it.
        const all = store.getState().conversations.get(sessionId)?.items ?? [];
        const index = all.findIndex((item) => item.seq >= seq);
        const needed = index === -1 ? 0 : all.length - index;
        if (needed > MOUNT_LIMIT) setExtra((count) => Math.max(count, needed - MOUNT_LIMIT + 20));
        else reveal();
        // A row that is not there after the next frames (the card was never in this conversation) gives up.
        setTimeout(() => {
          if (pendingShow.current?.done === resolve) {
            pendingShow.current = null;
            resolve(false);
          }
        }, 1_000);
      });
    },
    [store, sessionId, reveal],
  );

  useImperativeHandle(ref, () => ({ show, scrollToEnd }), [show, scrollToEnd]);

  // Where an inbox item (or a link) led.
  const anchor = column.anchor;
  const anchorShown = column.anchorShown;
  useEffect(() => {
    if (anchor === null || status !== 'ready') return;
    let cancelled = false;
    void show(anchor).then(() => {
      if (!cancelled) anchorShown();
    });
    return () => {
      cancelled = true;
    };
    // `anchor` is a new object per request (its token).
  }, [anchor, status, show, anchorShown]);

  if (status === 'error') {
    return (
      <div className="col-scroll conv">
        <div className="col-measure conv__inner">
          <Banner
            tone="danger"
            actions={
              <Button size="sm" onClick={() => void store.reload(sessionId)}>
                {t('load.retry')}
              </Button>
            }
          >
            {t('loadError', { message: error ?? '' })}
          </Banner>
        </div>
      </div>
    );
  }

  return (
    <div className="conv-wrap">
      <div ref={scroller} className="col-scroll conv" role="log" aria-live="off" aria-label={t('log.label', { title })} tabIndex={0} onScroll={onScroll} data-status={status}>
        <div ref={inner} className="col-measure conv__inner">
          {status === 'loading' ? (
            <div className="conv__loading" role="status">
              <Spinner size={14} decorative />
              <span>{t('loading')}</span>
            </div>
          ) : null}
          {status === 'ready' && moreAbove ? (
            <div className="conv__earlier">
              {loadingEarlier ? (
                <span role="status">{t('earlier.loading')}</span>
              ) : (
                <Button size="sm" variant="ghost" onClick={loadEarlier}>
                  {t('earlier.load')}
                </Button>
              )}
            </div>
          ) : null}
          {status === 'ready' && !moreAbove && items.length > 0 ? <p className="conv__start">{t('earlier.start')}</p> : null}
          {mounted.map((item) => (
            <Row key={item.key} item={item} latest={latestPointers} />
          ))}
          {thinking ? (
            <p className="conv__thinking" role="status">
              {t('thinking')}
            </p>
          ) : null}
        </div>
      </div>
      {away && fresh ? (
        <Button className="conv-new" size="sm" variant="secondary" icon={<IconChevronDown />} onClick={scrollToEnd}>
          {t('newActivity')}
        </Button>
      ) : null}
    </div>
  );
}
