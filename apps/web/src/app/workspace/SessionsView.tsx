// The sessions view, the main screen of a workspace (DESIGN §5, UX §1):
//
//   ┌ left column ─────────┬ column ───────┬ column ───────┬ column ───────┐
//   │ Inbox                │ a session's   │ the plan      │ a result      │
//   │ Sessions, by topic   │ conversation  │               │ report        │
//   └──────────────────────┴───────────────┴───────────────┴───────────────┘
//
// The left column (features/sidebar) is 288 px by default, 220 to 420 px by its separator, or a 44 px rail. The right
// side is the strip of up to four columns (features/columns); what a column shows is a feature's component. Landmarks:
// `complementary` "Inbox and sessions", `main` "Open columns"; each column is a region named by its title.
// F6 / Shift+F6 move between the regions: inbox, session list, each column in order.
import { useRef, type KeyboardEvent } from 'react';
import { tWorkbench } from '../../strings/workbench.ts';
import { SplitPane } from '../../ui/index.ts';
import { ColumnStrip, columnsRegionLabel } from '../../features/columns/index.tsx';
import { ShellBanners, Sidebar, sidebarResizeLabel, type SidebarSection } from '../../features/sidebar/index.tsx';
import { EmptyColumns } from './EmptyColumns.tsx';
import { LEFT_DEFAULT_PX, LEFT_MAX_PX, LEFT_MIN_PX, LEFT_RAIL_PX, MIN_COLUMNS_PX } from './layout-limits.ts';
import type { LayoutSwitch, ShellLayout } from './layout.ts';

export interface SessionsViewProps {
  /** The sessions view is the mode on screen. */
  shown: boolean;
  layout: ShellLayout;
  setSwitch(which: LayoutSwitch, on: boolean): void;
}

/** Where F6 lands, in order: the two sections of the left column (its first button while it is a rail), then each column's title. */
function regionStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.sidebar-section .ui-collapsible__toggle, .sidebar-rail__button button, [data-region-focus]')].filter(
    (element) => element.closest('[hidden]') === null,
  );
}

export function SessionsView({ shown, layout, setSwitch }: SessionsViewProps) {
  const root = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || !root.current) return;
    const stops = regionStops(root.current);
    if (stops.length === 0) return;
    event.preventDefault();
    const active = document.activeElement;
    // The region the focus is in: the last stop at or before the focused element in document order.
    let current = -1;
    stops.forEach((stop, index) => {
      if (active !== null && (stop === active || (stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)) current = index;
    });
    const next = event.shiftKey ? (current <= 0 ? stops.length - 1 : current - 1) : (current + 1) % stops.length;
    stops[next]?.focus();
  };

  /** After the last column was closed the focus goes back to the session list (UX §2). */
  const focusSessionList = (): void => {
    const node = root.current;
    if (!node) return;
    const stop = node.querySelector<HTMLElement>('.sidebar-section--sessions [role="treeitem"][tabindex="0"]') ?? node.querySelector<HTMLElement>('.sidebar-section--sessions .ui-collapsible__toggle') ?? node.querySelector<HTMLElement>('.sidebar-rail button');
    stop?.focus();
  };

  const expand = (section: SidebarSection): void => {
    setSwitch('left', true);
    setSwitch(section, true);
  };

  return (
    <div ref={root} className="app-sessions" onKeyDown={onKeyDown}>
      <a className="ui-skip-link" href="#sessions-main">
        {tWorkbench('skip')}
      </a>
      <div className="app-banners">
        <ShellBanners />
      </div>
      <div className="app-sessions__body">
        <SplitPane
          orientation="horizontal"
          fixed="start"
          defaultSize={LEFT_DEFAULT_PX}
          minSize={LEFT_MIN_PX}
          maxSize={LEFT_MAX_PX}
          minOtherSize={MIN_COLUMNS_PX}
          storageKey="sessions-left"
          label={sidebarResizeLabel()}
          collapsed={!layout.left}
          collapsedSize={LEFT_RAIL_PX}
          start={
            <Sidebar
              collapsed={!layout.left}
              onExpand={expand}
              inboxOpen={layout.inbox}
              sessionsOpen={layout.sessions}
              onToggle={(section, open) => setSwitch(section, open)}
            />
          }
          end={
            <main id="sessions-main" className="app-sessions__main" aria-label={columnsRegionLabel()} tabIndex={-1}>
              <ColumnStrip shown={shown} empty={<EmptyColumns />} onLastClosed={focusSessionList} />
            </main>
          }
        />
      </div>
    </div>
  );
}
