import { CONSOLE_SECTIONS, MAIN_ROOT, SmurgError } from '@smurg/protocol';
import { buildInboxItem } from '@smurg/protocol/testing';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../app/App.tsx';
import { HOST_USER, WORKSPACE_ID, makeWelcome, presenceOf } from '../../testing/fixtures.ts';
import { createTestServices } from '../../testing/services.tsx';
import { SECTION_ORDER } from './index.tsx';
import { losesAgentAccess, losesDiscuss, memberStake } from './MembersSection.tsx';
import { purposeLabel, statusView } from './SessionsSection.tsx';
import { AMY, BOB, DISCUSSION, FREE, HOST, ITEM, asMember, defaultFixture, renderConsole, topicFixture } from './test-support.tsx';

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
    expect(within(notes).getByText(/^Read what an agent asks permission for before you allow it/)).toBeTruthy();
    // Whose Claude account a group may use (OWNER-DECISIONS Q6), and who reads the conversations.
    expect(
      within(notes).getByText(
        'Agents here use your Claude Code login. A personal Pro or Max subscription is for your own use: when other people work with agents here, use an API key or a Team or Enterprise plan.',
      ),
    ).toBeTruthy();
    expect(within(notes).getByText(/^Every member can read every conversation, also the ones of archived topics/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Members (3)' })).toBeTruthy());
    const headings = ['Members (3)', 'All sessions (2)', 'Pending suggestions (0)', 'Merge requests', 'Invite links', 'Claude Code project settings', 'My own Claude Code rules', 'Settings', 'Audit log'];
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(headings);
    // The in-page navigation moves focus to a section without touching the URL.
    const nav = within(screen.getByRole('navigation', { name: 'Console sections' }));
    expect(nav.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Members',
      'All sessions',
      'Pending suggestions',
      'Merge requests',
      'Invite links',
      'Claude Code project settings',
      'My own Claude Code rules',
      'Settings',
      'Audit log',
    ]);
    fireEvent.click(nav.getByRole('button', { name: 'Audit log' }));
    expect(document.activeElement?.textContent).toBe('Audit log');
  });

  it('every console section of the wire is on the page once, and the route\'s section gets the focus (what an inbox item of the host opens)', async () => {
    expect([...SECTION_ORDER].sort()).toEqual([...CONSOLE_SECTIONS].sort());
    for (const [section, heading] of [
      ['sessions', 'All sessions (2)'],
      ['claude-config', 'Claude Code project settings'],
      ['host-rules', 'My own Claude Code rules'],
    ] as const) {
      const view = renderConsole({ section });
      await screen.findByRole('heading', { level: 1, name: 'Host console' });
      await waitFor(() => expect(document.activeElement?.textContent).toBe(heading));
      expect(document.activeElement?.closest('section')?.id).toBe(`console-${section}`);
      view.unmount();
    }
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

    // Back to viewer takes the right to vote away: confirmed first (see below), then sent.
    fireEvent.change(select, { target: { value: 'viewer' } });
    const demote = screen.getByRole('alertdialog', { name: 'Change the role of Bob to Viewer?' });
    // Bob is responsible for nothing: the sentence names no number.
    expect(within(demote).getByText('A viewer only watches: the votes of Bob leave open questions, and Bob can no longer be responsible for a session.')).toBeTruthy();
    fireEvent.click(within(demote).getByRole('button', { name: 'Change role' }));
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
    const view = renderConsole({ fixture: topicFixture() });
    fireEvent.change(await screen.findByLabelText('Role of Amy'), { target: { value: 'editor' } });
    const dialog = screen.getByRole('alertdialog', { name: 'Change the role of Amy to Editor?' });
    // What ends, what passes to the host and what is removed (DESIGN §3.9), with today's numbers: Amy opened a
    // terminal and a session without a topic, and started one work item.
    expect(within(dialog).getByText('The terminals and the sessions without a topic that Amy opened end (2 sessions right now).')).toBeTruthy();
    expect(within(dialog).getByText('The topic sessions Amy started (discussions and work items) pass to you and keep running (1 session right now).')).toBeTruthy();
    expect(within(dialog).getByText(/^What Amy put in place is removed: the kinds of commands they always allowed, the work items they started that have not begun/)).toBeTruthy();
    // An editor still votes and may stay responsible: nothing about that is said.
    expect(within(dialog).queryByText(/A viewer only watches/)).toBeNull();
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:amy', role: 'editor' });
  });

  it('making a member a viewer says that their votes and their responsibility go, also when they never had agent access', async () => {
    const fixture = topicFixture();
    const EVE = { ...AMY, userId: 'dev:eve', displayName: 'Eve', role: 'editor' as const };
    fixture.members = [...fixture.members, EVE];
    fixture.sessions = fixture.sessions.map((session) => (session.id === 'sess_disc' && session.kind === 'agent' ? { ...session, responsible: { userId: 'dev:eve', displayName: 'Eve' } } : session));
    const view = renderConsole({ fixture });
    fireEvent.change(await screen.findByLabelText('Role of Eve'), { target: { value: 'viewer' } });
    const dialog = screen.getByRole('alertdialog', { name: 'Change the role of Eve to Viewer?' });
    expect(within(dialog).getByText('A viewer only watches: the votes of Eve leave open questions, and Eve is no longer responsible for anything (1 session right now).')).toBeTruthy();
    // An editor had no agent access to lose.
    expect(within(dialog).queryByText(/pass to you/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(view.conn.requestsOf('admin.member.setRole')).toHaveLength(0);

    // Agent access → viewer loses both; viewer → editor loses nothing and applies at once.
    fireEvent.change(screen.getByLabelText('Role of Amy'), { target: { value: 'viewer' } });
    const both = screen.getByRole('alertdialog', { name: 'Change the role of Amy to Viewer?' });
    expect(within(both).getByText(/^The terminals and the sessions without a topic that Amy opened end/)).toBeTruthy();
    expect(within(both).getByText(/^A viewer only watches: the votes of Amy leave open questions/)).toBeTruthy();
    fireEvent.click(within(both).getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Role of Bob'), { target: { value: 'editor' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.lastRequest('admin.member.setRole')?.payload).toEqual({ userId: 'dev:bob', role: 'editor' });
  });

  it('what a member has at stake is counted from the live sessions: what ends, what passes to the host, what they are responsible for', () => {
    const sessions = topicFixture().sessions;
    expect(memberStake('dev:amy', sessions)).toEqual({ ending: 2, passing: 1, responsibleFor: 1 });
    expect(memberStake(HOST_USER, sessions)).toEqual({ ending: 1, passing: 1, responsibleFor: 1 });
    expect(memberStake('dev:bob', sessions)).toEqual({ ending: 0, passing: 0, responsibleFor: 0 });
    // Ended sessions count for nothing.
    expect(memberStake('dev:amy', [{ ...ITEM, status: 'ended', endedAt: 1 }])).toEqual({ ending: 0, passing: 0, responsibleFor: 0 });
    expect([losesAgentAccess('agent', 'editor'), losesAgentAccess('agent', 'viewer'), losesAgentAccess('editor', 'viewer'), losesAgentAccess('viewer', 'editor')]).toEqual([true, true, false, false]);
    expect([losesDiscuss('agent', 'editor'), losesDiscuss('agent', 'viewer'), losesDiscuss('editor', 'viewer'), losesDiscuss('viewer', 'editor')]).toEqual([false, true, true, false]);
  });

  it('the host can terminate any session or remove any member from the console with one click — remove: one click, a confirmation that says what happens, then admin.member.kick', async () => {
    const view = renderConsole({ fixture: topicFixture() });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Amy' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Amy?' });
    // What ends, what passes to the host STOPPED, what is removed (DESIGN §3.9).
    expect(within(dialog).getByText('Every terminal and every session without a topic that Amy opened ends at once (2 sessions right now).')).toBeTruthy();
    expect(
      within(dialog).getByText(
        "The topic sessions Amy started (discussions and work items) are stopped and pass to you: the agent's turn is interrupted, and its open questions and permission requests are withdrawn (1 session right now).",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        'What Amy put in place is removed: the kinds of commands they always allowed, the work items they started that have not begun, a permission mode they loosened, their messages that still wait for an agent, and their votes on open questions.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Amy is no longer responsible for anything (1 session right now): its questions are then decided by whoever started it, or by you.')).toBeTruthy();
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
  it('shows every session with status, who opened it and where it runs (no sandbox column)', async () => {
    renderConsole();
    const table = (await screen.findByText('login page')).closest('table') as HTMLElement;
    const amy = within(table).getByText('login page').closest('tr') as HTMLElement;
    expect(within(amy).getByText('Amy')).toBeTruthy();
    expect(within(amy).getByText('Running')).toBeTruthy();
    expect(within(amy).getByText("Amy's worktree (login page)")).toBeTruthy();
    expect(within(table).queryByText(/sandbox/i)).toBeNull();
    expect(within(table).getByRole('columnheader', { name: 'Opened by' })).toBeTruthy();
    expect(within(amy).getByText('2 connections watching')).toBeTruthy();
    const host = within(table).getByText('Claude').closest('tr') as HTMLElement;
    expect(within(host).getByText('Main workspace')).toBeTruthy();
    // Exited sessions are behind a toggle.
    expect(within(table).queryByText('old shell')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show ended sessions (1)' }));
    expect(screen.getByText('Ended (exit code 0)')).toBeTruthy();
  });

  it('says what file an agent works on only while it works: not under a session that is idle, done or stopped', async () => {
    const view = renderConsole({ fixture: topicFixture() });
    const table = (await screen.findByText('2 · Payment form')).closest('table') as HTMLElement;
    const row = (name: string): HTMLElement => within(table).getByText(name).closest('tr') as HTMLElement;
    const discussion = within(table).getAllByText('Discussion').map((cell) => cell.closest('tr') as HTMLElement).find((line) => line.textContent?.includes('Checkout')) as HTMLElement;
    const at = (path: string) => ({ root: MAIN_ROOT, path });
    // The presence list keeps the last file of every agent session that is alive, whatever its state.
    const presence = (free: 'running' | 'idle' | 'done') =>
      act(() =>
        view.conn.emit('presence.state', {
          members: [],
          agents: [
            { sessionId: 'sess_free', ownerUserId: 'dev:amy', displayName: 'Claude (Amy)', color: '#3b82f6', status: free, activeFile: at('src/parser.ts') },
            { sessionId: 'sess_disc', ownerUserId: 'dev:ian', displayName: 'Claude (Ian)', color: '#22c55e', status: 'waiting-answer', activeFile: at('specs/checkout/PLAN.md') },
            { sessionId: 'sess_item', ownerUserId: 'dev:amy', displayName: 'Claude (Amy)', color: '#f59e0b', status: 'stalled', activeFile: at('specs/checkout/reports/payment-form.md') },
          ],
        }),
      );
    presence('running');
    expect(within(row('try the parser')).getByText('Working on src/parser.ts')).toBeTruthy();
    // Waiting for an answer is still inside a turn.
    expect(within(discussion).getByText('Working on specs/checkout/PLAN.md')).toBeTruthy();
    // The item stopped without a report: it works on nothing.
    expect(within(row('2 · Payment form')).queryByText(/Working on/)).toBeNull();

    for (const status of ['idle', 'done'] as const) {
      act(() => view.conn.emit('session.state', { session: { ...FREE, status } }));
      presence(status);
      expect(within(row('try the parser')).queryByText(/Working on/)).toBeNull();
    }
  });

  it('a session of the new model shows its topic, what it is for, its status in the words of the session list and who is responsible', async () => {
    renderConsole({ fixture: topicFixture() });
    const table = (await screen.findByText('2 · Payment form')).closest('table') as HTMLElement;
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Name', 'Topic', 'Kind', 'Status', 'Responsible', 'Opened by', 'Location', 'Actions']);
    const cells = (name: string): string[] => [...(within(table).getByText(name).closest('tr') as HTMLElement).querySelectorAll('td')].slice(1, 6).map((cell) => cell.textContent ?? '');
    // A topic's discussion is named by the wire catalogue ("Discussion"), a work item by its number and title.
    expect(cells('2 · Payment form')).toEqual(['Checkout', 'Work item (attempt 2)', 'Stopped without a report', 'Amy', 'Amy']);
    expect(cells('try the parser')).toEqual(['No topic', 'Agent session', 'Running', 'Nobody', 'Amy']);
    expect(cells('login page')).toEqual(['No topic', 'Terminal', 'Running', '', 'Amy']);
    const discussion = within(table)
      .getAllByText('Discussion')
      .map((node) => node.closest('tr') as HTMLElement)
      .find((row) => row.querySelector('.console-session__title')?.textContent === 'Discussion') as HTMLElement;
    expect([...discussion.querySelectorAll('td')].slice(1, 6).map((cell) => cell.textContent)).toEqual(['Checkout', 'Discussion', 'Waiting for an answer', 'Ian', 'Ian']);
    expect(screen.getByRole('heading', { name: 'All sessions (5)' })).toBeTruthy();
  });

  it('the status and the kind of every session are worded (pure)', () => {
    expect(statusView(DISCUSSION)).toEqual({ label: 'Waiting for an answer', tone: 'warning' });
    expect(statusView(ITEM)).toEqual({ label: 'Stopped without a report', tone: 'warning' });
    expect(statusView(FREE)).toEqual({ label: 'Running', tone: 'success' });
    expect(statusView({ ...FREE, status: 'starting' })).toEqual({ label: 'Starting', tone: 'info' });
    expect(statusView({ ...FREE, status: 'waiting-permission' })).toEqual({ label: 'Waiting for permission', tone: 'warning' });
    expect(statusView({ ...FREE, status: 'failed' })).toEqual({ label: 'Failed', tone: 'danger' });
    expect(statusView({ ...FREE, status: 'idle' })).toEqual({ label: 'Idle', tone: 'neutral' });
    expect(statusView({ ...FREE, status: 'ended', endedAt: 1 })).toEqual({ label: 'Ended', tone: 'neutral' });
    expect([purposeLabel(DISCUSSION), purposeLabel(ITEM), purposeLabel({ ...ITEM, attempt: 1 }), purposeLabel(FREE)]).toEqual(['Discussion', 'Work item (attempt 2)', 'Work item', 'Agent session']);
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
    const amy = view.fixture.sessions[1]!;
    if (amy.kind !== 'terminal') throw new Error('fixture: sess_amy is a terminal');
    act(() => view.conn.emit('session.state', { session: { ...amy, status: 'exited', exitCode: 137, endedAt: Date.now() } }));
    expect(screen.queryByRole('button', { name: 'Terminate "login page", opened by Amy' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'All sessions (1)' })).toBeTruthy();
  });

  it("terminating a topic's session asks first and says what stops with it; a session without a topic is one click", async () => {
    const view = renderConsole({ fixture: topicFixture() });
    // The discussion: the topic loses it until someone restarts it.
    fireEvent.click(await screen.findByRole('button', { name: 'Terminate "Discussion", opened by Ian' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Terminate "Discussion"?' });
    expect(
      within(dialog).getByText(
        'This is the discussion of the topic "Checkout". Once it is terminated, nobody can ask the agent to revise the spec or to write the plan until someone restarts the discussion. The spec, the plan and the work items stay.',
      ),
    ).toBeTruthy();
    expect(view.conn.requestsOf('admin.session.terminate')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(view.conn.requestsOf('admin.session.terminate')).toHaveLength(0);

    // A work item's session: the item stops, its worktree stays.
    fireEvent.click(screen.getByRole('button', { name: 'Terminate "2 · Payment form", opened by Amy' }));
    const item = screen.getByRole('alertdialog', { name: 'Terminate "2 · Payment form"?' });
    expect(within(item).getByText(/^This session works on an item of the topic "Checkout"\. Once it is terminated the item stops\./)).toBeTruthy();
    fireEvent.click(within(item).getByRole('button', { name: 'Terminate' }));
    expect(view.conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_item' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // A session without a topic ends with one click, like a terminal.
    fireEvent.click(screen.getByRole('button', { name: 'Terminate "try the parser", opened by Amy' }));
    expect(view.conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_free' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it("the state of the host's Claude account stands above the sessions: fine, logged out, or a usage limit with the sessions that wait (session.host)", async () => {
    const view = renderConsole();
    const section = (await screen.findByRole('heading', { name: 'All sessions (2)' })).closest('section') as HTMLElement;
    expect(await within(section).findByText('Your Claude account: no problem reported.')).toBeTruthy();

    act(() => view.conn.emit('session.host', { account: { state: 'usage-limit', sessions: 4 }, mainProjectSettings: 'none' }));
    const banner = within(section).getByText('Your Claude account').closest('.ui-banner') as HTMLElement;
    expect(within(banner).getByText('Your Claude account has reached a usage limit.')).toBeTruthy();
    expect(within(banner).getByText('4 agent sessions wait for it.')).toBeTruthy();
    expect(within(section).queryByText('Your Claude account: no problem reported.')).toBeNull();

    const resetsAt = Date.UTC(2026, 9, 7, 12, 30);
    act(() => view.conn.emit('session.host', { account: { state: 'usage-limit', resetsAt, sessions: 1 }, mainProjectSettings: 'none' }));
    expect(within(section).getByText(/^Your Claude account has reached a usage limit\. It resets at .+\.$/)).toBeTruthy();
    expect(within(section).getByText('1 agent session waits for it.')).toBeTruthy();

    act(() => view.conn.emit('session.host', { account: { state: 'logged-out', sessions: 0 }, mainProjectSettings: 'none' }));
    expect(within(section).getByText('Claude Code is not logged in on your computer. Run claude in your own terminal and log in.')).toBeTruthy();
    expect(within(section).queryByText(/wait for it|waits for it/)).toBeNull();
  });

  it('the one notice about a personal Claude subscription used by a group stays above the sessions, in the daemon\'s words, until the host says "Got it" (OWNER-DECISIONS Q6)', async () => {
    const view = renderConsole();
    const section = (await screen.findByRole('heading', { name: 'All sessions (2)' })).closest('section') as HTMLElement;
    expect(within(section).queryByText(/personal Claude subscription/)).toBeNull();
    act(() =>
      view.conn.emit('activity.notify', {
        notification: { id: 'n_sub', at: Date.now(), from: { kind: 'system' }, msg: msg('notice.personalSubscription'), fallback: 'Agents here use your personal Claude subscription.' },
      }),
    );
    const notice = within(section).getByText(
      "Agents here use your personal Claude subscription. Anthropic's terms do not allow making a personal account available to other people; for a group, use an API key, a Team or Enterprise plan, or a cloud provider.",
    );
    // Another notification of the daemon (a version note) is not an account notice: it stays in the activity panel.
    act(() =>
      view.conn.emit('activity.notify', {
        notification: { id: 'n_ver', at: Date.now(), from: { kind: 'system' }, msg: msg('notify.claudeVersionTooOld', { version: '2.0.1', minVersion: '2.1.0' }), fallback: 'Note: Claude Code 2.0.1 is older.' },
      }),
    );
    expect(within(section).queryByText(/Claude Code 2\.0\.1/)).toBeNull();
    fireEvent.click(within(notice.closest('.ui-banner') as HTMLElement).getByRole('button', { name: 'Got it' }));
    expect(within(section).queryByText(/personal Claude subscription/)).toBeNull();
    expect(view.stores.activity.getState().notifications.map((notification) => notification.id)).toEqual(['n_ver']);
  });

  it('when the conversations use more disk space than the limit, the sessions section says so and what to do (the storage inbox item opens it)', async () => {
    const fixture = defaultFixture();
    const storage = buildInboxItem('attention', { key: 'attention:storage:workspace', subject: 'storage', waiting: false, target: { kind: 'console', section: 'sessions' }, excerpt: '' });
    const view = renderConsole({ fixture });
    const section = (await screen.findByRole('heading', { name: 'All sessions (2)' })).closest('section') as HTMLElement;
    expect(within(section).queryByText('Disk space of the conversations')).toBeNull();
    act(() => view.conn.emit('inbox.changed', { upsert: [storage], remove: [] }));
    expect(within(section).getByText('Disk space of the conversations')).toBeTruthy();
    expect(within(section).getByText('The stored conversations use more disk space than smurg keeps for them. Nothing is removed by itself: delete archived topics you no longer need.')).toBeTruthy();
    act(() => view.conn.emit('inbox.changed', { upsert: [], remove: [storage.key] }));
    expect(within(section).queryByText('Disk space of the conversations')).toBeNull();
  });

  it('lists pending suggestions across all sessions, read-only', async () => {
    const view = renderConsole({ fixture: topicFixture() });
    const section = (await screen.findByRole('heading', { name: 'Pending suggestions (2)' })).closest('section') as HTMLElement;
    expect(within(section).getByText("This list is read-only. A suggestion reaches the agent only when you or a member with agent access accepts it, on its card in the session's conversation.")).toBeTruthy();
    // A suggestion names its author, the topic and the session; one for a session without a topic only the session.
    expect(within(section).getByText('Bob → Checkout › Discussion')).toBeTruthy();
    expect(within(section).getByText('Bob → try the parser')).toBeTruthy();
    expect(within(section).getByText('Add tests for the form validation first')).toBeTruthy();
    expect(within(section).queryByText('A suggestion handled before')).toBeNull();
    // Nothing is decided here: the only control opens the card.
    expect(within(section).getAllByRole('button').map((button) => button.textContent)).toEqual(['Open', 'Open']);
    expect(view.conn.requests.filter((request) => request.type === 'suggest.accept' || request.type === 'suggest.reject')).toEqual([]);

    // "Open" shows the suggestion's card in its session, in the sessions view.
    fireEvent.click(within(section).getAllByRole('button', { name: 'Open the suggestion of Bob in its session' })[0]!);
    const columns = view.stores.columns.getState();
    expect(columns.columns.map((column) => column.id)).toEqual(['session:sess_disc']);
    expect(columns.anchors.get('session:sess_disc')).toMatchObject({ cardId: 'sug_pending' });
    expect(view.services.router.getState().pathname).toBe(`/w/${WORKSPACE_ID}`);

    const pending = view.fixture.suggestions[0]!;
    act(() => view.conn.emit('suggest.updated', { suggestion: { ...pending, status: 'rejected', resolvedAt: Date.now() } }));
    expect(screen.getByRole('heading', { name: 'Pending suggestions (1)' })).toBeTruthy();
    expect(within(section).queryByText('Add tests for the form validation first')).toBeNull();
  });

  it('shows the merge requests with the review action', async () => {
    renderConsole();
    const section = (await screen.findByRole('heading', { level: 2, name: 'Merge requests' })).closest('section') as HTMLElement;
    expect(await within(section).findByText('Merge request from Amy')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Review' })).toBeTruthy();
  });
});
