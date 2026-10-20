// The new-session dialog per role (ARCHITECTURE §3, §5.5; SPEC R4, R9; protocol v2: every session runs as the host)
// and the end-session question (R9.4). Protocol 5 (DESIGN 0.6.0 D18): the model and mode pickers, and worktrees as
// `HostState.work` says (0.6.0 on purpose: a folder without `.git` gets smurg's own history, so the 0.5.2 "run git
// init" note and the cases that taught the page whether the folder is a repository are gone).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SmurgError, worktreeRoot, type HostState, type Role, type WorkState } from '@smurg/protocol';
import { buildAgentSession, buildTopic } from '@smurg/protocol/testing';
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { makeHostState, makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const UNCHECKED = "smurg has not checked git on the host's computer yet. Once the host has opened a topic's Start dialog or created a worktree, you can create one.";
const GIT_NOT_FOUND = msg('worktree.unavailable.gitNotFound', { minVersion: '2.42.0' });
const DIRECT: WorkState = { history: 'direct', reason: { text: GIT_NOT_FOUND, fallback: renderEnglish(GIT_NOT_FOUND) } };

function renderDialog(role: Role, options: { git?: boolean; kind?: 'agent' | 'terminal'; host?: HostState } = {}) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const result = renderInWorkspace(<NewSessionDialog kind={options.kind ?? 'agent'} open onClose={onClose} onCreated={onCreated} />, { role, admit: false });
  const welcome = makeWelcome({ role });
  act(() => {
    result.conn.admit({ ...welcome, workspace: { ...welcome.workspace, isGitRepo: options.git ?? true } });
  });
  if (options.host !== undefined) {
    const host = options.host;
    // The host's side as the daemon broadcasts it (the store takes the event at once).
    act(() => {
      result.conn.emit('session.host', host);
    });
  }
  return { ...result, onCreated, onClose };
}

/** The error inside the dialog (the toast region has an alert stack of its own). */
const dialogAlert = (): HTMLElement => within(screen.getByRole('dialog')).getByRole('alert');

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  });
}

