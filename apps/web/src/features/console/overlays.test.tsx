// The console feature's dialogs in the sessions view and in code mode (slots.tsx → ConsoleOverlays): asked for by
// other features with the commands `reviewProjectSettings`, `showHostRules` and `redactEvent`, kept in
// `consoleDialogs(stores)`, rendered for the host only. The trust gate of a root, the host's own rules (information),
// and the confirmation before one conversation entry is removed (`admin.transcript.redact`, DESIGN §2.4).
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ConsoleOverlays from './ConsoleOverlays.tsx';
import { consoleDialogs } from './dialogs.ts';
import { slots } from './slots.tsx';
import { DISCUSSION, FREE, defaultFixture, hash, makeConfigFile, renderWithConsoleData, settle, topicFixture } from './test-support.tsx';

const MAIN = { kind: 'main' } as const;
const WT = { kind: 'worktree', worktreeId: 'wt_1' } as const;

describe('console dialogs: the registry of a workspace', () => {
  it('one dialog at a time per workspace; close(only) closes only the dialog it names', () => {
    const view = renderWithConsoleData(<ConsoleOverlays />);
    const dialogs = consoleDialogs(view.stores);
    expect(consoleDialogs(view.stores)).toBe(dialogs);
    expect(dialogs.getState()).toBeNull();
    const first = { kind: 'host-rules' } as const;
    act(() => dialogs.open(first));
    const second = { kind: 'redact', sessionId: 'sess_disc', seq: 7 } as const;
    act(() => dialogs.open(second));
    expect(dialogs.getState()).toBe(second);
    act(() => dialogs.close(first));
    expect(dialogs.getState()).toBe(second);
    act(() => dialogs.close(second));
    expect(dialogs.getState()).toBeNull();
    // Another workspace has its own.
    const other = renderWithConsoleData(<ConsoleOverlays />);
    expect(consoleDialogs(other.stores)).not.toBe(dialogs);
  });

  it('the feature registers the overlay with the shell (features/console/slots.tsx: the folder\'s name is the feature), and nothing else', () => {
    expect(slots.feature).toBe('console');
    expect(slots.overlays).toHaveLength(1);
    expect(slots.columns).toBeUndefined();
    expect(slots.menus).toBeUndefined();
    expect(slots.inboxRows).toBeUndefined();
  });

  it('the registered overlay handles the three commands other features send, from the first moment, and renders the dialog that was asked for', async () => {
    const Overlay = slots.overlays?.[0];
    if (Overlay === undefined) throw new Error('no overlay registered');
    const fixture = defaultFixture();
    fixture.hostRules = { rules: [{ rule: 'Bash(npm run *)', source: 'user' }], seen: true };
    const view = renderWithConsoleData(<Overlay />, { fixture });
    const bus = view.session.commands;
    const dialogs = consoleDialogs(view.stores);
    // The handlers are there with the overlay itself: the dialogs behind them may still be loading.
    for (const name of ['redactEvent', 'reviewProjectSettings', 'showHostRules'] as const) expect(bus.has(name), name).toBe(true);
    await act(async () => bus.dispatch('redactEvent', { sessionId: 'sess_disc', seq: 7 }));
    expect(dialogs.getState()).toEqual({ kind: 'redact', sessionId: 'sess_disc', seq: 7 });
    await act(async () => bus.dispatch('reviewProjectSettings', { root: WT }));
    expect(dialogs.getState()).toEqual({ kind: 'claude-config', root: WT });
    await act(async () => bus.dispatch('reviewProjectSettings', {}));
    expect(dialogs.getState()).toEqual({ kind: 'claude-config' });
    await act(async () => bus.dispatch('showHostRules', {}));
    expect(dialogs.getState()).toEqual({ kind: 'host-rules' });
    expect(await screen.findByRole('dialog', { name: 'My own Claude Code rules' }, { timeout: 15_000 })).toBeTruthy();
    // Gone with the overlay: a command then says that nobody handles it.
    view.unmount();
    for (const name of ['redactEvent', 'reviewProjectSettings', 'showHostRules'] as const) expect(bus.has(name), name).toBe(false);
  });
});

