import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App.tsx';
import { WORKSPACE_ID, makeWelcome, presenceOf } from '../../testing/fixtures.ts';
import { createTestServices } from '../../testing/services.tsx';
import { AMY, BOB, HOST, asMember, renderConsole } from './test-support.tsx';


/** The risk text the host confirms before handing out agent access (owner decision 2026-10-01), word for word. */
const RISK =
  'Anyone with agent access can have an agent run any command on your computer, read the files in your home directory and use your Claude account. Give it only to people you fully trust.';

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe('host console: access', () => {
  it('non-hosts cannot reach the console: the route explains instead, and nothing asks the daemon for admin data', async () => {
    const services = createTestServices({ path: `/w/${WORKSPACE_ID}/console` });
    render(<App services={services} />);
    // The workspace route is a lazy chunk: its first load can take seconds on a busy machine.
    await waitFor(() => expect(services.connections).toHaveLength(1), { timeout: 15_000 });
    const { conn } = services.connections[0]!;
    act(() => conn.admit(makeWelcome({ role: 'agent' })));
    expect(await screen.findByText('Only the host can use the console', undefined, { timeout: 15_000 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Host console' })).toBeNull();
    expect(conn.requests.filter((request) => request.type.startsWith('admin.'))).toEqual([]);
  });

  it('non-hosts cannot reach the console: the page itself refuses too (defence in depth)', async () => {
    for (const role of ['agent', 'editor', 'viewer'] as const) {
      const view = renderConsole({ role });
      await settle();
      expect(screen.getByText('Only the host can use the console')).toBeTruthy();
      expect(screen.getByText(new RegExp(`Your role is ${role === 'agent' ? 'Agent access' : role === 'editor' ? 'Editor' : 'Viewer'}\\.`))).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
      expect(view.conn.requests.filter((request) => request.type.startsWith('admin.'))).toEqual([]);
      view.unmount();
    }
  });

  it('the host gets ONE screen with the security notes and every section', async () => {
    renderConsole();
    expect(await screen.findByRole('heading', { level: 1, name: 'Host console' })).toBeTruthy();
    const notes = screen.getByText('Security notes for the host').closest('.ui-banner') as HTMLElement;
    expect(within(notes).getByText(/^Every session, including the ones opened by members with agent access, runs on your computer as you, without a sandbox/)).toBeTruthy();
    expect(within(notes).getByText('Give agent access only to people you fully trust. Make everyone else an editor or a viewer.')).toBeTruthy();
    expect(within(notes).getByText(/prompt injection/)).toBeTruthy();
    expect(within(notes).getByText(/^Keep the permission prompts of Claude Code on/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Members (3)' })).toBeTruthy());
    for (const name of ['All sessions (2)', 'Pending suggestions (1)', 'Merge requests', 'Invite links', 'Audit log', 'Settings']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    // The in-page navigation moves focus to a section without touching the URL.
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Console sections' })).getByRole('button', { name: 'Audit log' }));
    expect(document.activeElement?.textContent).toBe('Audit log');
  });
});

describe('host console: members', () => {
  it('shows online state, role, devices and what each member is doing', async () => {
    const view = renderConsole();
    await screen.findByText('amy-laptop (terminal)');
    act(() =>
      view.conn.emit('presence.state', {
        members: [presenceOf(asMember(HOST)), presenceOf(asMember(AMY), { connections: 2, activeFile: { root: { kind: 'main' }, path: 'src/login.tsx' } }), presenceOf(asMember(BOB), { online: false, connections: 0 })],
        agents: [],
      }),
    );
    const table = screen.getAllByRole('table')[0]!;
    const amyRow = within(table).getByText('Amy').closest('tr') as HTMLElement;
    expect(within(amyRow).getByText('Online (2 connections)')).toBeTruthy();
    expect(within(amyRow).getByText('Chrome (browser)')).toBeTruthy();
    expect(within(amyRow).getByText('Viewing src/login.tsx · 1 session running')).toBeTruthy();
    const amyRole = within(amyRow).getByLabelText('Role of Amy') as HTMLSelectElement;
    expect(amyRole.value).toBe('agent');
    // The role list names the three roles a host hands out.
    expect([...amyRole.options].map((option) => option.textContent)).toEqual(['Agent access', 'Editor', 'Viewer']);
    const bobRow = within(table).getByText('Bob').closest('tr') as HTMLElement;
    expect(within(bobRow).getByText('Offline')).toBeTruthy();
    expect(within(bobRow).getByText('Revoked')).toBeTruthy();
    expect(within(bobRow).getByText('Nothing in progress')).toBeTruthy();
    const hostRow = within(table).getByText('Ian').closest('tr') as HTMLElement;
    expect(within(hostRow).getByText('(you)')).toBeTruthy();
    expect(within(hostRow).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(hostRow).queryByRole('combobox')).toBeNull();
  });

  it('changing a role sends admin.member.setRole and reflects the result and the error', async () => {
    const view = renderConsole();
    const select = (await screen.findByLabelText('Role of Bob')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'editor' } });
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:bob', role: 'editor' });
    expect(select.disabled).toBe(true);
    await act(async () => {
      view.conn.respond('admin.member.setRole', { member: { ...asMember(BOB), role: 'editor' } });
    });
    expect(select.value).toBe('editor');
    expect(select.disabled).toBe(false);
    expect(screen.getByText('The role of Bob is now Editor. They reconnect automatically with the new permissions.')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'viewer' } });
    await act(async () => {
      view.conn.fail('admin.member.setRole', new SmurgError('not_found', msg('member.notFound'), { reason: 'unknown-member' }));
    });
    expect(screen.getByText('Could not change the role of Bob: That member was not found.')).toBeTruthy();
    expect(select.value).toBe('editor');
  });

  it('choosing agent access for a member shows the risk first; nothing is sent until the host confirms', async () => {
    const view = renderConsole();
    const select = (await screen.findByLabelText('Role of Bob')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'agent' } });
    const dialog = screen.getByRole('alertdialog', { name: 'Give Bob agent access?' });
    expect(within(dialog).getByTestId('role-risk-text').textContent).toBe(RISK);
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    // The select still shows the role in force.
    expect(select.value).toBe('viewer');
    // Cancel changes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    // Confirmed: the role is applied.
    fireEvent.change(select, { target: { value: 'agent' } });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'I understand, change the role' }));
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:bob', role: 'agent' });
    await act(async () => {
      view.conn.respond('admin.member.setRole', { member: { ...asMember(BOB), role: 'agent' } });
    });
    expect(screen.getByText('The role of Bob is now Agent access. They reconnect automatically with the new permissions.')).toBeTruthy();
  });

  it('taking agent access from a member who opened sessions asks first, because those sessions end', async () => {
    const view = renderConsole();
    fireEvent.change(await screen.findByLabelText('Role of Amy'), { target: { value: 'viewer' } });
    const dialog = screen.getByRole('alertdialog', { name: 'Change the role of Amy?' });
    expect(within(dialog).getByText('Amy has 1 session open. With the role Viewer they can no longer use agents: this session will end.')).toBeTruthy();
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:amy', role: 'viewer' });
  });

  it('the host can terminate any session or remove any member from the console with one click — remove: one click, a confirmation that says what happens, then admin.member.kick', async () => {
    const view = renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Amy' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Amy?' });
    expect(within(dialog).getByText('Every session Amy opened ends at once (1 session right now).')).toBeTruthy();
    expect(within(dialog).getByText(/^The keys of all devices of Amy are revoked/)).toBeTruthy();
    // No guest directory or Claude login of the member exists on the host's computer any more.
    expect(dialog.textContent).not.toMatch(/temporary|sandbox|login data/i);
    expect(within(dialog).getByText(/^This cannot be undone/)).toBeTruthy();
    expect(view.conn.requestsOf('admin.member.kick')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Amy' }));
    expect(view.conn.lastRequest('admin.member.kick')?.payload).toEqual({ userId: 'dev:amy' });
    await act(async () => {
      view.conn.fail('admin.member.kick', new SmurgError('internal'));
    });
    expect(within(dialog).getByText('Could not remove Amy: Something went wrong on the host.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Amy' }));
    view.fixture.members = view.fixture.members.filter((member) => member.userId !== 'dev:amy');
    const listsBefore = view.conn.requestsOf('admin.member.list').length;
    await act(async () => {
      view.conn.respond('admin.member.kick', {});
    });
    expect(await screen.findByText('Amy was removed.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.member.list').length).toBe(listsBefore + 1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Amy' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Members (2)' })).toBeTruthy();
  });
});

