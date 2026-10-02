// The workbench of /w/:workspaceId (ARCHITECTURE §9): top bar, then
//
//   ┌──────────┬─────────────────────────┬───────────────┐
//   │ worktree │                         │  agents       │
//   │ files    │  editor (tabs)          ├───────────────┤
//   │          │                         │  suggestions  │
//   ├──────────┴─────────────────────────┴───────────────┤
//   │ activity · conflicts · transfers · merge requests  │  (bottom drawer)
//   └────────────────────────────────────────────────────┘
//
// Every slot is a feature's component (src/features/<feature>/index.tsx) inside its own error boundary. The layout
// never passes data down: features read the stores. Panes are resizable (keyboard too) and remembered per browser.
import { useMemo, useState } from 'react';
import { useStore } from '../../lib/store.ts';
import { selectOpenConflicts } from '../../lib/stores/conflicts.ts';
import { selectActiveTransfers } from '../../lib/stores/transfers.ts';
import { selectPendingMergeRequests } from '../../lib/stores/worktrees.ts';
import type { PanelId } from '../../lib/commands.ts';
import { useCommandHandler, useConnectionState, useStores } from '../../lib/workspace/context.tsx';
import { browserLocalStorage, readJson, writeJson } from '../../lib/preferences.ts';
import { WorkbenchLayoutContext, type WorkbenchLayout } from '../../lib/workspace/layout.tsx';
import { tConn } from '../../strings/connection.ts';
import { tUi } from '../../strings/ui.ts';
import { tWorkbench } from '../../strings/workbench.ts';
import { Badge, Banner, IconButton, SplitPane, Tabs } from '../../ui/index.ts';
import { IconChevronDown, IconChevronUp } from '../../ui/icons.tsx';
import { ActivityPanel, ConflictsPanel } from '../../features/activity/index.tsx';
import { AgentsPanel } from '../../features/agents/index.tsx';
import { EditorArea } from '../../features/editor/index.tsx';
import { FilesPanel } from '../../features/files/index.tsx';
import { SuggestionsPanel } from '../../features/suggest/index.tsx';
import { TransfersPanel } from '../../features/transfer/index.tsx';
import { MergeRequestsPanel, WorktreeSwitcher } from '../../features/worktree/index.tsx';
import { ConnectionBanner } from '../connection/indicators.tsx';
import { useAppServices } from '../services.tsx';
import { MIN_AGENTS_PX, MIN_EDITOR_PX, MIN_MAIN_PX, MIN_TERMINAL_PX, minRightOfFiles } from './layout-limits.ts';
import { SlotBoundary } from './SlotBoundary.tsx';
import { TopBar, type LayoutToggles } from './TopBar.tsx';
import { useWorkspaceNotices } from './useWorkspaceNotices.ts';

type DrawerTab = 'activity' | 'conflicts' | 'transfers' | 'merge-requests';

interface LayoutState {
  readonly sidebar: boolean;
  readonly right: boolean;
  readonly drawer: boolean;
  readonly drawerTab: DrawerTab;
  /** The suggestions pane under the terminal is expanded. */
  readonly suggestions: boolean;
  /** The agents column takes the editor's place (a terminal needs width and height). */
  readonly agentsWide: boolean;
}

const LAYOUT_KEY = 'smurg.layout';
/**
 * The terminal gets most of the right column by default (at 1280×800 it once had 6 rows): the bottom drawer
 * starts collapsed (it opens itself for conflicts, transfers and merge requests through showPanel) and the
 * suggestions pane is smaller, collapsible to its header.
 */
