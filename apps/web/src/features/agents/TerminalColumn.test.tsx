// A plain terminal as a column of the sessions view, the feature's overlays (the handler of `newSession`, the dialogs
// a row's context menu asks for) and what it registers in the shell.
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { buildAgentSession } from '@smurg/protocol/testing';
import { capabilitiesForRole } from '../../lib/capabilities.ts';
import type { CommandMap } from '../../lib/commands.ts';
import { renderInColumn } from '../../testing/columns.tsx';
import { HOST_USER, makeMember, makeSession } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { terminalDialogs } from './requests.ts';
import { slots } from './slots.tsx';

/** The feature's overlay as the shell mounts it. */
const AgentsOverlays = slots.overlays?.[0] as ComponentType;
import TerminalColumn from './TerminalColumn.tsx';
import { bytes, installMatchMedia, nextRequest, recordingViewerFactory } from './test-support.tsx';
import { ViewerFactoryContext } from './viewer.ts';

const hostShell = makeSession({ id: 'sess_host', title: 'tests', openedBy: { userId: HOST_USER, displayName: 'Ian' } });
const amyShell = makeSession({ id: 'sess_amy', title: 'build', openedBy: { userId: 'dev:amy', displayName: 'Amy' } });

async function renderColumn(session: typeof hostShell, role: 'host' | 'agent' | 'editor' | 'viewer', visible = true) {
  installMatchMedia();
  const recording = recordingViewerFactory();
  const view = renderInColumn(
    <ViewerFactoryContext.Provider value={recording.factory}>
      <TerminalColumn sessionId={session.id} />
    </ViewerFactoryContext.Provider>,
    { target: { kind: 'session', sessionId: session.id }, role, visible },
  );
  await act(async () => {
    view.conn.respond('session.list', { sessions: [session], hasMore: false });
  });
  return { ...view, recording };
}

describe('terminal column', () => {
  it('attaches while the column is on screen, shows the output, and detaches when the column is hidden', async () => {
    const view = await renderColumn(hostShell, 'editor');
    const attach = await nextRequest(view.conn, 'session.attach');
    expect(attach.payload).toEqual({ sessionId: 'sess_host' });
    await act(async () => {
      view.conn.respond('session.attach', { session: hostShell, mode: 'snapshot', data: bytes('$ pnpm test'), cols: hostShell.cols, rows: hostShell.rows, nextOffset: 11 });
    });
    expect(screen.getByLabelText('About tests').textContent).toContain('By Ian');
    expect(screen.getByText('Watch only')).toBeTruthy();

    view.column.set({ visible: false });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(view.conn.notificationsOf('session.detach').map((notification) => notification.payload)).toEqual([{ sessionId: 'sess_host' }]);
  });

  it('"More actions" has Attach for everyone, End for the member who opened it, Terminate for the host', async () => {
    const mine = await renderColumn(hostShell, 'host');
    expect(mine.column.menuItems().map((item) => item.id)).toEqual(['attach', 'end']);
    act(() => mine.column.menuItems().find((item) => item.id === 'end')?.onSelect());
    const dialog = screen.getByRole('alertdialog', { name: 'End session' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'End session' }));
    expect(mine.conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_host' });
    mine.unmount();

    const theirs = await renderColumn(amyShell, 'host');
    expect(theirs.column.menuItems().map((item) => item.id)).toEqual(['attach', 'terminate']);
    theirs.unmount();

    const watcher = await renderColumn(hostShell, 'agent');
    expect(watcher.column.menuItems().map((item) => item.id)).toEqual(['attach']);
    act(() => watcher.column.menuItems()[0]?.onSelect());
    expect(screen.getByRole('dialog', { name: 'Attach to this session from your own terminal' })).toBeTruthy();
    watcher.unmount();

    const ended = await renderColumn({ ...hostShell, status: 'exited', exitCode: 0, endedAt: 5 }, 'host');
    expect(ended.column.menuItems().map((item) => item.id)).toEqual(['attach']);
    expect(screen.getByText('This session has ended. The terminal is read-only.')).toBeTruthy();
  });
});

describe('what the terminal feature keeps mounted in the shell', () => {
  it('"New session" opens a session without a topic and shows it in a column', async () => {
    const view = renderInWorkspace(<AgentsOverlays />, { role: 'agent' });
    const opened: CommandMap['openColumn'][] = [];
    view.session.commands.handle('openColumn', (payload) => {
      opened.push(payload);
    });
    // The handler is there with the page (slots.tsx); the dialog behind it loads on its own.
    expect(view.session.commands.has('newSession')).toBe(true);
    await act(async () => {
      await view.session.commands.dispatch('newSession', { kind: 'agent' });
    });
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
    expect(view.conn.lastRequest('session.create')?.payload).toEqual({ kind: 'agent', workspace: { mode: 'main' } });
    await act(async () => {
      view.conn.respond('session.create', { session: buildAgentSession({ id: 'sess_new' }) });
    });
    expect(opened).toEqual([{ target: { kind: 'session', sessionId: 'sess_new' } }]);
    expect(screen.queryByRole('dialog')).toBeNull();

    await act(async () => {
      await view.session.commands.dispatch('newSession', { kind: 'terminal' });
    });
    expect(await screen.findByRole('dialog', { name: 'New terminal' })).toBeTruthy();
  });

  it('a terminal row\'s context menu offers what the member may do, and its dialogs open from there', async () => {
    const env = (role: 'host' | 'agent' | 'viewer', userId: string, stores: object = {}) => ({ stores: stores as never, commands: {} as never, capabilities: capabilitiesForRole(role), member: makeMember({ userId, role }) });
    const menu = slots.menus?.session;
    expect(menu?.(hostShell, env('host', HOST_USER)).map((item) => item.id)).toEqual(['agents.attach', 'agents.end']);
    expect(menu?.(amyShell, env('host', HOST_USER)).map((item) => item.id)).toEqual(['agents.attach', 'agents.terminate']);
    expect(menu?.(hostShell, env('viewer', 'dev:leo')).map((item) => item.id)).toEqual(['agents.attach']);
    expect(menu?.({ ...hostShell, status: 'exited', exitCode: 0 }, env('host', HOST_USER)).map((item) => item.id)).toEqual(['agents.attach']);
    // An agent session's row is the conversation feature's.
    expect(menu?.(buildAgentSession(), env('host', HOST_USER))).toEqual([]);
    expect(slots.feature).toBe('agents');
    expect(slots.columns?.terminal).toBeDefined();

    const view = renderInWorkspace(<AgentsOverlays />, { role: 'host' });
    await act(async () => {
      view.conn.respond('session.list', { sessions: [amyShell], hasMore: false });
    });
    menu?.(amyShell, env('host', HOST_USER, view.stores)).find((item) => item.id === 'agents.terminate')?.onSelect();
    const dialog = await screen.findByRole('alertdialog', { name: 'Terminate session' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terminate' }));
    expect(view.conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_amy' });
    act(() => terminalDialogs(view.stores).setState({ kind: 'attach', sessionId: 'sess_amy' }));
    expect(await screen.findByRole('dialog', { name: 'Attach to this session from your own terminal' })).toBeTruthy();
  });
});
