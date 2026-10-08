// The boundary around the routes: what reaches it would otherwise empty the page (React unmounts everything when
// nothing catches a render error).
//
// What reaches it in practice is a ROUTE whose chunk did not come: the workspace page (opened from the landing or the
// join page of a tab that was loaded before the web app was deployed again) and code mode (lib/chunks.ts says why the
// file did not come). The page then says so with the same words as a slot does (ui/ChunkNotice.tsx) and offers the
// reload. Anything else that reaches it is a bug in the page: said plainly, with the reload too.
//
// The boundary lets go when the route changes (the back button, a link): the pages that are loaded keep working.
import { Component, useId, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, type ChunkLoadError } from '../lib/chunks.ts';
import { tUi } from '../strings/ui.ts';
import { ChunkNoticeIcon, ReloadButton, chunkNoticeText } from '../ui/index.ts';
import { IconAlertCircle } from '../ui/icons.tsx';
import { FullPage } from './connection/screens.tsx';

export interface PageBoundaryProps {
  /** Changes when the person goes to another page: a boundary that caught something lets go. */
  resetKey: string;
  children: ReactNode;
}

interface PageBoundaryState {
  failed: boolean;
  error: unknown;
}

export class PageBoundary extends Component<PageBoundaryProps, PageBoundaryState> {
  override state: PageBoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): PageBoundaryState {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error)) console.warn(`the page could not be loaded (${error.reason})`, error.cause);
    // Development aid only; nothing sensitive is in a render error.
    else console.error('the page crashed', error, info.componentStack);
  }

  override componentDidUpdate(previous: PageBoundaryProps): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false, error: null });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return isChunkLoadError(this.state.error) ? <PageNotLoaded error={this.state.error} /> : <PageCrashed />;
  }
}

function PageNotLoaded({ error }: { error: ChunkLoadError }) {
  const titleId = useId();
  const bodyId = useId();
  const { title, body } = chunkNoticeText(error.reason);
  return (
    <FullPage tone="warning" role="alertdialog" labelledBy={titleId} describedBy={bodyId} testId="page-not-loaded">
      <div className="app-fullpage__icon">
        <ChunkNoticeIcon reason={error.reason} size={32} />
      </div>
      <h1 id={titleId}>{title}</h1>
      <p id={bodyId} className="app-fullpage__body" data-chunk-failure={error.reason}>
        {body}
      </p>
      <div className="app-fullpage__actions">
        <ReloadButton size="md" />
      </div>
    </FullPage>
  );
}

function PageCrashed() {
  const titleId = useId();
  const bodyId = useId();
  return (
    <FullPage tone="danger" role="alertdialog" labelledBy={titleId} describedBy={bodyId} testId="page-crashed">
      <div className="app-fullpage__icon app-fullpage__icon--danger">
        <IconAlertCircle size={32} />
      </div>
      <h1 id={titleId}>{tUi('page.crashed.title')}</h1>
      <p id={bodyId} className="app-fullpage__body">
        {tUi('page.crashed.body')}
      </p>
      <div className="app-fullpage__actions">
        <ReloadButton size="md" />
      </div>
    </FullPage>
  );
}