describe('console dialogs: for the host only', () => {
  it('renders nothing and asks the daemon nothing until a dialog is opened', async () => {
    const view = renderWithConsoleData(<ConsoleOverlays />);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requests.filter((request) => request.type.startsWith('admin.claudeConfig') || request.type.startsWith('admin.hostRules') || request.type.startsWith('admin.transcript'))).toEqual([]);
  });

  it('anyone but the host gets no dialog and sends no admin request, whatever asks for one', async () => {
    for (const role of ['agent', 'editor', 'viewer'] as const) {
      const view = renderWithConsoleData(<ConsoleOverlays />, { role });
      const dialogs = consoleDialogs(view.stores);
      for (const dialog of [{ kind: 'claude-config' }, { kind: 'host-rules' }, { kind: 'redact', sessionId: 'sess_disc', seq: 3 }] as const) {
        act(() => dialogs.open(dialog));
        await settle();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('alertdialog')).toBeNull();
      }
      expect(view.conn.requests.filter((request) => request.type.startsWith('admin.'))).toEqual([]);
      view.unmount();
    }
  });
});

describe('console dialogs: Claude Code project settings', () => {
  it('shows the review of the root that was asked for, decides there, and closes with its button', async () => {
    const fixture = defaultFixture();
    const settings = makeConfigFile();
    fixture.claudeConfig = [
      { root: MAIN, state: 'ignored', files: [settings] },
      { root: WT, state: 'ignored', files: [makeConfigFile({ path: '.mcp.json', hash: hash('c'), runs: ['node tools/mcp.js'], scripts: [] })] },
    ];
    const view = renderWithConsoleData(<ConsoleOverlays />, { fixture });
    act(() => consoleDialogs(view.stores).open({ kind: 'claude-config', root: MAIN }));
    const dialog = await screen.findByRole('dialog', { name: 'Claude Code project settings' });
    expect(await within(dialog).findByText('./scripts/lint.sh --fix')).toBeTruthy();
    // Only the root that was asked for.
    expect(within(dialog).queryByText('node tools/mcp.js')).toBeNull();
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Main workspaceWaits for you']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use them' }));
    expect(view.conn.lastRequest('admin.claudeConfig.decide')?.payload).toEqual({ root: MAIN, files: [{ path: '.claude/settings.json', hash: hash('a') }], decision: 'trust', acknowledged: [] });
    fixture.claudeConfig = [{ root: MAIN, state: 'used', files: [{ ...settings, decision: 'trust' }] }, fixture.claudeConfig[1]!];
    await act(async () => {
      view.conn.respond('admin.claudeConfig.decide', {});
    });
    expect(await within(dialog).findByText('Agent sessions in this folder use these settings.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(consoleDialogs(view.stores).getState()).toBeNull();
  });

  it('without a root it lists every root that has such files', async () => {
    const fixture = defaultFixture();
    fixture.claudeConfig = [
      { root: MAIN, state: 'used', files: [makeConfigFile({ decision: 'trust' })] },
      { root: WT, state: 'ignored', files: [makeConfigFile({ path: '.mcp.json', hash: hash('c'), runs: ['node tools/mcp.js'], scripts: [] })] },
    ];
    const view = renderWithConsoleData(<ConsoleOverlays />, { fixture });
    act(() => consoleDialogs(view.stores).open({ kind: 'claude-config' }));
    const dialog = await screen.findByRole('dialog', { name: 'Claude Code project settings' });
    expect(await within(dialog).findByText('node tools/mcp.js')).toBeTruthy();
    expect(within(dialog).getByText('./scripts/lint.sh --fix')).toBeTruthy();
  });
});

