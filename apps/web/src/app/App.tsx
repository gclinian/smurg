// The application: services, toasts and the four routes of ARCHITECTURE §9. The workspace route is a lazy chunk.
//
// Language switch: the route tree is keyed by the locale, so choosing another language re-mounts every page in it
// without a reload. Services, stores and the connection live outside React and are untouched (terminals re-attach as
// on any remount); component state (an open dialog, an unsent draft) is lost and a toast already on screen keeps its
// language: accepted.
import { lazy, Suspense } from 'react';
import { describeConnection } from '../lib/connection/status.ts';
import { localeStore } from '../lib/locale.ts';
import { useStore } from '../lib/store.ts';
import { tWorkbench } from '../strings/workbench.ts';
import { ToastProvider } from '../ui/index.ts';
import { ConnectingScreen } from './connection/screens.tsx';
import { useRoute } from './navigation.tsx';
import { JoinPage } from './pages/JoinPage.tsx';
import { LandingPage } from './pages/LandingPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { AppServicesProvider, type AppServices } from './services.tsx';

const WorkspaceRoute = lazy(() => import('./workspace/WorkspaceRoute.tsx'));

export function App({ services }: { services: AppServices }) {
  const locale = useStore(localeStore);
  return (
    <AppServicesProvider services={services}>
      <ToastProvider>
        <Routes key={locale} />
      </ToastProvider>
    </AppServicesProvider>
  );
}

function Routes() {
  const route = useRoute();
  switch (route.name) {
    case 'landing':
      return <LandingPage />;
    case 'join':
      return <JoinPage key={route.workspaceId} workspaceId={route.workspaceId} />;
    case 'workspace':
    case 'console':
      return (
        <Suspense fallback={<ConnectingScreen view={describeConnection({ kind: 'idle' })} title={tWorkbench('connecting.title')} />}>
          <WorkspaceRoute key={route.workspaceId} workspaceId={route.workspaceId} view={route.name === 'console' ? 'console' : 'workbench'} />
        </Suspense>
      );
    case 'not-found':
      return <NotFoundPage />;
  }
}
