// The application: services, toasts and the routes of ARCHITECTURE §9. The workspace route is a lazy chunk; a boundary
// around the routes says so when it (or code mode's chunk) does not come, instead of an empty page (PageBoundary.tsx).
//
// Language switch: the route tree is keyed by the locale, so choosing another language re-mounts every page in it
// without a reload. Services, stores and the connection live outside React and are untouched (terminals re-attach as
// on any remount); component state (an open dialog, an unsent draft) is lost and a toast already on screen keeps its
// language: accepted.
import { Suspense } from 'react';
import { lazyChunk } from '../lib/chunks.ts';
import { describeConnection } from '../lib/connection/status.ts';
import { localeStore } from '../lib/locale.ts';
import { routePath, type Route } from '../lib/router.ts';
import { useStore } from '../lib/store.ts';
import { tWorkbench } from '../strings/workbench.ts';
import { ToastProvider } from '../ui/index.ts';
import { ConnectingScreen } from './connection/screens.tsx';
import { useRoute } from './navigation.tsx';
import { JoinPage } from './pages/JoinPage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { PageBoundary } from './PageBoundary.tsx';
import { AppServicesProvider, type AppServices } from './services.tsx';

const WorkspaceRoute = lazyChunk(() => import('./workspace/WorkspaceRoute.tsx'));

export function App({ services }: { services: AppServices }) {
  const locale = useStore(localeStore);
  return (
    <AppServicesProvider services={services}>
      <ToastProvider>
        <Pages key={locale} />
      </ToastProvider>
    </AppServicesProvider>
  );
}

function Pages() {
  const route = useRoute();
  // One page per address: the sessions view and code mode are two addresses of one element, and going back from a
  // code mode that did not load must show the sessions view again.
  return (
    <PageBoundary resetKey={route.name === 'not-found' ? `not-found:${route.pathname}` : routePath(route)}>
      <Routes route={route} />
    </PageBoundary>
  );
}

function Routes({ route }: { route: Route }) {
  switch (route.name) {
    case 'landing':
      return <LandingPage />;
    case 'join':
      return <JoinPage key={route.workspaceId} workspaceId={route.workspaceId} />;
    case 'workspace':
    case 'code':
    case 'console':
      // One element for the three views of a workspace: switching between the sessions view and code mode keeps
      // both mounted (the shell hides one), and the connection is the same in all three.
      return (
        <Suspense fallback={<ConnectingScreen view={describeConnection({ kind: 'idle' })} title={tWorkbench('connecting.title')} />}>
          <WorkspaceRoute
            key={route.workspaceId}
            workspaceId={route.workspaceId}
            view={route.name === 'workspace' ? 'sessions' : route.name}
            {...(route.name === 'console' && route.section !== undefined ? { section: route.section } : {})}
          />
        </Suspense>
      );
    case 'not-found':
      return <NotFoundPage />;
  }
}
