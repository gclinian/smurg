// Code mode (/w/:workspaceId/code; DESIGN §5.6, UX §8): the workbench for hand-coding, behind the mode switch.
//
//   ┌──────────┬─────────────────────────┬───────────────┐
//   │ worktree │                         │  one session  │
//   │ files    │  editor (tabs)          │  column       │
//   ├──────────┴─────────────────────────┴───────────────┤
//   │ activity · conflicts · transfers · terminal        │  (bottom drawer)
//   └────────────────────────────────────────────────────┘
//
// Every slot is a feature's component inside its own error boundary; the layout never passes data down: features read
// the stores. The right pane is ONE session column, the same body as in the sessions view, with a selector for which
// session (features/columns SideColumn). Panes are resizable (keyboard too) and remembered per browser.
//
// This module is a lazy chunk (WorkspaceShell loads it when code mode is first shown): Monaco and xterm come with it,
// never with the sessions view.
import { useStore } from '../../lib/store.ts';
import { selectOpenConflicts } from '../../lib/stores/conflicts.ts';
import { selectSession, sessionTitle } from '../../lib/stores/sessions.ts';
import { selectActiveTransfers } from '../../lib/stores/transfers.ts';
import type { PanelId } from '../../lib/commands.ts';
import { useCommand, useCommandHandler, useStores } from '../../lib/workspace/context.tsx';
import { tUi } from '../../strings/ui.ts';
import { tWorkbench } from '../../strings/workbench.ts';
import { Badge, Button, IconButton, SlotBoundary, SplitPane, Tabs } from '../../ui/index.ts';
import { IconArrowLeft, IconChevronDown, IconChevronUp } from '../../ui/icons.tsx';
import { ActivityPanel, ConflictsPanel } from '../../features/activity/index.tsx';
import { TerminalPanel } from '../../features/agents/index.tsx';
import { SideColumn } from '../../features/columns/index.tsx';
import { EditorArea } from '../../features/editor/index.tsx';
import { FilesPanel } from '../../features/files/index.tsx';
import { TransfersPanel } from '../../features/transfer/index.tsx';
import { WorktreeSwitcher } from '../../features/worktree/index.tsx';
import { MIN_EDITOR_PX, MIN_MAIN_PX, MIN_SIDE_PX, minRightOfFiles } from './layout-limits.ts';
import type { DrawerTab, ShellLayout } from './layout.ts';

/** The collapsed drawer keeps its header (the tab strip) visible. */
const DRAWER_HEADER_PX = 33;

export interface WorkbenchProps {
  /** Code mode is the mode on screen. */
  shown: boolean;
  layout: ShellLayout;
  setLayout(update: (previous: ShellLayout) => ShellLayout): void;
}

export default function Workbench({ shown, layout, setLayout }: WorkbenchProps) {
  const stores = useStores();
  const openColumn = useCommand('openColumn');
  const setMode = useCommand('setMode');

  const openConflicts = useStore(stores.conflicts, (s) => selectOpenConflicts(s).length);
  const activeTransfers = useStore(stores.transfers, (s) => selectActiveTransfers(s).length);
  const origin = useStore(stores.columns, (s) => s.code.origin);
  const originSession = useStore(stores.sessions, (s) => (origin?.sessionId === undefined ? undefined : selectSession(s, origin.sessionId)));

  useCommandHandler('showPanel', ({ panel }: { panel: PanelId }) => {
    setLayout((previous) => {
      switch (panel) {
        case 'files':
          return { ...previous, files: true };
        case 'session':
          return { ...previous, side: true };
        case 'activity':
        case 'conflicts':
        case 'transfers':
        case 'terminal':
          return { ...previous, drawer: true, drawerTab: panel };
        case 'editor':
          return previous;
      }
    });
  });

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
          { id: 'terminal', label: tWorkbench('tab.terminal'), panel: <SlotBoundary name={tWorkbench('tab.terminal')}><TerminalPanel /></SlotBoundary> },
        ]}
      />
    </section>
  );

  /** Back to where "Open in editor" came from: the sessions view, with that session's column in front. */
  const back = (): void => {
    const sessionId = origin?.sessionId;
    stores.columns.setCodeOrigin(null);
    // Opening a column switches to the sessions view by itself.
    const done = sessionId !== undefined ? openColumn({ target: { kind: 'session', sessionId } }) : setMode({ mode: 'sessions' });
    done.catch(() => {});
  };

  const center = (
    <main id="workbench-main" className="app-editor-region" aria-label={tWorkbench('region.editor')} tabIndex={-1}>
      {origin !== null ? (
        <div className="app-code-origin" data-code-origin="">
          <span className="app-code-origin__text">{originSession ? tWorkbench('code.origin', { session: sessionTitle(originSession) }) : tWorkbench('code.origin.plain')}</span>
          <Button size="sm" variant="ghost" icon={<IconArrowLeft />} onClick={back}>
            {tWorkbench('code.back')}
          </Button>
        </div>
      ) : null}
      <div className="app-editor-region__editor">
        <SlotBoundary name={tWorkbench('region.editor')}>
          <EditorArea />
        </SlotBoundary>
      </div>
    </main>
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
    <div className="app-workbench">
      <a className="ui-skip-link" href="#workbench-main">
        {tWorkbench('skip')}
      </a>
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
              collapsed={!layout.files}
              start={sidebar}
              end={
                <SplitPane
                  orientation="horizontal"
                  fixed="end"
                  defaultSize={420}
                  minSize={MIN_SIDE_PX}
                  maxSize={1100}
                  minOtherSize={MIN_EDITOR_PX}
                  storageKey="side"
                  label={tWorkbench('region.session')}
                  collapsed={!layout.side}
                  start={center}
                  end={<SideColumn shown={shown} />}
                />
              }
            />
          }
          end={drawer}
        />
      </div>
    </div>
  );
}
