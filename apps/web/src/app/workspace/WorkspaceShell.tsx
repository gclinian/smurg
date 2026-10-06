// The shell of a workspace's two views (DESIGN §5.1, AD-12): the sessions view and code mode are BOTH mounted and one
// is shown; the other is hidden and inert. So composer drafts, open columns, editor tabs and scroll positions survive
// the switch and nothing reconnects. The mode is the route (`/w/:id` or `/w/:id/code`): a reload and the back button
// keep it. Code mode's chunk (Monaco, xterm) is loaded when code mode is first shown.
//
// The shell also owns what belongs to neither view: the top bar, the connection banners, the commands that move
// between the views (openColumn, setMode, openInCodeMode), the overlays the features registered (dialogs and command
// handlers that must exist in both modes), the notices, and the browser tab's title with the waiting count.
import type { Topic } from '@smurg/protocol';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { columnId, isColumnRef } from '../../lib/columns/target.ts';
import type { WorkspaceMode } from '../../lib/commands.ts';
import { routePath } from '../../lib/router.ts';
import { useStore } from '../../lib/store.ts';
import { selectInboxCounts } from '../../lib/stores/inbox.ts';
import { selectTopic } from '../../lib/stores/topics.ts';
import { useCommandHandler, useCommands, useConnectionState, useStores, useWorkspaceInfo, useWorkspaceSession } from '../../lib/workspace/context.tsx';
import { useSlots } from '../../lib/workspace/slots.tsx';
import { tConn } from '../../strings/connection.ts';
import { tWorkbench } from '../../strings/workbench.ts';
import { Banner, SlotBoundary, Spinner } from '../../ui/index.ts';
import { InboxNotices } from '../../features/sidebar/index.tsx';
import { ConnectionBanner } from '../connection/indicators.tsx';
import { useAppServices } from '../services.tsx';
import { readLayout, writeLayout, type LayoutSwitch, type ShellLayout } from './layout.ts';
import { SessionsView } from './SessionsView.tsx';
import { TopBar, type LayoutToggles } from './TopBar.tsx';
import { useWorkspaceNotices } from './useWorkspaceNotices.ts';

const Workbench = lazy(() => import('./Workbench.tsx'));

export interface WorkspaceShellProps {
  mode: WorkspaceMode;
}

