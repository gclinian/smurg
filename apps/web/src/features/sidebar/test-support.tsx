// Shared by the tests of features/sidebar: the left column in a workspace with a topic, its sessions and an inbox.
import { act, render } from '@testing-library/react';
import type { InboxItem, PlanInfo, Role, SessionInfo, Topic } from '@smurg/protocol';
import { buildAgentSession, buildTerminalSession, buildTopic } from '@smurg/protocol/testing';
import { useState, type ReactElement } from 'react';
import { vi } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import type { FeatureSlots } from '../../lib/slots.ts';
import { WorkspaceTestProviders, createTestWorkspace, type WorkspaceTestContext } from '../../testing/services.tsx';
import { answerLoads } from '../../testing/stores.ts';
import { Sidebar, type SidebarSection } from './Sidebar.tsx';

export const IAN = { userId: 'dev:host', displayName: 'Ian' };
export const MEI = { userId: 'dev:mei', displayName: 'Mei' };
const PLAN = { exists: true, valid: true, generating: false, stale: false, mode: 'assigned', paused: false, items: 6, started: 2, reviewed: 0, merged: 0 } as const;
export const TOPIC = buildTopic({ id: 'tp_1', name: 'Checkout redesign', phase: 'executing', discussionSessionId: 's_disc', spec: { exists: true }, plan: PLAN, createdAt: 20 });
export const SEARCH = buildTopic({ id: 'tp_2', name: 'Search filters', phase: 'discussing', createdAt: 10 });
export const DISCUSSION = buildAgentSession({ id: 's_disc', purpose: 'discussion', topicId: 'tp_1', topicName: 'Checkout redesign', openedBy: IAN, createdAt: 1 });
export const CART = buildAgentSession({ id: 'sess_a', purpose: 'item', topicId: 'tp_1', topicName: 'Checkout redesign', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, status: 'waiting-answer', responsible: IAN, openedBy: IAN, createdAt: 2 });
export const PAY = buildAgentSession({ id: 's_pay', purpose: 'item', topicId: 'tp_1', topicName: 'Checkout redesign', itemId: 'pay', item: { number: 2, title: 'Payment form' }, status: 'running', responsible: MEI, openedBy: IAN, createdAt: 3 });
export const FREE = buildAgentSession({ id: 's_free', title: 'Fix flaky CI test', status: 'waiting-permission', openedBy: MEI, createdAt: 5 });
export const TERMINAL = buildTerminalSession({ id: 's_term', openedBy: IAN, createdAt: 4 });

export interface SidebarData {
  sessions?: readonly SessionInfo[];
  topics?: readonly Topic[];
  inbox?: readonly InboxItem[];
  plans?: Readonly<Record<string, PlanInfo | null>>;
}

/** Answers the first loads (and every plan.get an unfolded topic asks) and waits for the stores. */
export async function load(context: WorkspaceTestContext, data: SidebarData = {}): Promise<void> {
  context.conn.handle('plan.get', ({ topicId }) => ({ plan: data.plans?.[topicId] ?? null }));
  await act(async () => {
    answerLoads(context.conn, {
      'session.list': { sessions: data.sessions ?? [DISCUSSION, CART, PAY, FREE, TERMINAL], hasMore: false },
      'topic.list': { topics: data.topics ?? [TOPIC, SEARCH], hasMore: false },
      'inbox.list': { items: data.inbox ?? [], hasMore: false },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** The left column with its folds as state, like the sessions view holds them. */
export function SidebarHarness({ collapsed = false }: { collapsed?: boolean }) {
  const [folded, setFolded] = useState(collapsed);
  const [open, setOpen] = useState<Record<SidebarSection, boolean>>({ inbox: true, sessions: true });
  return (
    <Sidebar
      collapsed={folded}
      onExpand={(section) => {
        setFolded(false);
        setOpen((previous) => ({ ...previous, [section]: true }));
      }}
      inboxOpen={open.inbox}
      sessionsOpen={open.sessions}
      onToggle={(section, next) => setOpen((previous) => ({ ...previous, [section]: next }))}
    />
  );
}

export interface MountOptions extends SidebarData {
  role?: Role;
  userId?: string;
  displayName?: string;
  slots?: readonly FeatureSlots[];
  ui?: ReactElement;
  collapsed?: boolean;
}

/** Renders the sidebar (or `ui`) in a loaded workspace; `opened` records what was asked to open in a column. */
export async function mountSidebar(options: MountOptions = {}) {
  const context = createTestWorkspace({
    role: options.role ?? 'host',
    userId: options.userId ?? (options.role === undefined || options.role === 'host' ? IAN.userId : 'dev:amy'),
    displayName: options.displayName ?? (options.role === undefined || options.role === 'host' ? 'Ian' : 'Amy'),
    ...(options.slots === undefined ? {} : { slots: options.slots }),
  });
  const opened = vi.fn<(payload: CommandMap['openColumn']) => void>();
  context.session.commands.handle('openColumn', opened);
  const view = render(<WorkspaceTestProviders context={context}>{options.ui ?? <SidebarHarness {...(options.collapsed === undefined ? {} : { collapsed: options.collapsed })} />}</WorkspaceTestProviders>);
  await load(context, options);
  return { ...view, ...context, opened };
}
