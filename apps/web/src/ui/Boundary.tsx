// Every slot a feature fills (a panel of code mode, a column, an overlay) renders inside its own error boundary: a
// crash in a terminal must not take the editor, the other columns, the connection indicators or the leave button
// with it.
//
// A slot whose CHUNK did not come (lib/chunks.ts: the web app was deployed again and the file is gone, or the network
// is) has not crashed: it shows the notice for that, with "Reload the page" and no "Show again" (a failed import
// stays failed). That notice is shown for a `silent` slot too: a dialog that never opens must not fail without a word.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, reportChunkFailure } from '../lib/chunks.ts';
import { tUi } from '../strings/ui.ts';
import { Button } from './Button.tsx';
import { ChunkNotice } from './ChunkNotice.tsx';
import { EmptyState } from './Feedback.tsx';
import { IconAlertTriangle } from './icons.tsx';

export interface SlotBoundaryProps {
  /** The slot's name in the viewer's language ("Files", "1 · Cart API"). */
  name: string;
  children: ReactNode;
  /**
   * Render nothing instead of the explanation when the slot crashed (an overlay that shows nothing by itself). A
   * chunk that did not come is still said: it goes to the workspace's banner (ui/ChunkNotice.tsx ChunkFailureBanner),
   * because a silent slot has no place of its own on the page.
   */
  silent?: boolean;
}

interface SlotBoundaryState {
  failed: boolean;
  error: unknown;
}

export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  override state: SlotBoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): SlotBoundaryState {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error)) {
      if (this.props.silent) reportChunkFailure(error);
      console.warn(`slot "${this.props.name}" could not be loaded (${error.reason})`, error.cause);
      return;
    }
    // Development aid only; nothing sensitive is in a render error.
    console.error(`slot "${this.props.name}" crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.silent) return null;
    if (isChunkLoadError(this.state.error)) return <ChunkNotice error={this.state.error} />;
    return (
      <div className="ui-slot-error" role="alert">
        <EmptyState
          compact
          icon={<IconAlertTriangle size={20} />}
          title={tUi('boundary.error', { name: this.props.name })}
          description={tUi('boundary.errorBody')}
          action={
            <Button size="sm" onClick={() => this.setState({ failed: false, error: null })}>
              {tUi('boundary.retry')}
            </Button>
          }
        />
      </div>
    );
  }
}
