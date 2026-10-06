// Closing an ended session's tab (a bug report, 2026-10-02: "there is no way to close a session that ended"; ARCHITECTURE §9): with a
// FakeConnection, the tab of an ENDED session has a close button with an accessible name, for every role; Delete on
// the tab and "Close tab" in the session's bar do the same; the tab shown and focused afterwards is the neighbour; it
// stays closed across a full resync and a new page load while the daemon still lists the session, and is forgotten
// once it does not; nothing is sent to the daemon; a RUNNING session is never closed. And the tab of an ended session
// that stayed open longer than the daemon keeps the session (15 minutes, §7.6) says so instead of offering a retry.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SmurgError, type TerminalSession } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { HOST_USER, WORKSPACE_ID, makeSession, makeWelcome } from '../../testing/fixtures.ts';
import { CLOSED_SESSIONS_KEY } from './closed-sessions.ts';
import { AgentsPanel, tabAfterClose } from './index.tsx';
import { nextRequest, renderWithSessions } from './test-support.tsx';


const running = makeSession({ id: 'sess_run', kind: 'terminal', title: 'keeper', openedBy: { userId: HOST_USER, displayName: 'Ian' }, createdAt: 1 });
const ended = (id: string, title: string, createdAt: number, more: Partial<TerminalSession> = {}): TerminalSession =>
  makeSession({ id, kind: 'terminal', title, openedBy: { userId: HOST_USER, displayName: 'Ian' }, createdAt, status: 'exited', exitCode: 0, endedAt: createdAt + 1, endReason: 'exit', ...more });
const first = ended('sess_first', 'first', 2);
const second = ended('sess_second', 'second', 3, { endReason: 'ended', endedBy: { userId: HOST_USER, displayName: 'Ian' } });
const third = ended('sess_third', 'third', 4, { endReason: 'terminated', endedBy: { userId: HOST_USER, displayName: 'Ian' } });

const tabTitles = (): string[] => screen.getAllByRole('tab').map((tab) => tab.querySelector('.agents-tab__title')?.textContent ?? '');
const tab = (title: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(`^${title} \\(`) });
const closeButton = (title: string): HTMLElement | null => screen.queryByRole('button', { name: `Close ${title} (Ian)` });
const selectedTitle = (): string | undefined => screen.getAllByRole('tab').find((item) => item.getAttribute('aria-selected') === 'true')?.querySelector('.agents-tab__title')?.textContent ?? undefined;
const storedClosed = (): unknown => JSON.parse(window.localStorage.getItem(CLOSED_SESSIONS_KEY) ?? 'null');

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('tabAfterClose', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('closing the shown tab shows the neighbour to the right, else the one to the left, else nothing', () => {
    expect(tabAfterClose(tabs, 'a', 'a')).toBe('b');
    expect(tabAfterClose(tabs, 'b', 'b')).toBe('c');
    expect(tabAfterClose(tabs, 'c', 'c')).toBe('b');
    expect(tabAfterClose([{ id: 'a' }], 'a', 'a')).toBeNull();
  });
  it('closing another tab keeps the shown one', () => {
    expect(tabAfterClose(tabs, 'a', 'c')).toBe('c');
    expect(tabAfterClose(tabs, 'x', 'b')).toBe('b');
    expect(tabAfterClose(tabs, 'a', null)).toBeNull();
  });
});