describe('host console: sessions and suggestions', () => {
  it('shows every session with status, who opened it, where it runs and what its agent is doing (no sandbox column)', async () => {
    const view = renderConsole();
    const table = (await screen.findByText('login page')).closest('table') as HTMLElement;
    const amy = within(table).getByText('login page').closest('tr') as HTMLElement;
    expect(within(amy).getByText('Amy')).toBeTruthy();
    expect(within(amy).getByText('Running')).toBeTruthy();
    expect(within(amy).getByText("Amy's worktree (login page)")).toBeTruthy();
    expect(within(table).queryByText(/sandbox/i)).toBeNull();
    expect(within(table).getByRole('columnheader', { name: 'Opened by' })).toBeTruthy();
    expect(within(amy).getByText('2 connections')).toBeTruthy();
    act(() =>
      view.conn.emit('presence.state', {
        members: [],
        agents: [{ sessionId: 'sess_amy', ownerUserId: 'dev:amy', displayName: 'Claude (Amy)', color: '#3b82f6', status: 'running', activeFile: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'src/login.tsx' } }],
      }),
    );
    expect(within(amy).getByText('Working on src/login.tsx')).toBeTruthy();
    const host = within(table).getByText('Claude').closest('tr') as HTMLElement;
    expect(within(host).getByText('Main workspace')).toBeTruthy();
    // Exited sessions are behind a toggle.
    expect(within(table).queryByText('old shell')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show ended sessions (1)' }));
    expect(screen.getByText('Ended (exit code 0)')).toBeTruthy();
  });

  it('the host can terminate any session or remove any member from the console with one click — terminate: one click sends admin.session.terminate and reports the outcome', async () => {
    const view = renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: 'Terminate "login page", opened by Amy' }));
    expect(view.conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_amy' });
    await act(async () => {
      view.conn.fail('admin.session.terminate', new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' }));
    });
    expect(screen.getByText('Could not terminate login page: That session was not found.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Terminate "login page", opened by Amy' }));
    await act(async () => {
      view.conn.respond('admin.session.terminate', {});
    });
    expect(screen.getByText('Terminated "login page", opened by Amy.')).toBeTruthy();
    act(() => view.conn.emit('session.state', { session: { ...view.fixture.sessions[1]!, status: 'exited', exitCode: 137, endedAt: Date.now() } }));
    expect(screen.queryByRole('button', { name: 'Terminate "login page", opened by Amy' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'All sessions (1)' })).toBeTruthy();
  });

  it('lists pending suggestions across all sessions, read-only', async () => {
    const view = renderConsole();
    const section = (await screen.findByRole('heading', { name: 'Pending suggestions (1)' })).closest('section') as HTMLElement;
    expect(within(section).getByText('Ian → login page, opened by Amy')).toBeTruthy();
    expect(within(section).getByText('Add tests for the form validation first')).toBeTruthy();
    expect(within(section).queryByText('A suggestion handled before')).toBeNull();
    expect(within(section).queryByRole('button')).toBeNull();
    act(() => view.conn.emit('suggest.updated', { suggestion: { ...view.fixture.suggestions[0]!, status: 'rejected', resolvedAt: Date.now() } }));
    expect(within(section).getByText('No pending suggestions.')).toBeTruthy();
  });

  it('shows the merge requests with the review action', async () => {
    renderConsole();
    const section = (await screen.findByRole('heading', { level: 2, name: 'Merge requests' })).closest('section') as HTMLElement;
    expect(await within(section).findByText('Merge request from Amy')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Review' })).toBeTruthy();
  });
});