describe('new session dialog: what the role allows', () => {
  it('the host opens a terminal: the dialog is named for it and says where it runs', async () => {
    const { conn, onCreated } = renderDialog('host', { kind: 'terminal' });
    expect(screen.getByRole('dialog', { name: 'New terminal' })).toBeTruthy();
    expect(screen.getByTestId('new-session-runs-as').textContent).toBe("This terminal runs on the host's computer, as the host.");
    // A terminal has no first message.
    expect(screen.queryByRole('textbox', { name: /What should Claude do first/ })).toBeNull();
    await submit();
    const [request] = conn.requestsOf('session.create');
    expect(request?.payload).toEqual({ kind: 'terminal', workspace: { mode: 'main' }, cols: 100, rows: 30 });
    const created = makeSession({ id: 'sess_new', kind: 'terminal' });
    await act(async () => {
      conn.respond('session.create', { session: created });
    });
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it("a session without a topic runs on the HOST's computer with the host's Claude account, whoever opens it: no sandbox, no login, no API key", async () => {
    const host = renderDialog('host');
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
    expect(screen.getByTestId('new-session-runs-as').textContent).toBe('This session runs on your computer, and the agent uses your Claude account.');
    host.unmount();

    const { conn, onCreated } = renderDialog('agent');
    expect(screen.getByTestId('new-session-runs-as').textContent).toBe("This session runs on the host's computer, and the agent uses the host's Claude account.");
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).not.toMatch(/sandbox|API key|subscription|temporary/i);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    // The kind is the one that was asked for: the dialog offers no other.
    expect(within(dialog).queryByRole('radio', { name: /terminal/i })).toBeNull();
    await submit();
    // An agent session is a conversation (protocol 4): its request carries no terminal size, and no blank message.
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'agent', workspace: { mode: 'main' } });
    await act(async () => {
      conn.fail('session.create', new SmurgError('internal', 'not now'));
    });

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name (optional)' }), { target: { value: ' Cart work ' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'What should Claude do first? (optional)' }), { target: { value: 'Add a test for the empty cart' } });
    await submit();
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'agent', workspace: { mode: 'main' }, title: 'Cart work', firstMessage: 'Add a test for the empty cart' });
    const created = buildAgentSession({ id: 'sess_new', title: 'Cart work' });
    await act(async () => {
      conn.respond('session.create', { session: created });
    });
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('an editor and a viewer cannot open sessions and are told why (no way to submit)', () => {
    const editor = renderDialog('editor');
    expect(screen.getByText(/^As an editor you cannot open a session\./)).toBeTruthy();
    expect(screen.getByText(/ask the host to give you agent access\.$/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    editor.unmount();
    renderDialog('viewer');
    expect(screen.getByText(/^As a viewer you can only watch sessions\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });
});

describe('new session dialog: where it runs (R9)', () => {
  it('offers the shared main workspace, a new worktree, or one of my kept worktrees', async () => {
    const { conn } = renderDialog('agent');
    await act(async () => {
      conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_kept', branch: 'smurg/amy/wt_kept', kept: true })] });
      conn.respond('worktree.merge.list', { requests: [] });
    });
    expect(screen.getByRole('radio', { name: /Shared main workspace/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: /Shared main workspace/ })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('radio', { name: /Continue in the worktree I kept: smurg\/amy\/wt_kept/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree', worktreeId: 'wt_kept' });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('session.limit'), { reason: 'session-limit' }));
    });
    expect(dialogAlert().textContent).toContain('The workspace has reached its session limit.End a session you no longer use, then try again.');
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    const created = makeSession({ id: 'sess_wt', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, root: worktreeRoot('wt_new') });
    await act(async () => {
      conn.respond('session.create', { session: created });
    });
  });

  it("a folder without .git (smurg's own history): worktrees are offered with no note, and a new one may take the daemon minutes", async () => {
    const { conn, stores } = renderDialog('agent', { git: false, host: makeHostState({ work: { history: 'smurg' } }) });
    const dialog = screen.getByRole('dialog');
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', false);
    expect(within(dialog).queryByText(/git init|not a git repository/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    await submit();
    const request = conn.lastRequest('session.create');
    expect(request?.payload.workspace).toEqual({ mode: 'worktree' });
    // The first snapshot of a big folder runs inside this request (DESIGN 0.6.0 D14): the page waits 5 minutes.
    expect(request?.options).toEqual({ timeoutMs: 300_000 });
    await act(async () => {
      conn.respond('session.create', { session: makeSession({ id: 'sess_wt', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, root: worktreeRoot('wt_new') }) });
    });
    // A worktree of smurg's own history says nothing about a `.git` of the folder.
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(false);
  });

  it("the main workspace and a kept worktree are asked for with the connection's own timeout", async () => {
    const { conn } = renderDialog('agent', { host: makeHostState() });
    await submit();
    expect(conn.lastRequest('session.create')?.options).toBeUndefined();
  });

  it("without the git program: no worktree, not even a kept one, and the host's sentence says why", async () => {
    const { conn } = renderDialog('agent', { host: makeHostState({ work: DIRECT }) });
    await act(async () => {
      conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_kept', branch: 'smurg/amy/wt_kept', kept: true })] });
      conn.respond('worktree.merge.list', { requests: [] });
    });
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('radio', { name: /Continue in the worktree I kept/ })).toBeNull();
    expect(screen.getByText(renderEnglish(GIT_NOT_FOUND))).toBeTruthy();
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'main' });
  });

  it("before the host's smurg looked for git: a teammate is not offered a worktree and is told when; the host is", async () => {
    const member = renderDialog('agent', { host: makeHostState({ work: { history: 'unchecked' } }) });
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', true);
    expect(screen.getByText(UNCHECKED)).toBeTruthy();
    member.unmount();
    renderDialog('host', { host: makeHostState({ work: { history: 'unchecked' } }) });
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', false);
    expect(screen.queryByText(UNCHECKED)).toBeNull();
  });

  it('follows how work items run while it is open (the session.host event)', () => {
    const { conn } = renderDialog('agent', { host: makeHostState({ work: { history: 'unchecked' } }) });
    expect(screen.getByText(UNCHECKED)).toBeTruthy();
    act(() => {
      conn.emit('session.host', makeHostState({ work: { history: 'smurg' } }));
    });
    expect(screen.queryByText(UNCHECKED)).toBeNull();
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    act(() => {
      conn.emit('session.host', makeHostState({ work: DIRECT }));
    });
    // The choice that is gone falls back to the main workspace.
    expect(screen.getByRole('radio', { name: /Shared main workspace/ })).toHaveProperty('checked', true);
  });

  it('a workspace without a topic: a refusal that names what a repository lacks says the folder is one (WorkspaceInfo.isGitRepo)', async () => {
    const { conn, stores } = renderDialog('agent', { git: false, host: makeHostState() });
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('worktree.unavailable.noCommit'), { reason: 'no-commits' }));
    });
    expect(dialogAlert().textContent).toContain("The shared folder's git repository has no commit yet, so no worktree can be created. The host can commit once, without sharing again.");
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(true);
    // A later word of the host about the folder wins: a topic announced as not versioned.
    act(() => {
      conn.emit('topic.updated', { topic: buildTopic({ versioned: false }) });
    });
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(false);
  });

  it('a repository that cannot hold a worktree yet: the host refuses with the reason and what to do, and the dialog says it', async () => {
    const { conn } = renderDialog('agent');
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('worktree.unavailable.noCommit'), { reason: 'no-commits' }));
    });
    expect(dialogAlert().textContent).toContain("The shared folder's git repository has no commit yet, so no worktree can be created. The host can commit once, without sharing again.");
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('worktree.unavailable.gitTooOld', { version: '2.39.5', minVersion: '2.42.0' }), { reason: 'git-too-old' }));
    });
    expect(dialogAlert().textContent).toContain("The host's git is version 2.39.5, and worktrees need 2.42.0 or later. The host can update git, stop sharing, and share again from a new terminal.");
  });
});

