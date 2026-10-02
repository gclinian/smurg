// Every feature slot renders inside its own error boundary: a crash in the terminal must not take the editor, the
// connection indicators or the leave button with it.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tWorkbench } from '../../strings/workbench.ts';
import { Button, EmptyState } from '../../ui/index.ts';
import { IconAlertTriangle } from '../../ui/icons.tsx';

interface SlotBoundaryProps {
  /** The slot's name in the viewer's language ("Files"). */
  name: string;
  children: ReactNode;
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
    return (
      <div className="app-slot-error" role="alert">
        <EmptyState
          compact
          icon={<IconAlertTriangle size={20} />}
          title={tWorkbench('slot.error', { name: this.props.name })}
          description={tWorkbench('slot.errorBody')}
          action={
            <Button size="sm" onClick={() => this.setState({ failed: false })}>
              {tWorkbench('slot.retry')}
            </Button>
          }
        />
      </div>
    );
  }
}