describe("agents panel: closing an ended session's tab", () => {
  it('every role gets a named close button on an ended session, and "Close tab" in its bar; a running session has neither', async () => {
    for (const role of ['viewer', 'editor', 'agent', 'host'] as const) {
      const view = await renderWithSessions(<AgentsPanel />, { role, sessions: [running, first] });
      expect(closeButton('first'), role).not.toBeNull();
      expect(closeButton('keeper'), role).toBeNull();
      // The running tab is shown first: its bar has no "Close tab", and the tab does not announce Delete.
      expect(selectedTitle()).toBe('keeper (Ian)');
      expect(within(screen.getByRole('tabpanel')).queryByRole('button', { name: 'Close tab' }), role).toBeNull();
      expect(tab('keeper').getAttribute('aria-keyshortcuts')).toBeNull();
      expect(tab('keeper').getAttribute('aria-description')).toBeNull();
      // The ended one: the button in the bar, and the tab says how to close it from the keyboard.
      fireEvent.click(tab('first'));
      expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Close tab' }), role).toBeTruthy();
      expect(tab('first').getAttribute('aria-keyshortcuts')).toBe('Delete');
      expect(tab('first').getAttribute('aria-description')).toBe('Press Delete to close this ended tab');
      // The close button is a sibling of the tab (a tab holds no other control) and names what it closes.
      expect(tab('first').contains(closeButton('first'))).toBe(false);
      expect(closeButton('first')?.getAttribute('title')).toBe('Close first (Ian)');
      view.unmount();
    }
  });

  it('closes the shown tab: the neighbour to the right is shown and focused; nothing is sent to the daemon and the session stays in the store', async () => {
    const { conn, stores } = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [running, first, second, third] });
    expect(tabTitles()).toEqual(['keeper (Ian)', 'first (Ian)', 'second (Ian)', 'third (Ian)']);
    fireEvent.click(tab('second'));
    await settle();
    const requestsBefore = conn.requests.length;
    const notificationsBefore = conn.notifications.length;

    fireEvent.click(closeButton('second')!);
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)', 'first (Ian)', 'third (Ian)']);
    expect(selectedTitle()).toBe('third (Ian)');
    expect(document.activeElement).toBe(tab('third'));
    // The focus shared with the suggestions panel follows the shown tab.
    expect(stores.sessions.getState().focusedId).toBe('sess_third');
    // Closing is a matter of this panel: the daemon is told nothing but that this viewer stopped watching.
    expect(conn.requests.slice(requestsBefore).map((request) => request.type).filter((type) => type !== 'session.attach' && type !== 'session.list')).toEqual([]);
    expect(conn.notifications.slice(notificationsBefore).map((notification) => notification.type).filter((type) => type !== 'session.detach')).toEqual([]);
    expect(stores.sessions.getState().sessions.get('sess_second')?.status).toBe('exited');
    expect(storedClosed()).toEqual({ [WORKSPACE_ID]: ['sess_second'] });

    // The last tab of the strip hands over to the one before it.
    fireEvent.click(closeButton('third')!);
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)', 'first (Ian)']);
    expect(selectedTitle()).toBe('first (Ian)');
    expect(document.activeElement).toBe(tab('first'));
  });

  it('closing a tab that is not the shown one keeps the shown tab, and the focus goes to it', async () => {
    const { stores } = await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [running, first, second] });
    expect(selectedTitle()).toBe('keeper (Ian)');
    fireEvent.click(closeButton('second')!);
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)', 'first (Ian)']);
    expect(selectedTitle()).toBe('keeper (Ian)');
    expect(document.activeElement).toBe(tab('keeper'));
    expect(stores.sessions.getState().focusedId).toBe('sess_run');
  });

  it('keyboard: Delete on an ended tab closes it, Delete on a running tab does nothing; only the shown tab’s close button is in the tab order', async () => {
    const { stores } = await renderWithSessions(<AgentsPanel />, { role: 'agent', sessions: [running, first, second] });
    // Roving tab order: the shown tab, then (for an ended one) its close button.
    expect(closeButton('first')?.getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(tab('keeper'), { key: 'ArrowRight' });
    expect(selectedTitle()).toBe('first (Ian)');
    expect(document.activeElement).toBe(tab('first'));
    expect(closeButton('first')?.getAttribute('tabindex')).toBe('0');
    expect(closeButton('second')?.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(tab('first'), { key: 'Delete' });
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);
    expect(selectedTitle()).toBe('second (Ian)');
    expect(document.activeElement).toBe(tab('second'));

    // A running session: Delete is not a way to end it (ending stays "End session" / "Terminate").
    fireEvent.keyDown(tab('second'), { key: 'Home' });
    expect(document.activeElement).toBe(tab('keeper'));
    const notPrevented = fireEvent.keyDown(tab('keeper'), { key: 'Delete' });
    await settle();
    expect(notPrevented).toBe(true);
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);
    expect(stores.sessions.getState().sessions.get('sess_run')?.status).toBe('running');
    // A middle click closes an ended tab like in the editor, never a running one.
    fireEvent(tab('keeper'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent(tab('second'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)']);
  });

  it('"Close tab" in the bar closes the ended session it belongs to; with no tab left the focus goes to "New session"', async () => {
    const { stores } = await renderWithSessions(<AgentsPanel />, { role: 'host', sessions: [first] });
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Close tab' }));
    await settle();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText('No sessions yet')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'New session' })[0]);
    expect(stores.sessions.getState().focusedId).toBeNull();
  });

  it('with every tab closed the empty panel says that ended sessions are hidden, and shows them again on request', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [first, second] });
    // Nothing is hidden yet: no such line next to the tabs.
    expect(screen.queryByTestId('agents-hidden-ended')).toBeNull();
    fireEvent.click(closeButton('first')!);
    await settle();
    // A tab is left: the line is for the EMPTY panel only.
    expect(screen.queryByTestId('agents-hidden-ended')).toBeNull();
    fireEvent.click(closeButton('second')!);
    await settle();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    const hidden = screen.getByTestId('agents-hidden-ended');
    expect(hidden.textContent).toContain('2 ended sessions are hidden because you closed their tabs.');
    const requestsBefore = conn.requests.length;
    fireEvent.click(within(hidden).getByRole('button', { name: 'Show ended sessions' }));
    await settle();
    expect(tabTitles()).toEqual(['first (Ian)', 'second (Ian)']);
    expect(screen.queryByTestId('agents-hidden-ended')).toBeNull();
    expect(window.localStorage.getItem(CLOSED_SESSIONS_KEY)).toBeNull();
    // Showing them is a matter of this panel too: the daemon is only asked for the terminal that is shown again.
    expect(conn.requests.slice(requestsBefore).map((request) => request.type).filter((type) => type !== 'session.attach' && type !== 'session.list')).toEqual([]);
  });

  it('one hidden session reads in the singular; a panel that never had a session shows no such line', async () => {
    const one = await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [first] });
    fireEvent.click(closeButton('first')!);
    await settle();
    expect(screen.getByTestId('agents-hidden-ended').textContent).toContain('1 ended session is hidden because you closed its tab.');
    one.unmount();
    window.localStorage.clear();
    await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [] });
    expect(screen.getByText('No sessions yet')).toBeTruthy();
    expect(screen.queryByTestId('agents-hidden-ended')).toBeNull();
  });

  it('a session that ends while it is shown gets the close controls then, not before', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [running] });
    expect(closeButton('keeper')).toBeNull();
    await act(async () => {
      conn.emit('session.state', { session: { ...running, status: 'exited', exitCode: 0, endedAt: 9, endReason: 'exit' } });
    });
    expect(closeButton('keeper')).not.toBeNull();
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Close tab' })).toBeTruthy();
  });

  it('stays closed across a full resync and a new page load while the daemon still lists the session; forgotten once it does not', async () => {
    const view = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [running, first, second] });
    fireEvent.click(closeButton('first')!);
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);

    // A reconnect that could not resume: the stores load again, the daemon lists the ended session again.
    await act(async () => {
      view.conn.admit(makeWelcome({ role: 'viewer', channelId: 'ch_2' }), { resumed: false });
    });
    // While the list reloads the panel keeps the last one: the closed tab is not part of it.
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);
    await act(async () => {
      view.conn.respond('session.list', { sessions: [running, first, second], hasMore: false });
    });
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);
    expect(storedClosed()).toEqual({ [WORKSPACE_ID]: ['sess_first'] });
    view.unmount();

    // A new page load (the same browser storage).
    const reloaded = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [running, first, second] });
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);
    // Someone else's panel (another browser: an empty storage) still has it — see the next test.
    // The daemon forgot the ended session (15 minutes after it ended): the next list no longer has it, and its id goes.
    await act(async () => {
      reloaded.conn.admit(makeWelcome({ role: 'viewer', channelId: 'ch_3' }), { resumed: false });
    });
    await act(async () => {
      reloaded.conn.respond('session.list', { sessions: [running, second], hasMore: false });
    });
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);
    expect(window.localStorage.getItem(CLOSED_SESSIONS_KEY)).toBeNull();
  });

  it("is a matter of one's own browser: a panel with another storage still shows the tab", async () => {
    const mine = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [running, first] });
    fireEvent.click(closeButton('first')!);
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)']);
    mine.unmount();
    window.localStorage.clear();
    await renderWithSessions(<AgentsPanel />, { role: 'host', sessions: [running, first] });
    expect(tabTitles()).toEqual(['keeper (Ian)', 'first (Ian)']);
  });

  it('a stored id never hides a session that runs (only an ended session can be closed), and is dropped', async () => {
    window.localStorage.setItem(CLOSED_SESSIONS_KEY, JSON.stringify({ [WORKSPACE_ID]: ['sess_run', 'sess_first'] }));
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [running, first] });
    expect(tabTitles()).toEqual(['keeper (Ian)']);
    expect(storedClosed()).toEqual({ [WORKSPACE_ID]: ['sess_first'] });
    // When it ends later its tab stays until this person closes it.
    await act(async () => {
      conn.emit('session.state', { session: { ...running, status: 'exited', exitCode: 0, endedAt: 9, endReason: 'exit' } });
    });
    expect(tabTitles()).toEqual(['keeper (Ian)']);
  });

  it('a closed session that is asked for by name (the focusSession command) is shown again', async () => {
    const { session, stores } = await renderWithSessions(<AgentsPanel />, { role: 'editor', sessions: [running, first, second] });
    fireEvent.click(tab('second'));
    fireEvent.click(closeButton('first')!);
    await settle();
    expect(tabTitles()).toEqual(['keeper (Ian)', 'second (Ian)']);
    expect(selectedTitle()).toBe('second (Ian)');
    await act(async () => {
      await session.commands.dispatch('focusSession', { sessionId: 'sess_first' });
    });
    expect(tabTitles()).toEqual(['keeper (Ian)', 'first (Ian)', 'second (Ian)']);
    expect(selectedTitle()).toBe('first (Ian)');
    expect(stores.sessions.getState().focusedId).toBe('sess_first');
    expect(window.localStorage.getItem(CLOSED_SESSIONS_KEY)).toBeNull();
  });

  it('an ended session the daemon no longer keeps: its terminal says so (nothing to retry), and the tab can be closed', async () => {
    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [first] });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      conn.fail('session.attach', new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' }));
    });
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByRole('status').textContent).toBe("This session ended a while ago, and the host's computer no longer keeps its terminal output. You can close this tab.");
    expect(panel.queryByText(/Could not connect to the terminal/)).toBeNull();
    expect(panel.queryByRole('button', { name: 'Reconnect the terminal' })).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Close tab' }));
    await settle();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('any other failed attach still offers the retry: a running session that is not found, an ended one that fails otherwise', async () => {
    const asViewer = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [running] });
    await nextRequest(asViewer.conn, 'session.attach');
    await act(async () => {
      asViewer.conn.fail('session.attach', new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' }));
    });
    expect(within(screen.getByRole('tabpanel')).getByRole('alert').textContent).toContain('Could not connect to the terminal: That session was not found.');
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Reconnect the terminal' })).toBeTruthy();
    asViewer.unmount();

    const { conn } = await renderWithSessions(<AgentsPanel />, { role: 'viewer', sessions: [first] });
    await nextRequest(conn, 'session.attach');
    await act(async () => {
      conn.fail('session.attach', new SmurgError('internal'));
    });
    expect(within(screen.getByRole('tabpanel')).getByRole('alert').textContent).toContain('Could not connect to the terminal: Something went wrong on the host.');
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Reconnect the terminal' })).toBeTruthy();
  });
});
