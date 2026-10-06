// Shared by the tests of features/columns: a workspace with a few sessions and a topic, and column bodies that show
// what the frame gave them.
import { act } from '@testing-library/react';
import type { SessionInfo, Topic } from '@smurg/protocol';
import { buildAgentSession, buildTerminalSession, buildTopic } from '@smurg/protocol/testing';
import { ColumnHeaderExtra, ColumnMenuItems, useColumn } from '../../lib/columns/context.tsx';
import type { ColumnBodyProps } from '../../lib/columns/target.ts';
import type { FeatureSlots } from '../../lib/slots.ts';
import { answerLoads } from '../../testing/stores.ts';
import type { WorkspaceTestContext } from '../../testing/services.tsx';

export const IAN = { userId: 'dev:host', displayName: 'Ian' };
export const TOPIC = buildTopic({ id: 't1', name: 'Checkout redesign', phase: 'executing', spec: { exists: true }, discussionSessionId: 's_disc' });
export const DISCUSSION = buildAgentSession({ id: 's_disc', purpose: 'discussion', topicId: 't1', topicName: 'Checkout redesign', openedBy: IAN, createdAt: 1 });
export const CART = buildAgentSession({ id: 's_cart', purpose: 'item', topicId: 't1', topicName: 'Checkout redesign', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, status: 'waiting-answer', openedBy: IAN, createdAt: 2 });
export const FREE = buildAgentSession({ id: 's_free', title: 'Fix flaky CI test', status: 'running', openedBy: IAN, createdAt: 3 });
export const TERMINAL = buildTerminalSession({ id: 's_term', openedBy: IAN, createdAt: 4 });

/** Answers the first loads of a rendered workspace and waits for the stores. */
export async function loadWorkspace(context: WorkspaceTestContext, data: { sessions?: readonly SessionInfo[]; topics?: readonly Topic[] } = {}): Promise<void> {
  await act(async () => {
    answerLoads(context.conn, {
      'session.list': { sessions: data.sessions ?? [DISCUSSION, CART, FREE, TERMINAL], hasMore: false },
      'topic.list': { topics: data.topics ?? [TOPIC], hasMore: false },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** A column body that shows what it was given: its props and what useColumn() says. */
function Probe({ kind, props }: { kind: string; props: object }) {
  const column = useColumn();
  return (
    <div data-testid={`body-${column.id}`} data-kind={kind} data-props={JSON.stringify(props)} data-focused={String(column.focused)} data-visible={String(column.visible)} data-place={column.place}>
      <span>{`${kind} body`}</span>
      {column.anchor ? (
        <button type="button" onClick={() => column.anchorShown()}>
          {`anchor ${column.anchor.cardId ?? column.anchor.seq}`}
        </button>
      ) : null}
    </div>
  );
}

export const ConversationProbe = (props: ColumnBodyProps['conversation']) => <Probe kind="conversation" props={props} />;
export const TerminalProbe = (props: ColumnBodyProps['terminal']) => <Probe kind="terminal" props={props} />;
export const SpecProbe = (props: ColumnBodyProps['spec']) => <Probe kind="spec" props={props} />;
export const ReportProbe = (props: ColumnBodyProps['report']) => <Probe kind="report" props={props} />;

/** A plan body that also adds to the header and its menu. */
export function PlanProbe(props: ColumnBodyProps['plan']) {
  const renamed: string[] = (globalThis as { __planMenu?: string[] }).__planMenu ?? [];
  return (
    <>
      <ColumnMenuItems items={[{ id: 'update', label: 'Update plan', onSelect: () => renamed.push(props.topicId) }]} />
      <ColumnHeaderExtra>
        <span>0 of 6 reviewed</span>
      </ColumnHeaderExtra>
      <Probe kind="plan" props={props} />
    </>
  );
}

export const PROBES: FeatureSlots = {
  feature: 'probes',
  columns: { conversation: ConversationProbe, terminal: TerminalProbe, spec: SpecProbe, plan: PlanProbe, report: ReportProbe },
};