const DEFAULT_LAYOUT: LayoutState = { sidebar: true, right: true, drawer: false, drawerTab: 'activity', suggestions: true, agentsWide: false };
const DRAWER_TABS: readonly DrawerTab[] = ['activity', 'conflicts', 'transfers', 'merge-requests'];
/** The collapsed drawer keeps its header (the tab strip) visible. */
const DRAWER_HEADER_PX = 33;
/** A collapsed suggestions pane keeps its panel header (title, count and the expand button). */
const PANEL_HEADER_PX = 33;
function readLayout(): LayoutState {
  const stored = readJson(browserLocalStorage(), LAYOUT_KEY);
  if (typeof stored !== 'object' || stored === null) return DEFAULT_LAYOUT;
  const s = stored as Partial<Record<keyof LayoutState, unknown>>;
  return {
    sidebar: typeof s.sidebar === 'boolean' ? s.sidebar : DEFAULT_LAYOUT.sidebar,
    right: typeof s.right === 'boolean' ? s.right : DEFAULT_LAYOUT.right,
    drawer: typeof s.drawer === 'boolean' ? s.drawer : DEFAULT_LAYOUT.drawer,
    drawerTab: DRAWER_TABS.includes(s.drawerTab as DrawerTab) ? (s.drawerTab as DrawerTab) : DEFAULT_LAYOUT.drawerTab,
    suggestions: typeof s.suggestions === 'boolean' ? s.suggestions : DEFAULT_LAYOUT.suggestions,
    agentsWide: typeof s.agentsWide === 'boolean' ? s.agentsWide : DEFAULT_LAYOUT.agentsWide,
  };
}

