// The host console's "What agents may do without asking" (DESIGN 0.6.0 D3, D13, D18): the workspace's permission mode
// with its four labels, "Asks for nothing" only after its warning and never as root, what the host's Claude Code
// turned off, the sessions on a model that may bill usage credits, and the banner of the 0.6.0 update with "Got it".
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { T0, makeAgentSession, makeHostState } from '../../testing/fixtures.ts';
import { AGENTS_AUTO, SETTINGS, defaultFixture, renderConsole, settle } from './test-support.tsx';

const section = async (name: string): Promise<HTMLElement> => (await screen.findByRole('heading', { level: 2, name })).closest('section') as HTMLElement;

describe('host console: what agents may do without asking', () => {
  it('the four modes; another than "Asks for nothing" applies as soon as it is chosen; auto says what its checks cost', async () => {
    const view = renderConsole({ section: 'settings' });
    const settings = await section('Settings');
    const select = (await within(settings).findByRole('combobox', { name: 'What agents may do without asking' })) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['Auto: runs what a check allows', 'Asks before commands', 'Asks before edits and commands', 'Asks for nothing']);
    expect(select.value).toBe('auto');
    expect(within(settings).getByText(/^The default of every agent session and work item of this workspace\./)).toBeTruthy();
    // The console is the host's: "your usage" (it said "the host's usage" until 0.6.0's review).
    expect(within(settings).getByText('Auto mode checks commands with extra requests to Claude, which may count toward your usage.')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'ask-commands' } });
    expect(view.conn.lastRequest('admin.settings.set')?.payload).toEqual({ permissionMode: 'ask-commands' });
    await act(async () => {
      view.conn.respond('admin.settings.set', { settings: { ...SETTINGS, permissionMode: 'ask-commands' } });
    });
    expect(screen.getByText('Settings saved and applied.')).toBeTruthy();
    expect(select.value).toBe('ask-commands');
    expect(within(settings).queryByText(/^Auto mode checks commands/)).toBeNull();
  });

  it('"Asks for nothing" opens the warning, and only its own button saves it', async () => {
    const view = renderConsole({ section: 'settings' });
    const settings = await section('Settings');
    const select = (await within(settings).findByRole('combobox', { name: 'What agents may do without asking' })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'ask-nothing' } });
    const warning = screen.getByRole('alertdialog', { name: 'Let agents ask for nothing?' });
    expect(within(warning).getByText(/^Every agent session of this workspace will run every command as you, on your computer, with no sandbox/)).toBeTruthy();
    expect(within(warning).getByText(/A command that reaches them another way runs as you\. Choose this only for a folder and a team you trust completely\.$/)).toBeTruthy();
    expect(view.conn.requestsOf('admin.settings.set')).toHaveLength(0);
    fireEvent.click(within(warning).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.settings.set')).toHaveLength(0);
    expect(select.value).toBe('auto');

    fireEvent.change(select, { target: { value: 'ask-nothing' } });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Ask for nothing' }));
    expect(view.conn.lastRequest('admin.settings.set')?.payload).toEqual({ permissionMode: 'ask-nothing' });
    await act(async () => {
      view.conn.respond('admin.settings.set', { settings: { ...SETTINGS, permissionMode: 'ask-nothing' } });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(select.value).toBe('ask-nothing');
  });

  it('as root "Asks for nothing" cannot be chosen, and the line says why', async () => {
    const fixture = defaultFixture();
    fixture.host = makeHostState({ agent: { asksNothing: 'root' } });
    renderConsole({ section: 'settings', fixture });
    const settings = await section('Settings');
    const select = (await within(settings).findByRole('combobox', { name: 'What agents may do without asking' })) as HTMLSelectElement;
    await settle();
    expect(Array.from(select.options).find((option) => option.value === 'ask-nothing')?.disabled).toBe(true);
    expect(within(settings).getByText('smurg runs as the root user: Claude Code does not run agents without asking then.')).toBeTruthy();
  });

  it("what the host's Claude Code turned off", async () => {
    const fixture = defaultFixture();
    fixture.host = makeHostState({ agent: { autoMode: 'off', asksNothing: 'off' } });
    renderConsole({ section: 'settings', fixture });
    const settings = await section('Settings');
    await within(settings).findByRole('combobox', { name: 'What agents may do without asking' });
    await settle();
    expect(within(settings).getByText(/^Claude Code on your computer turns auto mode off/)).toBeTruthy();
    expect(within(settings).getByText(/^Claude Code on your computer does not allow running without asking/)).toBeTruthy();
  });

  it('names the live sessions that run on a model that may bill usage credits, five at most', async () => {
    const fixture = defaultFixture();
    fixture.host = makeHostState();
    const fable = (index: number, extra: Parameters<typeof makeAgentSession>[0] = {}) =>
      makeAgentSession({ id: `sess_f${index}`, title: `fable ${index}`, status: 'running', model: 'fable', modelInUse: 'claude-fable-5-1', createdAt: T0 + index, ...extra });
    fixture.sessions = [
      ...[1, 2, 3, 4, 5, 6, 7].map((index) => fable(index)),
      // Chosen, not started yet: it will run on it.
      makeAgentSession({ id: 'sess_chosen', title: 'chosen', status: 'idle', model: 'fable', createdAt: T0 }),
      // Ended: not live. Another model: not listed. Chose Fable but the agent runs another one: not listed.
      fable(8, { status: 'ended' }),
      makeAgentSession({ id: 'sess_sonnet', title: 'sonnet', status: 'running', model: 'sonnet', createdAt: T0 }),
      makeAgentSession({ id: 'sess_swapped', title: 'swapped', status: 'running', model: 'fable', modelInUse: 'claude-opus-5-5', createdAt: T0 }),
    ];
    renderConsole({ section: 'settings', fixture });
    const settings = await section('Settings');
    await within(settings).findByRole('combobox', { name: 'What agents may do without asking' });
    await settle();
    expect(within(settings).getByText('Agent sessions on a model that may be billed to usage credits (8): fable 7, fable 6, fable 5, fable 4, fable 3, 3 more')).toBeTruthy();
  });

  it('after the 0.6.0 update: the banner until the host presses "Got it"', async () => {
    const fixture = defaultFixture();
    fixture.inbox = [AGENTS_AUTO];
    const view = renderConsole({ section: 'settings', fixture });
    const settings = await section('Settings');
    expect(await within(settings).findByText(/^Since smurg 0\.6\.0, agents run in auto mode: Claude Code's check decides which commands run without asking you/)).toBeTruthy();
    fireEvent.click(within(settings).getByRole('button', { name: 'Got it' }));
    expect(view.conn.lastRequest('admin.notice.seen')?.payload).toEqual({ notice: 'agents-auto' });
    await act(async () => {
      view.conn.respond('admin.notice.seen', {});
      view.conn.emit('inbox.changed', { upsert: [], remove: [AGENTS_AUTO.key] });
    });
    expect(within(settings).queryByText(/^Since smurg 0\.6\.0/)).toBeNull();
  });
});
