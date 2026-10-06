// The topic's dialogs as the shell mounts them (overlays), the items the feature adds to a topic's menu, and the
// inbox row it knows better.
import { SmurgError, unmergedError, type Role, type Topic } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildAgentSession, buildInboxItem, buildMergeRequest, buildPlan, buildReportSummary, buildTopic, buildWorkItem, buildWorktree } from '@smurg/protocol/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { capabilitiesForRole } from '../../lib/capabilities.ts';
import { COLUMN_KINDS } from '../../lib/columns/target.ts';
import { createSlotRegistry, type SlotEnv } from '../../lib/slots.ts';
import { makeMember } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { slots as worktreeSlots } from '../worktree/slots.tsx';
import { topicDialogs, type TopicDialog } from './dialogs.ts';
import { slots } from './slots.tsx';
import { admitAs, settle, topicConnection } from './testing/support.tsx';
import TopicOverlays from './TopicOverlays.tsx';

const TOPIC: Topic = buildTopic({ name: 'Checkout', phase: 'complete', discussionSessionId: 'sess_d', spec: { exists: true }, plan: { ...buildTopic().plan, exists: true, valid: true, items: 2, started: 2, reviewed: 2 } });
const PLAN = buildPlan({
  items: [
    buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API', state: 'reviewed', attempt: 1, report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr_1', status: 'merged', ready: false } }),
    buildWorkItem({ id: 'checkout-page', number: 2, title: 'Checkout page', state: 'reviewed', attempt: 1, report: buildReportSummary({ state: 'reviewed' }), merge: { requestId: 'mr_2', status: 'draft', ready: true } }),
  ],
});

async function setup(options: { role?: Role; topic?: Topic } = {}) {
  const topic = options.topic ?? TOPIC;
  const world = { role: options.role ?? ('agent' as Role), topics: topic.archived ? [] : [topic], plans: { [topic.id]: PLAN }, worktrees: [buildWorktree()], requests: [buildMergeRequest()] };
  const conn = topicConnection(world);
  if (topic.archived) conn.handle('topic.list', (payload) => ({ topics: payload.archived === true ? [topic] : [], hasMore: false }));
  const context = createTestWorkspace({ conn, admit: false });
  const openColumn = vi.fn();
  context.session.commands.handle('openColumn', openColumn);
  admitAs(conn, world);
  await settle();
  if (topic.archived) await act(async () => void (await context.stores.topics.loadArchived()));
  render(
    <WorkspaceTestProviders context={context}>
      <TopicOverlays />
    </WorkspaceTestProviders>,
  );
  const dialogs = topicDialogs(context.stores);
  const open = (dialog: TopicDialog): void => act(() => dialogs.open(dialog));
  await settle();
  return { ...context, conn, openColumn, dialogs, open };
}