describe('new session dialog: the model and what it may do without asking (DESIGN 0.6.0 D18)', () => {
  const optionsOf = (name: string): string[] => Array.from((screen.getByRole('combobox', { name }) as HTMLSelectElement).options).map((option) => option.textContent ?? '');

  it("offers the host's default and every model the host's Claude Code lists; a model that may bill usage credits says so", async () => {
    const { conn } = renderDialog('agent', { host: makeHostState() });
    expect(optionsOf('Model')).toEqual([
      "The host's default (Opus)",
      'Opus · Opus 5.5 · Most capable for complex work',
      'Fable · Fable 5.1 · Billed to usage credits on some plans',
      'Sonnet · Sonnet 5.5 · Best for everyday tasks',
      'Haiku · Haiku 4.5 · Fastest for quick answers',
    ]);
    const credits = 'On some plans this model is billed to usage credits, and Claude Code does not ask first here.';
    expect(screen.queryByText(credits)).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'fable' } });
    expect(screen.getByText(credits)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'sonnet' } });
    expect(screen.queryByText(credits)).toBeNull();
    await submit();
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'agent', workspace: { mode: 'main' }, model: 'sonnet' });
  });

  it("while the host's agent was not asked yet: only the host's default, the line that says it is being asked, and the page asks again", async () => {
    const { conn } = renderDialog('agent', { host: makeHostState({ agent: { models: [], modelsKnown: false, hostDefault: null } }) });
    expect(optionsOf('Model')).toEqual(["The host's default"]);
    expect(screen.getByText("Asking the host's Claude Code which models it offers…")).toBeTruthy();
    // The daemon asks its Claude Code when `session.host.get` arrives and the list is not known: once more, not again.
    await act(async () => {});
    expect(conn.requestsOf('session.host.get')).toHaveLength(2);
    act(() => {
      conn.emit('session.host', makeHostState({ agent: { models: [], modelsKnown: false, hostDefault: null } }));
    });
    await act(async () => {});
    expect(conn.requestsOf('session.host.get')).toHaveLength(2);
    act(() => {
      conn.emit('session.host', makeHostState());
    });
    expect(screen.queryByText("Asking the host's Claude Code which models it offers…")).toBeNull();
    expect(optionsOf('Model')).toHaveLength(5);
  });

  it('the mode follows the workspace unless one of the three is chosen; never "Asks for nothing"; auto says what its checks cost', async () => {
    const { conn } = renderDialog('agent', { host: makeHostState() });
    expect(optionsOf('What it may do without asking')).toEqual(['Workspace default (Auto: runs what a check allows)', 'Auto: runs what a check allows', 'Asks before commands', 'Asks before edits and commands']);
    const cost = "Auto mode checks commands with extra requests to Claude, which may count toward the host's usage.";
    expect(screen.getByText(cost)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'What it may do without asking' }), { target: { value: 'ask-commands' } });
    expect(screen.queryByText(cost)).toBeNull();
    await submit();
    expect(conn.lastRequest('session.create')?.payload).toEqual({ kind: 'agent', workspace: { mode: 'main' }, permissionMode: 'ask-commands' });
  });

  it('the host reads what auto mode\'s checks cost about their own usage (0.6.0\'s review: it said "the host\'s usage" to the host)', () => {
    renderDialog('host', { host: makeHostState() });
    expect(screen.getByText('Auto mode checks commands with extra requests to Claude, which may count toward your usage.')).toBeTruthy();
    expect(screen.queryByText(/toward the host's usage/)).toBeNull();
  });

  it("the workspace's own mode names the default (the Welcome's settings, then channel.settingsUpdated)", () => {
    const { conn } = renderDialog('agent', { host: makeHostState() });
    act(() => {
      conn.emit('channel.settingsUpdated', { settings: { ...makeWelcome().settings, permissionMode: 'ask-all' } });
    });
    expect(optionsOf('What it may do without asking')[0]).toBe('Workspace default (Asks before edits and commands)');
    expect(screen.queryByText(/Auto mode checks commands/)).toBeNull();
  });

  it('a terminal has neither', () => {
    renderDialog('agent', { kind: 'terminal', host: makeHostState() });
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'What it may do without asking' })).toBeNull();
  });
});

