// The new-session dialog per role (ARCHITECTURE §3, §5.5; SPEC R4, R9; protocol v2: every session runs as the host)
// and the end-session question (R9.4).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SmurgError, worktreeRoot, type Role } from '@smurg/protocol';
import { buildAgentSession, buildTopic } from '@smurg/protocol/testing';
import { msg } from '@smurg/protocol/i18n';
import { makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { EndSessionDialog } from './EndSessionDialog.tsx';
import { NewSessionDialog } from './NewSessionDialog.tsx';

const NOT_A_GIT_REPO = 'The shared folder is not a git repository, so worktrees cannot be used. The host can run `git init` in it and commit once, without sharing again.';

function renderDialog(role: Role, options: { git?: boolean; kind?: 'agent' | 'terminal' } = {}) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const result = renderInWorkspace(<NewSessionDialog kind={options.kind ?? 'agent'} open onClose={onClose} onCreated={onCreated} />, { role, admit: false });
  const welcome = makeWelcome({ role });
  act(() => {
    result.conn.admit({ ...welcome, workspace: { ...welcome.workspace, isGitRepo: options.git ?? true } });
  });
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

  it('a folder that is not a git repository as far as the page knows: the reason as a note; a new worktree is still offered and the host answers', async () => {
    const { conn } = renderDialog('agent', { git: false });
    expect(screen.getByRole('radio', { name: /Shared main workspace/ })).toHaveProperty('checked', true);
    // The host's own sentence for the reason (the Start dialog's blocker): what the host can do about it.
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    // A workspace without a topic learns that the folder became a repository only at the next welcome: the choice
    // stays, and the host's daemon looks at the folder again before it answers.
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('worktree.unavailable.notAGitRepo'), { reason: 'not-a-git-repo' }));
    });
    expect(dialogAlert().textContent).toContain(NOT_A_GIT_REPO);
    // The host ran `git init` and committed since the page opened: the same request now opens the session there.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    await act(async () => {
      conn.respond('session.create', { session: makeSession({ id: 'sess_wt', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, root: worktreeRoot('wt_new') }) });
    });
  });

  it('follows the folder while it is open: a topic the host announces again says it became a git repository, or stopped being one', async () => {
    const { conn } = renderDialog('agent', { git: false });
    await act(async () => {
      conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_kept', branch: 'smurg/amy/wt_kept', kept: true })] });
      conn.respond('worktree.merge.list', { requests: [] });
    });
    expect(screen.queryByRole('radio', { name: /Continue in the worktree I kept/ })).toBeNull();
    // The host ran `git init` while sharing: every topic is announced again with `versioned`.
    act(() => {
      conn.emit('topic.updated', { topic: buildTopic({ versioned: true }) });
    });
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', false);
    expect(screen.getByRole('radio', { name: /Continue in the worktree I kept: smurg\/amy\/wt_kept/ })).toBeTruthy();
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));

    fireEvent.click(screen.getByRole('radio', { name: /Continue in the worktree I kept/ }));

    // Its `.git` went away: the reason, the kept worktree no longer offered (back to the main workspace).
    act(() => {
      conn.emit('topic.updated', { topic: buildTopic({ versioned: false }) });
    });
    expect(screen.queryByRole('radio', { name: /Continue in the worktree I kept/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /Shared main workspace/ })).toHaveProperty('checked', true);
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    await submit();
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'main' });
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