describe('console dialogs: my own Claude Code rules', () => {
  it('lists the rules, and an open dialog counts as seen', async () => {
    const fixture = defaultFixture();
    fixture.hostRules = { rules: [{ rule: 'Bash(npm run *)', source: 'user' }], seen: false };
    const view = renderWithConsoleData(<ConsoleOverlays />, { fixture });
    act(() => consoleDialogs(view.stores).open({ kind: 'host-rules' }));
    const dialog = await screen.findByRole('dialog', { name: 'My own Claude Code rules' });
    expect(await within(dialog).findByText('Bash(npm run *)')).toBeTruthy();
    expect(within(dialog).getByText('Your own Claude Code settings allow 1 kind of commands without asking. Agents here run them without asking too.')).toBeTruthy();
    await waitFor(() => expect(view.conn.requestsOf('admin.hostRules.seen')).toHaveLength(1));
    // The only button closes the dialog: there is nothing to decide.
    expect(within(dialog).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(expect.arrayContaining(['Close']));
    expect(within(dialog).queryByRole('button', { name: /ask|keep|allow/i })).toBeNull();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('console dialogs: removing one entry of a conversation', () => {
  it('says what happens, starts on Cancel, sends admin.transcript.redact for exactly that entry, and reports it', async () => {
    const view = renderWithConsoleData(<ConsoleOverlays />, { fixture: topicFixture() });
    await waitFor(() => expect(view.stores.sessions.getState().sessions.has(DISCUSSION.id)).toBe(true));
    act(() => consoleDialogs(view.stores).open({ kind: 'redact', sessionId: DISCUSSION.id, seq: 42 }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove this entry?' });
    expect(within(dialog).getByText('In Discussion')).toBeTruthy();
    // The sentence that will stand in its place is the daemon's own.
    expect(within(dialog).getByText('Everyone sees "The host removed this entry." in its place. The conversation stored on your computer is changed too.')).toBeTruthy();
    expect(within(dialog).getByText('Claude Code keeps its own record of the conversation: the agent may still know what the entry said.')).toBeTruthy();
    // What else keeps a copy, and what removes it (review R1-05): this session belongs to a topic.
    expect(
      within(dialog).getByText(
        'Only this entry is removed. Questions, permission requests, suggestions, inbox items and follow-up questions on a report keep what they hold of it until the topic is deleted. The audit log keeps the full text of what was sent to agents.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('This cannot be undone.')).toBeTruthy();
    // The safe answer has the focus.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(view.conn.requestsOf('admin.transcript.redact')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove entry' }));
    expect(view.conn.lastRequest('admin.transcript.redact')?.payload).toEqual({ sessionId: 'sess_disc', seq: 42 });
    await act(async () => {
      view.conn.respond('admin.transcript.redact', {});
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('The entry was removed.')).toBeTruthy();
    expect(consoleDialogs(view.stores).getState()).toBeNull();
  });

  it('in a session without a topic it says that nothing removes the other copies', async () => {
    const view = renderWithConsoleData(<ConsoleOverlays />, { fixture: topicFixture() });
    await waitFor(() => expect(view.stores.sessions.getState().sessions.has(FREE.id)).toBe(true));
    act(() => consoleDialogs(view.stores).open({ kind: 'redact', sessionId: FREE.id, seq: 3 }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove this entry?' });
    expect(
      within(dialog).getByText(
        'Only this entry is removed. Questions, permission requests, suggestions and inbox items keep what they hold of it, and the audit log keeps the full text of what was sent to agents. This session belongs to no topic: nothing removes those.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/until the topic is deleted/)).toBeNull();
  });

  it('Cancel sends nothing; a refusal is shown in the dialog and the entry can be tried again', async () => {
    const view = renderWithConsoleData(<ConsoleOverlays />, { fixture: topicFixture() });
    act(() => consoleDialogs(view.stores).open({ kind: 'redact', sessionId: 'sess_disc', seq: 5 }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.conn.requestsOf('admin.transcript.redact')).toHaveLength(0);

    act(() => consoleDialogs(view.stores).open({ kind: 'redact', sessionId: 'sess_gone', seq: 5 }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove this entry?' });
    // A session the list no longer has: the dialog simply does not name it, and says nothing about a topic.
    expect(within(dialog).queryByText(/^In /)).toBeNull();
    expect(within(dialog).getByText('Only this entry is removed. Questions, permission requests, suggestions, inbox items and the audit log keep what they hold of it.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove entry' }));
    await act(async () => {
      view.conn.fail('admin.transcript.redact', new SmurgError('not_found', msg('session.notFound'), { reason: 'unknown-session' }));
    });
    expect(within(dialog).getByText('Could not remove the entry: That session was not found.')).toBeTruthy();
    expect(screen.queryByText('The entry was removed.')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove entry' }));
    expect(view.conn.requestsOf('admin.transcript.redact')).toHaveLength(2);
  });
});
