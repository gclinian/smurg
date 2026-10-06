// Every slot a feature fills (a panel of code mode, a column, an overlay) renders inside its own error boundary: a
// crash in a terminal must not take the editor, the other columns, the connection indicators or the leave button
// with it.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tUi } from '../strings/ui.ts';
import { Button } from './Button.tsx';
import { EmptyState } from './Feedback.tsx';
import { IconAlertTriangle } from './icons.tsx';

export interface SlotBoundaryProps {
  /** The slot's name in the viewer's language ("Files", "1 · Cart API"). */
  name: string;
  children: ReactNode;
  /** Render nothing instead of the explanation when the slot crashed (an overlay that shows nothing by itself). */
  silent?: boolean;
}

interface SlotBoundaryState {
  failed: boolean;
}

export class SlotBoundary extends Component<SlotBoundaryProps, SlotBoundaryState> {
  override state: SlotBoundaryState = { failed: false };

  static getDerivedStateFromError(): SlotBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Development aid only; nothing sensitive is in a render error.
    console.error(`slot "${this.props.name}" crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className="ui-slot-error" role="alert">
        <EmptyState
          compact
          icon={<IconAlertTriangle size={20} />}
          title={tUi('boundary.error', { name: this.props.name })}
          description={tUi('boundary.errorBody')}
          action={
            <Button size="sm" onClick={() => this.setState({ failed: false })}>
              {tUi('boundary.retry')}
            </Button>
          }
        />
      </div>
    );
  }
}
