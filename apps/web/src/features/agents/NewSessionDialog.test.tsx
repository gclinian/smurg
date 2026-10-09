// The new-session dialog per role (ARCHITECTURE §3, §5.5; SPEC R4, R9; protocol v2: every session runs as the host)
// and the end-session question (R9.4).
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SmurgError, worktreeRoot, type Role } from '@smurg/protocol';
import { buildAgentSession, buildTopic } from '@smurg/protocol/testing';
import { msg } from '@smurg/protocol/i18n';
import { makeMergeRequest, makeSession, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
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
    const { conn, stores } = renderDialog('agent', { git: false });
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
    // The host says the same: it stands once, in the host's answer (the page's own note is not shown beside it).
    expect(screen.getAllByText(NOT_A_GIT_REPO)).toHaveLength(1);
    expect(within(dialogAlert()).getByText(NOT_A_GIT_REPO)).toBeTruthy();
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(false);
    // The host ran `git init` and committed since the page opened: the same request now opens the session there.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    });
    expect(conn.lastRequest('session.create')?.payload.workspace).toEqual({ mode: 'worktree' });
    await act(async () => {
      conn.respond('session.create', { session: makeSession({ id: 'sess_wt', openedBy: { userId: 'dev:amy', displayName: 'Amy' }, root: worktreeRoot('wt_new') }) });
    });
    // 0.5.2 (the last fixes): a session opened in a worktree means the folder is a repository. The page learns it
    // from that answer (no event tells a workspace without a topic), and stops saying "run git init".
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(true);
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
    expect(screen.getByText(/^Work in your own worktree without disturbing the main workspace\./)).toBeTruthy();
  });

  it('a workspace without a topic, after `git init`: a refusal that names what a repository lacks says the folder is one, the note goes and my kept worktrees are offered', async () => {
    const { conn, stores } = renderDialog('agent', { git: false });
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('worktree.unavailable.noCommit'), { reason: 'no-commits' }));
    });
    // One sentence on screen, the host's: no commit yet. Not "is not a git repository" beside it.
    expect(dialogAlert().textContent).toContain("The shared folder's git repository has no commit yet, so no worktree can be created. The host can commit once, without sharing again.");
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(true);
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('checked', true);
    // The member's kept worktrees are offered from now on.
    act(() => {
      conn.emit('worktree.updated', { worktree: makeWorktree({ id: 'wt_kept', branch: 'smurg/amy/wt_kept', kept: true }) });
    });
    expect(screen.getByRole('radio', { name: /Continue in the worktree I kept: smurg\/amy\/wt_kept/ })).toBeTruthy();
    // A later word of the host about the folder wins: a topic announced as not versioned.
    act(() => {
      conn.emit('topic.updated', { topic: buildTopic({ versioned: false }) });
    });
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(false);
  });

  it('a refusal that says the folder is no repository (nothing at .git, or a .git that went) teaches nothing; nor does a session in the main workspace', async () => {
    const { conn, stores } = renderDialog('agent', { git: false });
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('worktree.unavailable.gitDirGone'), { reason: 'git-dir-gone' }));
    });
    expect(dialogAlert().textContent).toContain("The shared folder's .git is gone, so worktrees cannot be used. The host can put it back: the worktrees and merge requests here belong to that repository.");
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(false);
    // "Put it back" stands alone: never "run git init" beside it.
    expect(within(screen.getByRole('dialog')).queryByText(/git init/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Shared main workspace/ }));
    await submit();
    await act(async () => {
      conn.respond('session.create', { session: makeSession({ id: 'sess_main', openedBy: { userId: 'dev:amy', displayName: 'Amy' } }) });
    });
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(false);
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
  });

  // 0.5.2 (the closing fixes): the host names git itself first, whatever the folder is, and a look that failed saw
  // nothing. Before, each of these made the page take a folder that is NO repository for one: the note went, the
  // hint of a working worktree mode showed, and the next topic.updated put the note back beside the host's error
  // (one saying "without sharing again", the other "stop sharing, and share again").
  it("a folder that is no repository, refused for a reason that says nothing about it (git itself, a look that failed, a host still starting): the page keeps what it believed and shows the host's sentence alone", async () => {
    const { conn, stores } = renderDialog('agent', { git: false });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: /A new worktree of my own/ }));
    const refusals = [
      { text: msg('worktree.unavailable.gitNotFound', { minVersion: '2.42.0' }), reason: 'git-not-found', said: "git was not found on the host's computer, so worktrees cannot be used. The host can install git 2.42.0 or later, stop sharing, and share again from a new terminal." },
      { text: msg('worktree.unavailable.gitTooOld', { version: '2.39.5', minVersion: '2.42.0' }), reason: 'git-too-old', said: "The host's git is version 2.39.5, and worktrees need 2.42.0 or later. The host can update git, stop sharing, and share again from a new terminal." },
      { text: msg('worktree.unavailable.gitCannotRun'), reason: 'git-unusable', said: "git does not run on the host's computer, so worktrees cannot be used. The host can make `git version` work in a terminal, stop sharing, and share again from that terminal." },
      { text: msg('worktree.unavailable.checkFailed'), reason: 'check-failed', said: "smurg could not look at the shared folder's git repository just now. Try again in a moment." },
      { text: msg('worktree.unavailable.starting'), reason: 'starting', said: 'Worktrees are not ready yet.' },
    ];
    for (const { text, reason, said } of refusals) {
      await submit();
      await act(async () => {
        conn.fail('session.create', new SmurgError('conflict', text, { reason }));
      });
      expect(dialogAlert().textContent, reason).toContain(said);
      // Nothing in that sentence says the folder is a repository: the page believes what it believed.
      expect(stores.workspace.getState().workspace?.isGitRepo, reason).toBe(false);
      expect(within(dialog).queryByText(/^Work in your own worktree/), reason).toBeNull();
      // One sentence on screen, the host's: no "run git init … without sharing again" beside "share again".
      expect(screen.queryByText(NOT_A_GIT_REPO), reason).toBeNull();
      expect(within(dialog).queryByText(/git init/), reason).toBeNull();
    }
    // A topic announced again changes nothing of that: the host's sentence still stands alone.
    act(() => {
      conn.emit('topic.updated', { topic: buildTopic({ versioned: false }) });
    });
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
    // A refusal that is not about worktrees does not hide the page's note.
    await submit();
    await act(async () => {
      conn.fail('session.create', new SmurgError('conflict', msg('session.limit'), { reason: 'session-limit' }));
    });
    expect(dialogAlert().textContent).toContain('The workspace has reached its session limit.');
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    expect(stores.workspace.getState().workspace?.isGitRepo).toBe(false);
  });

  it('never the "run git init" note while a worktree or an open merge request exists: the folder is a repository the page has not heard of, or its .git went', async () => {
    const { conn } = renderDialog('agent', { git: false });
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    // Somebody opened a session in a worktree (the host ran `git init` and committed since this page opened).
    act(() => {
      conn.emit('worktree.updated', { worktree: makeWorktree({ id: 'wt_bob', ownerUserId: 'dev:bob', ownerName: 'Bob' }) });
    });
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
    expect(within(screen.getByRole('dialog')).queryByText(/git init/)).toBeNull();
    expect(screen.getByRole('radio', { name: /A new worktree of my own/ })).toHaveProperty('disabled', false);
    act(() => {
      conn.emit('worktree.removed', { worktreeId: 'wt_bob' });
    });
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    // 0.5.2 (the closing fixes): a request that was decided is history, and `git init` strands nothing of it.
    act(() => {
      conn.emit('worktree.merge.updated', { request: makeMergeRequest({ id: 'mr_done', worktreeId: 'wt_gone', status: 'merged' }) });
    });
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
    // One that still waits for the host can only be merged in the repository it was made in.
    act(() => {
      conn.emit('worktree.merge.updated', { request: makeMergeRequest({ id: 'mr_1', worktreeId: 'wt_gone', status: 'pending' }) });
    });
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
    act(() => {
      conn.emit('worktree.merge.updated', { request: makeMergeRequest({ id: 'mr_1', worktreeId: 'wt_gone', status: 'rejected' }) });
    });
    expect(screen.getByText(NOT_A_GIT_REPO)).toBeTruthy();
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

    // Its `.git` went away: the kept worktree is no longer offered (back to the main workspace). No "run git init"
    // while a worktree exists: the host says "put it back" to whoever asks for a worktree.
    act(() => {
      conn.emit('topic.updated', { topic: buildTopic({ versioned: false }) });
    });
    expect(screen.queryByRole('radio', { name: /Continue in the worktree I kept/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /Shared main workspace/ })).toHaveProperty('checked', true);
    expect(screen.queryByText(NOT_A_GIT_REPO)).toBeNull();
    // With the worktree removed, the folder is simply no repository.
    act(() => {
      conn.emit('worktree.removed', { worktreeId: 'wt_kept' });
    });
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