export function Workbench() {
  const stores = useStores();
  const state = useConnectionState();
  const { keyStorage } = useAppServices();
  const persistentKeys = useStore(keyStorage, (s) => s.persistent);
  const [layout, setLayoutState] = useState<LayoutState>(readLayout);
  const setLayout = (update: (previous: LayoutState) => LayoutState): void => {
    setLayoutState((previous) => {
      const next = update(previous);
      writeJson(browserLocalStorage(), LAYOUT_KEY, next);
      return next;
    });
  };
  useWorkspaceNotices();

  const openConflicts = useStore(stores.conflicts, (s) => selectOpenConflicts(s).length);
  const activeTransfers = useStore(stores.transfers, (s) => selectActiveTransfers(s).length);
  const pendingMerges = useStore(stores.worktrees, (s) => selectPendingMergeRequests(s).length);

  useCommandHandler('showPanel', ({ panel }: { panel: PanelId }) => {
    setLayout((previous) => {
      switch (panel) {
        case 'files':
          return { ...previous, sidebar: true };
        case 'agents':
          return { ...previous, right: true };
        case 'suggestions':
          return { ...previous, right: true, suggestions: true };
        case 'activity':
        case 'conflicts':
        case 'transfers':
        case 'merge-requests':
          return { ...previous, drawer: true, drawerTab: panel };
        case 'editor':
          return { ...previous, agentsWide: false };
      }
    });
  });

  const toggles: LayoutToggles = {
    ...layout,
    toggle: (which) => setLayout((previous) => ({ ...previous, [which]: !previous[which] })),
  };
  const workbenchLayout = useMemo<WorkbenchLayout>(
    () => ({
      suggestions: layout.suggestions,
      agentsWide: layout.agentsWide,
      toggle: (which) => setLayout((previous) => ({ ...previous, [which]: !previous[which], ...(which === 'agentsWide' ? { right: true } : {}) })),
    }),
    // setLayout only closes over the (stable) state setter.
    [layout.suggestions, layout.agentsWide],
  );

  const count = (n: number, tone: 'neutral' | 'warning' | 'info' = 'neutral') => (n > 0 ? <Badge tone={tone}>{n}</Badge> : undefined);

  const drawer = (
    <section className="app-drawer" aria-label={tWorkbench('region.drawer')}>
      <Tabs<DrawerTab>
        label={tWorkbench('region.drawer')}
        size="sm"
        value={layout.drawerTab}
        onChange={(tab) => setLayout((previous) => ({ ...previous, drawerTab: tab, drawer: true }))}
        keepMounted
        collapsed={!layout.drawer}
        actions={
          <IconButton
            label={layout.drawer ? tUi('drawer.collapse', { name: tWorkbench('region.drawer') }) : tUi('drawer.expand', { name: tWorkbench('region.drawer') })}
            icon={layout.drawer ? <IconChevronDown /> : <IconChevronUp />}
            size="sm"
            aria-expanded={layout.drawer}
            onClick={() => setLayout((previous) => ({ ...previous, drawer: !previous.drawer }))}
          />
        }
        items={[
        { id: 'activity', label: tWorkbench('tab.activity'), panel: <SlotBoundary name={tWorkbench('tab.activity')}><ActivityPanel /></SlotBoundary> },
        {
          id: 'conflicts',
          label: tWorkbench('tab.conflicts'),
          badge: count(openConflicts, 'warning'),
          panel: <SlotBoundary name={tWorkbench('tab.conflicts')}><ConflictsPanel /></SlotBoundary>,
        },
        {
          id: 'transfers',
          label: tWorkbench('tab.transfers'),
          badge: count(activeTransfers, 'info'),
          panel: <SlotBoundary name={tWorkbench('tab.transfers')}><TransfersPanel /></SlotBoundary>,
        },
        {
          id: 'merge-requests',
          label: tWorkbench('tab.mergeRequests'),
          badge: count(pendingMerges, 'info'),
          panel: <SlotBoundary name={tWorkbench('tab.mergeRequests')}><MergeRequestsPanel /></SlotBoundary>,
        },
        ]}
      />
    </section>
  );

  const center = (
    <main id="workbench-main" className="app-editor-region" aria-label={tWorkbench('region.editor')} tabIndex={-1}>
      <SlotBoundary name={tWorkbench('region.editor')}>
        <EditorArea />
      </SlotBoundary>
    </main>
  );

  const right = (
    <SplitPane
      orientation="vertical"
      fixed="end"
      defaultSize={200}
      minSize={96}
      maxSize={900}
      minOtherSize={MIN_TERMINAL_PX}
      storageKey="suggestions"
      label={tWorkbench('region.suggestions')}
      collapsed={!layout.suggestions}
      collapsedSize={PANEL_HEADER_PX}
      start={
        <SlotBoundary name={tWorkbench('region.agents')}>
          <AgentsPanel />
        </SlotBoundary>
      }
      end={
        <SlotBoundary name={tWorkbench('region.suggestions')}>
          <SuggestionsPanel />
        </SlotBoundary>
      }
    />
  );

  const sidebar = (
    <div className="app-sidebar">
      <SlotBoundary name={tWorkbench('region.files')}>
        <WorktreeSwitcher />
      </SlotBoundary>
      <div className="app-sidebar__files">
        <SlotBoundary name={tWorkbench('region.files')}>
          <FilesPanel />
        </SlotBoundary>
      </div>
    </div>
  );

  return (
    <WorkbenchLayoutContext.Provider value={workbenchLayout}>
    <div className="app-workbench" data-connection-state={state.kind}>
      <a className="ui-skip-link" href="#workbench-main">
        {tWorkbench('skip')}
      </a>
      <TopBar view="workbench" layout={toggles} />
      <div className="app-banners">
        <ConnectionBanner state={state} />
        {persistentKeys === false ? (
          <Banner tone="warning" live="none">
            {tConn('banner.memoryKeys')}
          </Banner>
        ) : null}
      </div>
      <div className="app-workbench__body">
        <SplitPane
          orientation="vertical"
          fixed="end"
          defaultSize={220}
          minSize={120}
          maxSize={800}
          minOtherSize={MIN_MAIN_PX}
          storageKey="drawer"
          label={tWorkbench('region.drawer')}
          collapsed={!layout.drawer}
          collapsedSize={DRAWER_HEADER_PX}
          start={
            <SplitPane
              orientation="horizontal"
              fixed="start"
              defaultSize={260}
              minSize={160}
              maxSize={640}
              minOtherSize={minRightOfFiles(layout)}
              storageKey="sidebar"
              label={tWorkbench('region.files')}
              collapsed={!layout.sidebar}
              start={sidebar}
              end={
                <SplitPane
                  orientation="horizontal"
                  fixed="end"
                  defaultSize={420}
                  minSize={MIN_AGENTS_PX}
                  maxSize={1100}
                  minOtherSize={MIN_EDITOR_PX}
                  storageKey="right"
                  label={tWorkbench('region.agents')}
                  collapsed={!layout.right}
                  maximized={layout.agentsWide}
                  start={center}
                  end={right}
                />
              }
            />
          }
          end={drawer}
        />
      </div>
    </div>
    </WorkbenchLayoutContext.Provider>
  );
}