describe('new session dialog: refusals in plain words', () => {
  it('a refusal the role cannot pass (forbidden) is explained, never shown as a code', async () => {
    const { conn } = renderDialog('agent');
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('forbidden'));
    });
    expect(dialogAlert().textContent).toContain('Your role does not allow this.');
  });

  it("a missing Claude Code on the host's computer says the host has to install it", async () => {
    const { conn } = renderDialog('agent');
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('session.claudeNotFound'), { reason: 'claude-not-found' }));
    });
    expect(dialogAlert().textContent).toContain('Ask the host to install it, then try again.');
  });
});

describe('ending a session (R9.4: when a session ends, ask whether to keep the worktree)', () => {
  const inWorktree = makeSession({ id: 'sess_wt', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, root: worktreeRoot('wt_1'), title: 'Fix the login page' });

  it('asks whether to keep the worktree, and sends the answer explicitly', async () => {
    const { conn } = renderInWorkspace(<EndSessionDialog session={inWorktree} mode="end" onClose={() => {}} />, { role: 'agent' });
    expect(screen.getByText('Keep the worktree of this session?')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Keep the worktree/ })).toHaveProperty('checked', true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_wt', keepWorktree: true });
    await act(async () => {
      conn.respond('session.end', {});
    });
    fireEvent.click(screen.getByRole('radio', { name: /Delete the worktree/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_wt', keepWorktree: false });
  });

  it('a session in the main workspace has no worktree question', async () => {
    const main = makeSession({ id: 'sess_main', openedBy: { userId: 'dev:amy', displayName: 'Amy' } });
    const { conn } = renderInWorkspace(<EndSessionDialog session={main} mode="end" onClose={() => {}} />, { role: 'agent' });
    expect(screen.queryByText('Keep the worktree of this session?')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'End session' }));
    });
    expect(conn.lastRequest('session.end')?.payload).toEqual({ sessionId: 'sess_main' });
  });

  it("the host terminates someone else's session with admin.session.terminate", async () => {
    const { conn } = renderInWorkspace(<EndSessionDialog session={inWorktree} mode="terminate" onClose={() => {}} />, { role: 'host' });
    expect(screen.getByText('Terminate "Fix the login page", opened by Amy? All of its processes stop at once.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));
    });
    expect(conn.lastRequest('admin.session.terminate')?.payload).toEqual({ sessionId: 'sess_wt' });
    expect(conn.requestsOf('session.end')).toHaveLength(0);
  });
});
