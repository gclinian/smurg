import { AUDIT_ACTIONS, SmurgError, type InviteInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_PAGE_SIZE } from '../../lib/stores/admin.ts';
import { T0 } from '../../testing/fixtures.ts';
import { auditActionLabel, auditDetailRows } from './audit-labels.ts';
import { GIB } from './settings-form.ts';
import { DAY, SETTINGS, containsString, defaultFixture, makeAudit, renderConsole } from './test-support.tsx';


const section = async (name: RegExp | string): Promise<HTMLElement> => (await screen.findByRole('heading', { level: 2, name })).closest('section') as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('host console: invites', () => {
  const SECRET_URL = 'https://smurg.app/join/ws_web_test_workspace_0001#k=kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk&s=SECRETsecretSECRETsecretSECRETsecretSECRETs';

  it('creates an invite with role, expiry and number of uses; the link is shown once with a copy button and a warning, and is kept nowhere after the dialog closes', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const log = vi.spyOn(console, 'log');
    const view = renderConsole();
    const invites = await section('Invite links');
    const roles = within(invites).getByLabelText('Role') as HTMLSelectElement;
    expect([...roles.options].map((option) => option.textContent)).toEqual(['Agent access', 'Editor', 'Viewer']);
    fireEvent.change(roles, { target: { value: 'agent' } });
    expect(
      within(invites).getByText('Can start topics, agents and terminals (they run on your computer with your Claude account), message any agent, answer its permission requests and accept suggestions.'),
    ).toBeTruthy();
    // Before a link exists the host reads what a new member gets to see (DESIGN §2.4, S9).
    const HISTORY = 'A new member can read every earlier conversation of this workspace, the ones of archived topics included.';
    expect(within(invites).getByText(HISTORY)).toBeTruthy();
    fireEvent.change(within(invites).getByLabelText('Expires after'), { target: { value: '1d' } });
    fireEvent.change(within(invites).getByLabelText('Number of uses'), { target: { value: '3' } });
    fireEvent.click(within(invites).getByRole('button', { name: 'Create invite link' }));
    // Agent access: the risk first, nothing created before the host confirms.
    const risk = screen.getByRole('alertdialog', { name: 'Create an invite link with agent access?' });
    expect(within(risk).getByTestId('role-risk-text').textContent).toBe(
      'Anyone with agent access can have an agent run any command on your computer, read the files in your home directory and use your Claude account. Give it only to people you fully trust.',
    );
    expect(view.conn.requestsOf('admin.invite.create')).toHaveLength(0);
    fireEvent.click(within(risk).getByRole('button', { name: 'I understand, create the link' }));
    expect(view.conn.lastRequest('admin.invite.create')?.payload).toEqual({ role: 'agent', expiresInSec: 86_400, maxUses: 3 });

    const invite: InviteInfo = { id: 'inv_new', role: 'agent', createdAt: Date.now(), expiresAt: Date.now() + DAY, maxUses: 3, uses: 0, revoked: false };
    view.fixture.invites = [...view.fixture.invites, invite];
    await act(async () => {
      view.conn.respond('admin.invite.create', { invite, url: SECRET_URL });
    });
    const dialog = screen.getByRole('dialog', { name: 'Invite link created' });
    expect((within(dialog).getByLabelText('Invite link') as HTMLInputElement).value).toBe(SECRET_URL);
    expect(within(dialog).getByText('Role: Agent access. Expires in 1 day. Can be used 3 times.')).toBeTruthy();
    expect(within(dialog).getByText(/^The link contains the secret for joining the workspace\. Send it only over a private channel/)).toBeTruthy();
    expect(within(dialog).getByText(/^This link is shown only this once/)).toBeTruthy();
    // … and again next to the link they are about to send.
    expect(within(dialog).getByText(HISTORY)).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }));
    });
    expect(writeText).toHaveBeenCalledWith(SECRET_URL);
    // A stray Escape does not throw the link away.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Invite link created' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain('SECRETsecret');
    for (const [name, store] of Object.entries(view.stores)) {
      expect(containsString((store as { getState(): unknown }).getState(), 'SECRETsecret'), name).toBe(false);
    }
    expect(log.mock.calls.flat().some((value) => containsString(value, 'SECRETsecret'))).toBe(false);
    // The list shows the new invite (reloaded after creation), with its uses left.
    await waitFor(() => expect(within(invites).getByText('0 used, 3 left')).toBeTruthy());
  });

  it('an agent-access invite cancelled at the risk step is never created; editor and viewer invites need no confirmation', async () => {
    const view = renderConsole();
    const invites = await section('Invite links');
    fireEvent.change(within(invites).getByLabelText('Role'), { target: { value: 'agent' } });
    fireEvent.click(within(invites).getByRole('button', { name: 'Create invite link' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.invite.create')).toHaveLength(0);
    fireEvent.change(within(invites).getByLabelText('Role'), { target: { value: 'viewer' } });
    fireEvent.click(within(invites).getByRole('button', { name: 'Create invite link' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.lastRequest('admin.invite.create')?.payload).toMatchObject({ role: 'viewer' });
  });

  it('validates the number of uses and sends none for an unlimited invite', async () => {
    const view = renderConsole();
    const invites = await section('Invite links');
    const uses = within(invites).getByLabelText('Number of uses');
    const create = within(invites).getByRole('button', { name: 'Create invite link' }) as HTMLButtonElement;
    for (const bad of ['0', '-1', '1.5', 'abc', '10001']) {
      fireEvent.change(uses, { target: { value: bad } });
      expect(within(invites).getByText('Enter a whole number from 1 to 10000, or leave it empty.')).toBeTruthy();
      expect(create.disabled).toBe(true);
    }
    fireEvent.change(uses, { target: { value: '' } });
    fireEvent.click(create);
    expect(view.conn.lastRequest('admin.invite.create')?.payload).toEqual({ role: 'editor', expiresInSec: 7 * 86_400 });
    await act(async () => {
      view.conn.fail('admin.invite.create', new SmurgError('forbidden', msg('error.default.hostOnly')));
    });
    expect(within(invites).getByText('Could not create the invite link: Only the host can do this.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists invites with uses left and revokes one', async () => {
    const view = renderConsole();
    const invites = await section('Invite links');
    const row = (await within(invites).findByText('2 used, 3 left')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Editor')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    // The revoked one is behind a toggle.
    expect(within(invites).queryByText('Revoked')).toBeNull();
    fireEvent.click(within(invites).getByRole('button', { name: 'Show inactive invites (1)' }));
    expect(within(invites).getByText('Revoked')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: /^Revoke the Editor invite created .+$/ }));
    expect(view.conn.lastRequest('admin.invite.revoke')?.payload).toEqual({ inviteId: 'inv_active' });
    view.fixture.invites = view.fixture.invites.map((invite) => (invite.id === 'inv_active' ? { ...invite, revoked: true } : invite));
    await act(async () => {
      view.conn.respond('admin.invite.revoke', {});
    });
    expect(await screen.findByText('The invite link is revoked. Nobody can join with it any more.')).toBeTruthy();
    await waitFor(() => expect(within(invites).getAllByText('Revoked')).toHaveLength(2));
    expect(within(invites).queryByRole('button', { name: /^Revoke / })).toBeNull();
  });
});

describe('host console: audit log', () => {
  it('shows time, actor, action, target and outcome, newest first', async () => {
    renderConsole();
    const audit = await section('Audit log');
    const rows = await waitFor(() => {
      const found = within(audit).getAllByRole('row').slice(1);
      expect(found).toHaveLength(3);
      return found;
    });
    expect(within(rows[0]!).getByText('Bob')).toBeTruthy();
    expect(within(rows[0]!).getByText('Denied: no permission')).toBeTruthy();
    expect(within(rows[0]!).getByText('file.write')).toBeTruthy();
    expect(within(rows[0]!).getByText('Denied')).toBeTruthy();
    expect(within(rows[0]!).getByText('forbidden-role')).toBeTruthy();
    expect(within(rows[0]!).getByRole('time').getAttribute('datetime')).toBe(new Date(T0 + 3_000).toISOString());
    expect(within(rows[2]!).getByText('Connected')).toBeTruthy();
    expect(within(rows[2]!).getByText('OK')).toBeTruthy();
    expect(within(audit).getByText('No older entries.')).toBeTruthy();
  });

  it("a suggestion's entry shows who proposed what and how it was decided (R6.3)", () => {
    const rows = auditDetailRows({
      id: 'au_s',
      at: T0,
      actor: { kind: 'user', userId: 'dev:host', displayName: 'Ian' },
      action: 'suggest.accept',
      target: 'sug_1',
      outcome: 'ok',
      detail: { suggestionId: 'sug_1', authorUserId: 'dev:amy', authorName: 'Amy', outcome: 'accepted-modified', text: 'Add the tests first\nthen merge', finalText: 'Add tests', createdAt: T0 },
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Suggested by', 'Amy'],
      ['Decision', 'Accepted with edits'],
      ['Suggestion', 'Add the tests first\nthen merge'],
      ['Text that was sent', 'Add tests'],
    ]);
    expect(rows.find((row) => row.key === 'text')?.block).toBe(true);
  });

  it('every action of the audit vocabulary has a name of its own (a new action without one does not compile)', () => {
    const english = AUDIT_ACTIONS.map((action) => auditActionLabel(action));
    for (const [index, action] of AUDIT_ACTIONS.entries()) {
      expect(english[index], action).not.toBe(action);
      expect(english[index], action).not.toMatch(/^console\.|^audit\./);
    }
    // No two actions read the same: the log must tell them apart.
    expect(new Set(english).size).toBe(AUDIT_ACTIONS.length);
    expect(auditActionLabel('session.restart')).toBe("Restarted a session's agent");
    expect(auditActionLabel('transcript.redact')).toBe('Removed a conversation entry');
    expect(auditActionLabel('claude-config.decide')).toBe('Decided on Claude Code project settings');
    expect(auditActionLabel('permission.auto-deny')).toBe('Tool call refused by smurg');
  });

  it('the entries of the new model show with their names and their details', async () => {
    const fixture = defaultFixture();
    fixture.audit = [
      makeAudit(1, { action: 'permission.decide', target: 'perm_1', actor: { kind: 'user', userId: 'dev:host', displayName: 'Ian' }, detail: { tool: 'Bash', decision: 'allow', command: 'pnpm test', rule: 'Bash(pnpm test *)' } }),
      makeAudit(2, { action: 'session.handover', target: 'sess_item', actor: { kind: 'system' }, detail: { from: 'Amy', to: 'Ian', reason: 'kicked' } }),
    ];
    renderConsole({ fixture });
    const audit = await section('Audit log');
    const handover = (await within(audit).findByText('Session passed to the host')).closest('tr') as HTMLElement;
    expect(within(handover).getByText('smurg')).toBeTruthy();
    const decide = within(audit).getByText('Answered a permission request').closest('tr') as HTMLElement;
    const detail = within(decide).getByLabelText('Details of this entry');
    expect([...detail.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Tool', 'Decision', 'Command', 'Always-allowed kind']);
    expect([...detail.querySelectorAll('dd')].map((value) => value.textContent)).toEqual(['Bash', 'allow', 'pnpm test', 'Bash(pnpm test *)']);
  });

  it('audit paging: loads older pages with admin.audit.query {before}', async () => {
    const fixture = defaultFixture();
    fixture.audit = Array.from({ length: AUDIT_PAGE_SIZE + 20 }, (_, i) => makeAudit(i + 1));
    const view = renderConsole({ fixture });
    const audit = await section('Audit log');
    await waitFor(() => expect(within(audit).getByText(`${AUDIT_PAGE_SIZE} entries loaded`)).toBeTruthy());
    expect(view.conn.requestsOf('admin.audit.query')[0]?.payload).toEqual({ limit: AUDIT_PAGE_SIZE });
    expect(within(audit).queryByText('src/file-20.ts')).toBeNull();

    fireEvent.click(within(audit).getByRole('button', { name: 'Load older entries' }));
    await waitFor(() => expect(within(audit).getByText(`${AUDIT_PAGE_SIZE + 20} entries loaded`)).toBeTruthy());
    expect(view.conn.lastRequest('admin.audit.query')?.payload).toEqual({ limit: AUDIT_PAGE_SIZE, before: T0 + 21 * 1_000 });
    expect(within(audit).getByText('src/file-20.ts')).toBeTruthy();
    expect(within(audit).getByText('No older entries.')).toBeTruthy();
    expect(within(audit).queryByRole('button', { name: 'Load older entries' })).toBeNull();
  });

  it('shows a failure to load older entries', async () => {
    const fixture = defaultFixture();
    fixture.audit = Array.from({ length: AUDIT_PAGE_SIZE }, (_, i) => makeAudit(i + 1));
    const view = renderConsole({ fixture });
    const audit = await section('Audit log');
    await waitFor(() => expect(within(audit).getByRole('button', { name: 'Load older entries' })).toBeTruthy());
    view.conn.handle('admin.audit.query', () => Promise.reject(new SmurgError('internal')));
    fireEvent.click(within(audit).getByRole('button', { name: 'Load older entries' }));
    expect(await within(audit).findByText('Could not load older entries: Something went wrong on the host.')).toBeTruthy();
  });

  it('audit live append: a new entry appears at the top', async () => {
    const view = renderConsole();
    const audit = await section('Audit log');
    await waitFor(() => expect(within(audit).getAllByRole('row')).toHaveLength(4));
    act(() => view.conn.emit('admin.audit.entry', { entry: makeAudit(9, { action: 'member.kick', target: 'dev:bob', actor: { kind: 'user', userId: 'dev:host', displayName: 'Ian' } }) }));
    const first = within(audit).getAllByRole('row')[1]!;
    expect(within(first).getByText('Removed a member')).toBeTruthy();
    expect(within(first).getByText('dev:bob')).toBeTruthy();
    expect(within(audit).getByText('4 entries loaded')).toBeTruthy();
  });
});

describe('host console: settings', () => {
  it('shows the current settings and saves only what changed', async () => {
    const view = renderConsole();
    const settings = await section('Settings');
    const shared = (await within(settings).findByLabelText('Shared folders (read-only in worktrees)')) as HTMLTextAreaElement;
    expect(shared.value).toBe('data');
    expect((within(settings).getByLabelText('Idle time before an edit lock is released (seconds)') as HTMLInputElement).value).toBe('30');
    expect((within(settings).getByLabelText('Disk space to keep free (GB)') as HTMLInputElement).value).toBe('5');
    const save = within(settings).getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // No setting of a guest sandbox (protocol v2: there is none).
    expect(within(settings).queryByText(/sandbox|domain/i)).toBeNull();
    fireEvent.change(shared, { target: { value: 'data\ncheckpoints/' } });
    fireEvent.change(within(settings).getByLabelText('Agent lock timeout (seconds)'), { target: { value: '90' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(view.conn.lastRequest('admin.settings.set')?.payload).toEqual({ sharedDirs: ['data', 'checkpoints'], agentLockTimeoutMs: 90_000 });
    await act(async () => {
      view.conn.respond('admin.settings.set', { settings: { ...SETTINGS, sharedDirs: ['data', 'checkpoints'], agentLockTimeoutMs: 90_000 } });
    });
    expect(screen.getByText('Settings saved and applied.')).toBeTruthy();
    expect(shared.value).toBe('data\ncheckpoints');
    expect(save.disabled).toBe(true);
  });

  it('the agent settings: how many work items run at once, the waiting time before others are asked, and the MCP switch with what it means', async () => {
    const view = renderConsole();
    const settings = await section('Settings');
    const live = (await within(settings).findByLabelText('Work items running at the same time')) as HTMLInputElement;
    expect(within(settings).getByRole('heading', { level: 3, name: 'Agents' })).toBeTruthy();
    expect(live.value).toBe('8');
    expect(within(settings).getByText('How many work items smurg keeps running at once on your computer (2 to 32). The others wait for a free agent. A message from a person always gets an agent.')).toBeTruthy();
    const wait = within(settings).getByLabelText('Waiting time before others are asked (minutes)') as HTMLInputElement;
    expect(wait.value).toBe('10');
    expect(
      within(settings).getByText('A question or a permission request that has waited this long also reaches you and the members with agent access. A result report does after 6 times as long. Default: 5 minutes.'),
    ).toBeTruthy();
    // Off unless the host turns it on, with the consequence in words (DESIGN §2.11).
    const mcp = within(settings).getByRole('checkbox', { name: "Agents may use my own and this project's MCP servers" }) as HTMLInputElement;
    expect(mcp.checked).toBe(false);
    expect(mcp.getAttribute('aria-describedby')).toBe(within(settings).getByText(/^Off: agents get only the tools of smurg\. On: an agent that any member with agent access drives can call those servers/).id);

    fireEvent.change(live, { target: { value: '4' } });
    fireEvent.change(wait, { target: { value: '3' } });
    fireEvent.click(mcp);
    fireEvent.click(within(settings).getByRole('button', { name: 'Save settings' }));
    expect(view.conn.lastRequest('admin.settings.set')?.payload).toEqual({ maxLiveAgents: 4, escalateAfterMs: 180_000, agentMcp: true });
    await act(async () => {
      view.conn.respond('admin.settings.set', { settings: { ...SETTINGS, maxLiveAgents: 4, escalateAfterMs: 180_000, agentMcp: true } });
    });
    expect(screen.getByText('Settings saved and applied.')).toBeTruthy();
    expect(mcp.checked).toBe(true);
    expect((within(settings).getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);

    // Out of range: said under the field, nothing sent; Reset puts the saved values back.
    fireEvent.change(live, { target: { value: '64' } });
    fireEvent.click(mcp);
    expect(within(settings).getByText('Enter a whole number from 2 to 32.')).toBeTruthy();
    expect((within(settings).getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(settings).getByRole('button', { name: 'Reset' }));
    expect(live.value).toBe('4');
    expect(mcp.checked).toBe(true);
    expect(view.conn.requestsOf('admin.settings.set')).toHaveLength(1);
  });

  it('settings validation: every invalid field says why and nothing is sent', async () => {
    const view = renderConsole();
    const settings = await section('Settings');
    await within(settings).findByLabelText('Shared folders (read-only in worktrees)');
    fireEvent.change(within(settings).getByLabelText('Shared folders (read-only in worktrees)'), { target: { value: '../outside' } });
    fireEvent.change(within(settings).getByLabelText('Agent lock timeout (seconds)'), { target: { value: '601' } });
    fireEvent.change(within(settings).getByLabelText('Idle time before an edit lock is released (seconds)'), { target: { value: '0' } });
    fireEvent.change(within(settings).getByLabelText('Disk space to keep free (%)'), { target: { value: '150' } });
    expect(within(settings).getByText(/^"\.\.\/outside" is not a valid folder path/)).toBeTruthy();
    expect(within(settings).getByText('Enter a number from 1 to 600.')).toBeTruthy();
    expect(within(settings).getByText('Enter a number from 1 to 3600.')).toBeTruthy();
    expect(within(settings).getByText('Enter a number from 0 to 100.')).toBeTruthy();
    expect(within(settings).getByText('4 fields need fixing.')).toBeTruthy();
    const save = within(settings).getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest('form')!);
    expect(view.conn.requestsOf('admin.settings.set')).toHaveLength(0);
    fireEvent.click(within(settings).getByRole('button', { name: 'Reset' }));
    expect(within(settings).queryByText('4 fields need fixing.')).toBeNull();
    expect((within(settings).getByLabelText('Disk space to keep free (%)') as HTMLInputElement).value).toBe('5');
  });

  it('shows the daemon’s refusal and keeps the edits', async () => {
    const view = renderConsole();
    const settings = await section('Settings');
    const disk = (await within(settings).findByLabelText('Disk space to keep free (GB)')) as HTMLInputElement;
    fireEvent.change(disk, { target: { value: '20' } });
    fireEvent.click(within(settings).getByRole('button', { name: 'Save settings' }));
    expect(view.conn.lastRequest('admin.settings.set')?.payload).toEqual({ diskReserveBytes: 20 * GIB });
    await act(async () => {
      view.conn.fail('admin.settings.set', new SmurgError('bad_request', msg('settings.invalid')));
    });
    expect(within(settings).getByText('Could not save the settings: The settings are not valid.')).toBeTruthy();
    expect(disk.value).toBe('20');
  });

  it('settings are live: a change made elsewhere is re-read and shown', async () => {
    const view = renderConsole();
    const settings = await section('Settings');
    const idle = (await within(settings).findByLabelText('Idle time before an edit lock is released (seconds)')) as HTMLInputElement;
    const reads = view.conn.requestsOf('admin.settings.get').length;
    view.fixture.settings = { ...SETTINGS, humanLockIdleMs: 45_000, sharedDirs: ['data', 'models'] };
    act(() =>
      view.conn.emit('channel.settingsUpdated', {
        settings: { humanLockIdleMs: 45_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: ['data'] },
      }),
    );
    await waitFor(() => expect(idle.value).toBe('45'));
    expect(view.conn.requestsOf('admin.settings.get').length).toBe(reads + 1);
    expect((within(settings).getByLabelText('Shared folders (read-only in worktrees)') as HTMLTextAreaElement).value).toBe('data\nmodels');
  });
});