describe('the topic overlays', () => {
  it('renders nothing until something opens a dialog; the command `newTopic` opens "New topic"', async () => {
    const { session, dialogs } = await setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      await session.commands.dispatch('newTopic', {});
    });
    expect(screen.getByRole('dialog', { name: 'New topic' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dialogs.getState()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('one dialog at a time: opening another replaces the first', async () => {
    const { open } = await setup();
    open({ kind: 'new' });
    open({ kind: 'rename', topicId: 'tp_1' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Rename topic' })).toBeTruthy();
  });

  it('rename: the name is prefilled, the folder stays, and the same name cannot be sent', async () => {
    const { conn, open, dialogs } = await setup();
    open({ kind: 'rename', topicId: 'tp_1' });
    const dialog = screen.getByRole('dialog', { name: 'Rename topic' });
    const name = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(name.value).toBe('Checkout');
    expect(within(dialog).getByText('The folder stays specs/checkout/.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Checkout redesign' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(conn.lastRequest('topic.rename')?.payload).toEqual({ topicId: 'tp_1', name: 'Checkout redesign' });
    await act(async () => {
      conn.respond('topic.rename', { topic: { ...TOPIC, name: 'Checkout redesign' } });
    });
    expect(dialogs.getState()).toBeNull();
  });

  it('archive lists reviewed items that are not merged, and asks about worktrees whose changes were never merged', async () => {
    const { conn, open, dialogs } = await setup();
    open({ kind: 'archive', topicId: 'tp_1' });
    await settle();
    const dialog = screen.getByRole('alertdialog', { name: 'Archive "Checkout"?' });
    expect(within(dialog).getByText('Reviewed, but not merged into the main workspace yet:')).toBeTruthy();
    expect(within(dialog).getByText('2 · Checkout page')).toBeTruthy();
    expect(within(dialog).queryByText('1 · Cart API')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive topic' }));
    expect(conn.lastRequest('topic.archive')?.payload).toEqual({ topicId: 'tp_1', archived: true });
    await act(async () => {
      conn.fail('topic.archive', unmergedError([{ itemId: 'checkout-page', worktreeId: 'wt_2', branch: 'smurg/checkout/checkout-page' }]));
    });
    expect(within(dialog).getByText('1 work item has changes that were never merged')).toBeTruthy();
    expect(within(dialog).getByText('smurg/checkout/checkout-page')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep them' }));
    expect(conn.lastRequest('topic.archive')?.payload).toEqual({ topicId: 'tp_1', archived: true, deleteUnmerged: false });
    await act(async () => {
      conn.respond('topic.archive', { topic: { ...TOPIC, archived: true } });
    });
    expect(await screen.findByText('Archived "Checkout".')).toBeTruthy();
    expect(dialogs.getState()).toBeNull();
  });

  it('"Delete them" sends the same request with deleteUnmerged: true; another refusal is shown', async () => {
    const { conn, open } = await setup();
    open({ kind: 'archive', topicId: 'tp_1' });
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive topic' }));
    await act(async () => {
      conn.fail('topic.archive', unmergedError([{ itemId: 'cart-api', worktreeId: 'wt_1', branch: 'b1' }, { itemId: 'gone-item', worktreeId: 'wt_2', branch: 'b2' }]));
    });
    expect(within(dialog).getByText('2 work items have changes that were never merged')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete them' }));
    expect(conn.lastRequest('topic.archive')?.payload).toEqual({ topicId: 'tp_1', archived: true, deleteUnmerged: true });
    await act(async () => {
      conn.fail('topic.archive', new SmurgError('forbidden', msg('topic.notStarted')));
    });
    expect(within(dialog).getByText('Could not archive the topic: Topics are not ready yet.')).toBeTruthy();
  });

  it('restart discussion asks first, then opens the new discussion', async () => {
    const { conn, open, openColumn } = await setup();
    open({ kind: 'restart', topicId: 'tp_1' });
    const dialog = screen.getByRole('alertdialog', { name: 'Restart the discussion?' });
    expect(within(dialog).getByText(/does not know what was said before/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart discussion' }));
    expect(conn.lastRequest('topic.discussion.restart')?.payload).toEqual({ topicId: 'tp_1' });
    await act(async () => {
      conn.respond('topic.discussion.restart', { topic: { ...TOPIC, discussionSessionId: 'sess_d2' }, session: buildAgentSession({ id: 'sess_d2', purpose: 'discussion', topicId: 'tp_1', topicName: 'Checkout' }) });
    });
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 'sess_d2' } });
  });

  it('the host deletes an archived topic; restoring asks nothing and says how it went', async () => {
    const archived = { ...TOPIC, archived: true };
    const { conn, open } = await setup({ role: 'host', topic: archived });
    open({ kind: 'delete', topicId: 'tp_1' });
    const dialog = screen.getByRole('alertdialog', { name: 'Delete "Checkout"?' });
    expect(within(dialog).getByText(/The files in specs\/checkout\/ stay in the project\. This cannot be undone\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete topic' }));
    expect(conn.lastRequest('topic.delete')?.payload).toEqual({ topicId: 'tp_1' });
    await act(async () => {
      conn.fail('topic.delete', new SmurgError('conflict', msg('topic.delete.openMerge')));
    });
    expect(within(dialog).getByText('Could not delete the topic: A merge request of this topic is still waiting. Decide it first.')).toBeTruthy();

    open({ kind: 'restore', topicId: 'tp_1' });
    expect(conn.lastRequest('topic.archive')?.payload).toEqual({ topicId: 'tp_1', archived: false });
    await act(async () => {
      conn.respond('topic.archive', { topic: TOPIC });
    });
    expect(await screen.findByText('Restored "Checkout".')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('"Show the changes" on its own, and the host’s "Merge…" as the diff review', async () => {
    const { conn, open } = await setup({ role: 'host' });
    open({ kind: 'changes', topicId: 'tp_1' });
    const changes = screen.getByRole('dialog', { name: 'Changes of the spec and the plan: Checkout' });
    await act(async () => {
      conn.respond('plan.changes', { files: [] });
    });
    expect(within(changes).getByText('Nothing changed in SPEC.md or PLAN.md.')).toBeTruthy();
    open({ kind: 'merge', requestId: 'mr_1' });
    expect(conn.lastRequest('worktree.merge.diff')?.payload).toEqual({ requestId: 'mr_1' });
    expect(screen.getByRole('dialog', { name: 'Review the merge request from Host' })).toBeTruthy();
  });

  it('a dialog whose topic was deleted under it closes', async () => {
    const { conn, open, dialogs } = await setup();
    open({ kind: 'rename', topicId: 'tp_1' });
    act(() => conn.emit('topic.removed', { topicId: 'tp_1' }));
    expect(dialogs.getState()).toBeNull();
  });
});

describe('what the topics feature registers with the shell', () => {
  const env = (role: Role): SlotEnv & { opened: () => TopicDialog | null } => {
    const context = createTestWorkspace({ role });
    return { stores: context.stores, commands: context.session.commands, capabilities: capabilitiesForRole(role), member: makeMember({ role }), opened: () => topicDialogs(context.stores).getState() };
  };

  it('registers the four topic columns, its overlay, and no kind another feature of the package claims', () => {
    const registry = createSlotRegistry([slots, worktreeSlots]);
    expect(registry.features).toEqual(['topics', 'worktree']);
    for (const kind of ['spec', 'plan', 'report', 'changes'] as const) expect(registry.column(kind)).not.toBeNull();
    expect(COLUMN_KINDS.filter((kind) => registry.column(kind) === null)).toEqual(['conversation', 'terminal']);
    expect(registry.overlays.map((overlay) => overlay.feature)).toEqual(['topics', 'worktree']);
  });

  it('the columns and the overlay load lazily and render inside a Suspense boundary', async () => {
    const world = { role: 'agent' as Role, topics: [TOPIC], plans: { tp_1: PLAN } };
    const conn = topicConnection(world);
    const context = createTestWorkspace({ conn, admit: false });
    admitAs(conn, world);
    const Overlay = slots.overlays?.[0] as React.ComponentType;
    render(
      <WorkspaceTestProviders context={context}>
        <Suspense fallback={null}>
          <Overlay />
        </Suspense>
      </WorkspaceTestProviders>,
    );
    await waitFor(() => expect(context.session.commands.has('newTopic')).toBe(true));
    await act(async () => {
      await context.session.commands.dispatch('newTopic', {});
    });
    expect(screen.getByRole('dialog', { name: 'New topic' })).toBeTruthy();
  });

  it('a topic’s menu by role: rename, restart, archive; an archived topic: restore, and delete for the host', () => {
    const ids = (role: Role, topic: Topic): string[] => (slots.menus?.topic?.(topic, env(role)) ?? []).map((item) => item.id);
    expect(ids('host', TOPIC)).toEqual(['topic-rename', 'topic-restart', 'topic-archive']);
    expect(ids('agent', TOPIC)).toEqual(['topic-rename', 'topic-restart', 'topic-archive']);
    expect(ids('editor', TOPIC)).toEqual([]);
    expect(ids('viewer', TOPIC)).toEqual([]);
    expect(ids('host', { ...TOPIC, archived: true })).toEqual(['topic-restore', 'topic-delete']);
    expect(ids('agent', { ...TOPIC, archived: true })).toEqual(['topic-restore']);
    expect(ids('editor', { ...TOPIC, archived: true })).toEqual([]);
    const host = env('host');
    const items = slots.menus?.topic?.(TOPIC, host) ?? [];
    expect(items.map((item) => item.label)).toEqual(['Rename topic', 'Restart discussion', 'Archive topic']);
    items[2]?.onSelect();
    expect(host.opened()).toEqual({ kind: 'archive', topicId: 'tp_1' });
  });

  it('the row of an item that did not start offers "Start again" to those who may start', () => {
    const base = { title: '2 · Payment form did not start', where: 'Checkout' };
    const item = buildInboxItem('attention', { subject: 'item-not-started', topicId: 'tp_1', itemId: 'payment-form', item: { number: 2, title: 'Payment form' } });
    const agent = env('agent');
    const row = slots.inboxRows?.attention?.(item, base, agent);
    expect(row).toMatchObject({ ...base, action: { id: 'start-again', label: 'Start again' } });
    void row?.action?.run();
    expect(agent.opened()).toEqual({ kind: 'start', topicId: 'tp_1', itemIds: ['payment-form'] });
    expect(slots.inboxRows?.attention?.(item, base, env('editor'))).toBe(base);
    const stalled = buildInboxItem('attention', { subject: 'item-stalled', topicId: 'tp_1', itemId: 'payment-form', item: { number: 2, title: 'Payment form' } });
    expect(slots.inboxRows?.attention?.(stalled, base, agent)).toBe(base);
  });
});