export function WorkspaceShell({ mode }: WorkspaceShellProps) {
  const session = useWorkspaceSession();
  const stores = useStores();
  const commands = useCommands();
  const slots = useSlots();
  const state = useConnectionState();
  const info = useWorkspaceInfo();
  const { router, keyStorage } = useAppServices();
  const persistentKeys = useStore(keyStorage, (s) => s.persistent);
  const waiting = useStore(stores.inbox, (s) => selectInboxCounts(s).waiting);
  const workspaceId = session.workspaceId;

  const [layout, setLayoutState] = useState<ShellLayout>(readLayout);
  const setLayout = (update: (previous: ShellLayout) => ShellLayout): void => {
    setLayoutState((previous) => {
      const next = update(previous);
      writeLayout(next);
      return next;
    });
  };
  const setSwitch = (which: LayoutSwitch, on: boolean): void => setLayout((previous) => (previous[which] === on ? previous : { ...previous, [which]: on }));

  // Code mode is mounted from the first time it is shown, and stays.
  const [codeMounted, setCodeMounted] = useState(mode === 'code');
  useEffect(() => {
    if (mode === 'code') setCodeMounted(true);
  }, [mode]);

  useWorkspaceNotices();

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const goTo = (next: WorkspaceMode): void => {
    if (modeRef.current !== next) router.navigate(routePath({ name: next === 'code' ? 'code' : 'workspace', workspaceId }));
  };

  useCommandHandler('setMode', ({ mode: next }) => goTo(next));

  useCommandHandler('openColumn', ({ target, side, from, anchor }) => {
    if (!isColumnRef(target)) {
      // A section of the host console is a page of its own.
      router.navigate(routePath({ name: 'console', workspaceId, section: target.section }));
      return;
    }
    // The plan of a topic that is executing is pinned by default (DESIGN §5.12 item 24).
    const pin = target.kind === 'plan' && selectTopic(stores.topics.getState(), target.topicId)?.phase === 'executing';
    stores.columns.open(target, { ...(side === undefined ? {} : { side }), ...(from === undefined ? {} : { from }), ...(anchor === undefined ? {} : { anchor }), ...(pin ? { pin } : {}) });
    goTo('sessions');
  });

  // The same default for a plan column that is already open when its topic starts executing (Start pressed with the
  // plan on screen): it is pinned at that moment, so the first click on an item's session opens beside it. Only the
  // moment pins: a person who unpins the plan afterwards keeps it so. The phases seen last outlive a resync.
  useEffect(() => {
    const phases = new Map<string, Topic['phase']>();
    const follow = (): void => {
      for (const topic of stores.topics.getState().topics.values()) {
        const before = phases.get(topic.id);
        phases.set(topic.id, topic.phase);
        if (before !== undefined && before !== 'executing' && topic.phase === 'executing') stores.columns.setPinned(columnId({ kind: 'plan', topicId: topic.id }), true);
      }
    };
    follow();
    return stores.topics.subscribe(follow);
  }, [stores]);

  useCommandHandler('openInCodeMode', async ({ root, file, line, sessionId }) => {
    if (sessionId !== undefined) stores.columns.setCodeSession(sessionId);
    stores.columns.setCodeOrigin({ root, ...(sessionId === undefined ? {} : { sessionId }), ...(file === undefined ? {} : { path: file }) });
    stores.files.setActiveRoot(root);
    setLayout((previous) => ({ ...previous, files: true, ...(sessionId === undefined ? {} : { side: true }) }));
    goTo('code');
    if (file === undefined) return;
    // The editor registers its handler when code mode's chunk has loaded and mounted.
    await commands.whenHandled('openFile');
    await commands.dispatch('openFile', { file: { root, path: file }, ...(line === undefined ? {} : { line }) });
  });

  // The tab's title says how many things an agent or a plan is stopped on, also while another tab is in front.
  const name = info?.name ?? workspaceId;
  useEffect(() => {
    const before = document.title;
    // "bookshop · smurg": a name and the product's name, the same in every language.
    const title = `${name} · smurg`;
    document.title = waiting > 0 ? tWorkbench('title.waiting', { count: waiting, title }) : title;
    return () => {
      document.title = before;
    };
  }, [waiting, name]);

  const toggles: LayoutToggles = {
    left: layout.left,
    files: layout.files,
    side: layout.side,
    drawer: layout.drawer,
    toggle: (which) => setLayout((previous) => ({ ...previous, [which]: !previous[which] })),
  };

  return (
    <div className="app-shell" data-connection-state={state.kind} data-mode={mode}>
      <TopBar view={mode} layout={toggles} />
      <div className="app-banners">
        <ConnectionBanner state={state} />
        {persistentKeys === false ? (
          <Banner tone="warning" live="none">
            {tConn('banner.memoryKeys')}
          </Banner>
        ) : null}
      </div>
      <div className="app-shell__views">
        <div className="app-shell__view" data-view="sessions" hidden={mode !== 'sessions'} inert={mode !== 'sessions'}>
          <SessionsView shown={mode === 'sessions'} layout={layout} setSwitch={setSwitch} />
        </div>
        <div className="app-shell__view" data-view="code" hidden={mode !== 'code'} inert={mode !== 'code'}>
          {codeMounted ? (
            <Suspense
              fallback={
                <div className="app-shell__loading">
                  <Spinner label={tWorkbench('mode.code')} />
                </div>
              }
            >
              <Workbench shown={mode === 'code'} layout={layout} setLayout={setLayout} />
            </Suspense>
          ) : null}
        </div>
      </div>
      {slots.overlays.map(({ feature, index, Component }) => (
        <SlotBoundary key={`${feature}:${index}`} name={feature} silent>
          <Suspense fallback={null}>
            <Component />
          </Suspense>
        </SlotBoundary>
      ))}
      <InboxNotices sessionsShown={mode === 'sessions'} />
    </div>
  );
}
