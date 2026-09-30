// /w/:workspaceId and /w/:workspaceId/console. Loaded lazily (its own chunk): the landing and join pages do not pay
// for the workbench and the features.
//
// The page acquires THE session of the workspace from the manager (the one the join page opened, or a new one in
// device mode) and gates on the connection:
//   - terminal states replace the page with an explanation (key mismatch, kicked, rejected, closed, login);
//   - before the first admission: a connecting screen (with 「主人已離線」 if the host is away);
//   - afterwards the workbench stays usable whatever happens, with a banner while the host is offline or the relay
//     unreachable (SPEC §9: never a frozen screen).
import { useEffect, useState, type ReactNode } from 'react';
import { describeConnection } from '../../lib/connection/status.ts';
import { routePath } from '../../lib/router.ts';
import { useStore } from '../../lib/store.ts';
import type { WorkspaceHandle } from '../../lib/workspace/manager.ts';
import { useCan, useConnectionState, useStores, useWorkspaceInfo, WorkspaceProvider } from '../../lib/workspace/context.tsx';
import { tWorkbench } from '../../strings/workbench.ts';
import { EmptyState } from '../../ui/index.ts';
import { HostConsolePage } from '../../features/console/index.tsx';
import { ConnectingScreen, ConnectionEndedScreen, KeyMismatchScreen, LoginRequiredScreen } from '../connection/screens.tsx';
import { ConnectionBanner } from '../connection/indicators.tsx';
import { Link } from '../navigation.tsx';
import { useAppServices } from '../services.tsx';
import { SlotBoundary } from './SlotBoundary.tsx';
import { TopBar } from './TopBar.tsx';
import { useWorkspaceNotices } from './useWorkspaceNotices.ts';
import { Workbench } from './Workbench.tsx';

export interface WorkspaceRouteProps {
  workspaceId: string;
  view: 'workbench' | 'console';
}

export default function WorkspaceRoute({ workspaceId, view }: WorkspaceRouteProps) {
  const { manager } = useAppServices();
  const [handle, setHandle] = useState<WorkspaceHandle | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const acquired = manager.acquire(workspaceId);
    setHandle(acquired);
    return () => acquired.release();
  }, [manager, workspaceId, attempt]);

  if (!handle || handle.session.workspaceId !== workspaceId) {
    return <ConnectingScreen view={describeConnection({ kind: 'idle' })} title={tWorkbench('connecting.title')} />;
  }
  return (
    <WorkspaceProvider session={handle.session}>
      <ConnectionGate workspaceId={workspaceId} view={view} onReconnect={() => setAttempt((n) => n + 1)}>
        {view === 'console' ? <ConsoleShell /> : <Workbench />}
      </ConnectionGate>
    </WorkspaceProvider>
  );
}

export function ConnectionGate({ workspaceId, view, onReconnect, children }: { workspaceId: string; view: 'workbench' | 'console'; onReconnect(): void; children: ReactNode }) {
  const state = useConnectionState();
  const stores = useStores();
  const admitted = useStore(stores.workspace, (s) => s.generation > 0);
  const info = useWorkspaceInfo();
  const { recent } = useAppServices();
  const status = describeConnection(state);

  useEffect(() => {
    if (info) recent.remember({ id: workspaceId, name: info.name, hostName: info.hostName });
  }, [info, recent, workspaceId]);

  if (state.kind === 'key-mismatch') return <KeyMismatchScreen state={state} />;
  if (status.kind === 'login-required') {
    return <LoginRequiredScreen view={status} returnPath={routePath({ name: view === 'console' ? 'console' : 'workspace', workspaceId })} />;
  }
  if (status.blocking) {
    const reconnectable = state.kind === 'closed' && state.reason === 'local';
    return <ConnectionEndedScreen view={status} state={state} {...(reconnectable ? { onReconnect } : {})} />;
  }
  if (!admitted) return <ConnectingScreen view={status} title={tWorkbench('connecting.title')} />;
  return <>{children}</>;
}

/** /w/:id/console: the top bar and the host console (host only; others get an explanation). */
function ConsoleShell() {
  const isAdmin = useCan('admin');
  const state = useConnectionState();
  const { workspace } = useStores();
  const workspaceId = useStore(workspace, (s) => s.workspace?.id ?? '');
  useWorkspaceNotices();
  return (
    <div className="app-console" data-connection-state={state.kind}>
      <TopBar view="console" />
      <div className="app-banners">
        <ConnectionBanner state={state} />
      </div>
      <main className="app-console__main" aria-label={tWorkbench('console.title')}>
        {isAdmin ? (
          <SlotBoundary name={tWorkbench('console.title')}>
            <HostConsolePage />
          </SlotBoundary>
        ) : (
          <EmptyState
            title={tWorkbench('console.notHost.title')}
            description={tWorkbench('console.notHost.body')}
            action={
              workspaceId ? (
                <Link to={routePath({ name: 'workspace', workspaceId })} className="ui-button ui-button--secondary ui-button--md">
                  {tWorkbench('topbar.workbench')}
                </Link>
              ) : null
            }
          />
        )}
      </main>
    </div>
  );
}
