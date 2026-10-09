// The Start dialog (DESIGN §4.5, §5.12 item 21): the checklist from plan.preflight, the pins plan.start echoes, and
// what happens when the files changed meanwhile.
import { SmurgError, type StartPreflight, type Topic } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { FAKE_HASH, buildPlan, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { T0 } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { StartDialog } from './StartDialog.tsx';
import { AMY, GIT_REASONS, IAN, MEI, admitAs, settle, topicConnection, type GitReason } from './testing/support.tsx';

const TOPIC: Topic = buildTopic({
  phase: 'plan',
  spec: { exists: true },
  plan: { ...buildTopic().plan, exists: true, valid: true, items: 3 },
  rules: [{ id: 'r_1', tool: 'Bash', pattern: 'pnpm test *', scope: 'topic', addedBy: IAN, addedAt: T0 }],
});
const PLAN = buildPlan({
  items: [
    buildWorkItem({ id: 'cart-api', number: 1, title: 'Cart API' }),
    buildWorkItem({ id: 'payment-form', number: 2, title: 'Payment form' }),
    buildWorkItem({ id: 'checkout-page', number: 3, title: 'Checkout page', dependsOn: ['cart-api', 'payment-form'] }),
  ],
});

function preflight(overrides: Partial<StartPreflight> = {}): StartPreflight {
  return {
    planRevision: 7,
    specHash: FAKE_HASH,
    planHash: 'b'.repeat(64),
    startsNow: ['cart-api', 'payment-form'],
    waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }],
    alreadyStarted: [],
    responsible: [
      { itemId: 'cart-api', user: IAN, online: true },
      { itemId: 'payment-form', user: MEI, online: true },
      { itemId: 'checkout-page', user: MEI, online: true },
    ],
    youDecide: 0,
    commit: { needed: true, branch: 'main', as: MEI, files: ['specs/checkout/SPEC.md', 'specs/checkout/PLAN.md'], alsoInFolder: [] },
    handEdits: { spec: [], plan: [] },
    invisibleCharacters: [],
    stale: false,
    openQuestion: false,
    specOpenQuestions: 0,
    editingNow: [],
    projectSettings: 'used',
    rules: TOPIC.rules,
    sharedDirs: [],
    blockers: [],
    ...overrides,
  };
}

async function setup(options: { itemIds?: string[]; role?: 'host' | 'agent'; topic?: Topic } = {}) {
  const world = { role: options.role ?? ('agent' as const), topics: [options.topic ?? TOPIC], plans: { tp_1: PLAN } };
  const conn = topicConnection(world);
  const onClose = vi.fn();
  // A dialog opens on a person's click, in a connected workspace: admit first, then render.
  const context = createTestWorkspace({ conn, admit: false });
  const openColumn = vi.fn();
  context.session.commands.handle('openColumn', openColumn);
  admitAs(conn, world);
  await settle();
  const view = render(
    <WorkspaceTestProviders context={context}>
      <StartDialog topicId="tp_1" itemIds={options.itemIds} onClose={onClose} />
    </WorkspaceTestProviders>,
  );
  const answer = async (value: StartPreflight): Promise<void> => {
    await act(async () => {
      conn.respond('plan.preflight', { preflight: value });
    });
  };
  return { ...view, ...context, conn, onClose, openColumn, answer };
}

/** What the browser says of the page (hidden: another tab or another window is in front), announced as it does. */
function pageIs(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** The window has the focus again (the host clicked it, or switched back to the browser). */
function windowFocused(): void {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('the Start dialog', () => {
  it('lists what a Start does before anything starts, and Start echoes the pins the list showed', async () => {
    const { conn, onClose, answer } = await setup();
    expect(conn.lastRequest('plan.preflight')?.payload).toEqual({ topicId: 'tp_1' });
    const loading = screen.getByRole('dialog', { name: 'Start' });
    expect(within(loading).getByText('Checking what a Start would do…')).toBeTruthy();
    expect((within(loading).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);

    await answer(preflight());
    // The title counts what starts now, like the button of the plan that opened it; the third item waits.
    const dialog = screen.getByRole('dialog', { name: 'Start 2 items' });
    expect(within(dialog).getByText('2 items start now: 1 · Cart API and 2 · Payment form.')).toBeTruthy();
    expect(within(dialog).getByText(/^3 · Checkout page starts by itself when 1 · Cart API and 2 · Payment form are merged/)).toBeTruthy();
    expect(within(dialog).getByText('Responsible: Ian 1 · Mei 2.')).toBeTruthy();
    expect(within(dialog).getByText("smurg commits SPEC.md and PLAN.md to the branch main of the host's folder, as you.")).toBeTruthy();
    expect(within(dialog).getByText("The folder's Claude Code project settings are confirmed: agents read CLAUDE.md.")).toBeTruthy();
    // What the topic always allows is part of the list and can be changed here.
    expect(within(dialog).getByText('pnpm test *')).toBeTruthy();
    expect(within(dialog).getByText('Everything else asks first.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add a kind' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(conn.lastRequest('plan.start')?.payload).toEqual({ topicId: 'tp_1', planRevision: 7, specHash: FAKE_HASH, planHash: 'b'.repeat(64) });
    await act(async () => {
      conn.respond('plan.start', { plan: PLAN });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The toast says what happened: two sessions started, the third item starts by itself.
    expect(await screen.findByText('Started 2 items.')).toBeTruthy();
    expect(screen.getByText('1 more item starts by itself later.')).toBeTruthy();
    expect(screen.queryByText(/Started 3 items/)).toBeNull();
  });

  it('when everything a Start arms waits for another item, the title counts what it arms and the toast says nothing started yet', async () => {
    const { conn, answer } = await setup();
    await answer(preflight({ startsNow: [], waits: [{ itemId: 'checkout-page', for: ['cart-api', 'payment-form'] }], alreadyStarted: ['cart-api', 'payment-form'] }));
    const dialog = screen.getByRole('dialog', { name: 'Start 1 item' });
    expect(within(dialog).getByText('No item starts now.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await act(async () => {
      conn.respond('plan.start', { plan: PLAN });
    });
    expect(await screen.findByText('1 item starts by itself later.')).toBeTruthy();
    expect(screen.queryByText(/^Started/)).toBeNull();
  });

  it('"Start this one" asks about that item only and starts only it', async () => {
    const { conn, answer } = await setup({ itemIds: ['cart-api'] });
    expect(conn.lastRequest('plan.preflight')?.payload).toEqual({ topicId: 'tp_1', itemIds: ['cart-api'] });
    await answer(preflight({ startsNow: ['cart-api'], waits: [], responsible: [{ itemId: 'cart-api', user: null, online: false }], youDecide: 1 }));
    const dialog = screen.getByRole('dialog', { name: 'Start 1 item' });
    expect(within(dialog).getByText('You will decide the questions of 1 session.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(conn.lastRequest('plan.start')?.payload).toMatchObject({ topicId: 'tp_1', itemIds: ['cart-api'], planRevision: 7 });
  });

  it('a blocker is read first and disables Start', async () => {
    const { answer } = await setup();
    await answer(preflight({ blockers: [{ text: GIT_REASONS.notAGitRepo, fallback: 'The shared folder is not a git repository yet.' }], commit: null }));
    const dialog = screen.getByRole('dialog');
    const lines = within(dialog).getAllByRole('listitem');
    expect(lines[0]?.getAttribute('data-tone')).toBe('danger');
    expect(lines[0]?.textContent?.trim()).toBe(
      'Cannot start: The shared folder is not a git repository, so worktrees cannot be used. The host can run `git init` in it and commit once, without sharing again.',
    );
    expect((within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
    // Nothing would be committed: a host whose git stops the start names no branch (commit: null), so no commit line.
    expect(dialog.querySelector('[data-line="commit"]')).toBeNull();
    expect(within(dialog).queryByText(/SPEC\.md and PLAN\.md/)).toBeNull();
  });

  // 0.5.2 (the last fixes): a host who leaves the dialog open, runs `git init` in a terminal and comes back. The
  // topic says the folder became a repository (`versioned`), so the dialog asks the host's list again by itself.
  it('left open while the folder becomes a git repository, or stops being one: the list is asked for again, with no new control', async () => {
    const NO_REPOSITORY: Topic = { ...TOPIC, versioned: false };
    const { conn, answer } = await setup({ topic: NO_REPOSITORY });
    const notRepo = preflight({ blockers: [{ text: GIT_REASONS.notAGitRepo, fallback: 'x' }], commit: null });
    await answer(notRepo);
    const dialog = screen.getByRole('dialog');
    const first = (): string | undefined => within(dialog).getAllByRole('listitem')[0]?.textContent?.trim();
    const startButton = (): HTMLButtonElement => within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(first()).toMatch(/^Cannot start: The shared folder is not a git repository/);
    expect(startButton().disabled).toBe(true);
    expect(conn.requestsOf('plan.preflight')).toHaveLength(1);

    // A topic announced again that says nothing new about the folder asks nothing.
    act(() => {
      conn.emit('topic.updated', { topic: { ...NO_REPOSITORY, name: 'Checkout, renamed' } });
    });
    expect(conn.requestsOf('plan.preflight')).toHaveLength(1);

    // `git init` in the host's terminal: the topic is announced with `versioned`, and the dialog asks again. No
    // event announces the first commit: the host's answer names it.
    act(() => {
      conn.emit('topic.updated', { topic: TOPIC });
    });
    expect(conn.requestsOf('plan.preflight')).toHaveLength(2);
    expect(conn.lastRequest('plan.preflight')?.payload).toEqual({ topicId: 'tp_1' });
    await answer(preflight({ blockers: [{ text: GIT_REASONS.noCommit, fallback: 'x' }], commit: null }));
    expect(first()).toMatch(/^Cannot start: The shared folder's git repository has no commit yet/);
    expect(startButton().disabled).toBe(true);

    // `.git` moved away, and back with its commit: asked again each time, and Start can be pressed.
    act(() => {
      conn.emit('topic.updated', { topic: NO_REPOSITORY });
    });
    expect(conn.requestsOf('plan.preflight')).toHaveLength(3);
    await answer(notRepo);
    expect(first()).toMatch(/^Cannot start: The shared folder is not a git repository/);
    act(() => {
      conn.emit('topic.updated', { topic: TOPIC });
    });
    expect(conn.requestsOf('plan.preflight')).toHaveLength(4);
    await answer(preflight());
    expect(within(dialog).queryByText(/^Cannot start:/)).toBeNull();
    expect(dialog.querySelector('[data-line="commit"]')).not.toBeNull();
    expect(startButton().disabled).toBe(false);
    // The same buttons as before: no new control.
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(buttons);
  });

  // 0.5.2 (the closing fixes): the host reads "no commit yet", goes to a terminal, commits and comes back. No event
  // announces a first commit (the folder was a repository before and after), so the open dialog kept its blocker.
  // It asks again when the page is visible again or the window has the focus again.
  it('left open on a blocker while the host goes to a terminal and comes back: the list is asked for again, once, and stays on screen meanwhile; never while hidden, never without a blocker', async () => {
    const { conn, answer } = await setup();
    const asked = (): number => conn.requestsOf('plan.preflight').length;
    const noCommit = preflight({ blockers: [{ text: GIT_REASONS.noCommit, fallback: 'x' }], commit: null });
    // Nothing is shown yet (the first answer is on its way): coming back asks nothing more.
    windowFocused();
    pageIs('visible');
    expect(asked()).toBe(1);
    await answer(noCommit);
    const dialog = screen.getByRole('dialog');
    const first = (): string | undefined => within(dialog).getAllByRole('listitem')[0]?.textContent?.trim();
    const startButton = (): HTMLButtonElement => within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent);
    const NO_COMMIT = /^Cannot start: The shared folder's git repository has no commit yet/;
    expect(first()).toMatch(NO_COMMIT);

    // The host leaves for the terminal. While the page is hidden nothing is asked, whatever event arrives.
    pageIs('hidden');
    windowFocused();
    expect(asked()).toBe(1);

    // Back: the page is visible again and the window has the focus again, the two events of one return. One
    // question, and the list stays on screen while the host answers (no "Checking…" in its place).
    pageIs('visible');
    windowFocused();
    expect(asked()).toBe(2);
    expect(conn.lastRequest('plan.preflight')?.payload).toEqual({ topicId: 'tp_1' });
    expect(first()).toMatch(NO_COMMIT);
    expect(within(dialog).queryByText('Checking what a Start would do…')).toBeNull();
    // More of them while that answer is on its way ask nothing.
    windowFocused();
    pageIs('visible');
    windowFocused();
    expect(asked()).toBe(2);
    // Nothing was committed yet: the same list.
    await answer(noCommit);
    expect(first()).toMatch(NO_COMMIT);
    expect(startButton().disabled).toBe(true);

    // A question that fails on the way back leaves the list as it is; the next return asks again.
    windowFocused();
    expect(asked()).toBe(3);
    await act(async () => {
      conn.fail('plan.preflight', new SmurgError('internal', 'not now'));
    });
    expect(first()).toMatch(NO_COMMIT);
    expect(within(dialog).queryByText(/^Could not check the plan/)).toBeNull();

    // The host committed and comes back (only the window's focus this time): the blocker is gone, Start can be pressed.
    windowFocused();
    expect(asked()).toBe(4);
    await answer(preflight());
    expect(within(dialog).queryByText(/^Cannot start:/)).toBeNull();
    expect(dialog.querySelector('[data-line="commit"]')).not.toBeNull();
    expect(startButton().disabled).toBe(false);

    // No blocker is shown: leaving and coming back asks nothing.
    pageIs('hidden');
    pageIs('visible');
    windowFocused();
    expect(asked()).toBe(4);
    // The same buttons as before: no new control.
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(buttons);
  });

  it('coming back to a list that could not be loaded, or to a closed dialog, asks nothing', async () => {
    const { conn, answer, unmount } = await setup();
    const asked = (): number => conn.requestsOf('plan.preflight').length;
    await act(async () => {
      conn.fail('plan.preflight', new SmurgError('conflict', msg('topic.archived')));
    });
    windowFocused();
    pageIs('visible');
    expect(asked()).toBe(1);
    // Retry is the control for that; then a blocker, and the dialog is closed.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(asked()).toBe(2);
    await answer(preflight({ blockers: [{ text: GIT_REASONS.noCommit, fallback: 'x' }], commit: null }));
    unmount();
    windowFocused();
    pageIs('visible');
    expect(asked()).toBe(2);
  });

  it('git says why it stops the start, one message per reason with what the host can do, and no commit line', async () => {
    const said: Readonly<Record<GitReason, string>> = {
      notAGitRepo: 'The shared folder is not a git repository, so worktrees cannot be used. The host can run `git init` in it and commit once, without sharing again.',
      gitDirGone: "The shared folder's .git is gone, so worktrees cannot be used. The host can put it back: the worktrees and merge requests here belong to that repository.",
      noCommit: "The shared folder's git repository has no commit yet, so no worktree can be created. The host can commit once, without sharing again.",
      gitNotFound: "git was not found on the host's computer, so worktrees cannot be used. The host can install git 2.42.0 or later, stop sharing, and share again from a new terminal.",
      gitTooOld: "The host's git is version 2.39.5, and worktrees need 2.42.0 or later. The host can update git, stop sharing, and share again from a new terminal.",
      gitCannotRun: "git does not run on the host's computer, so worktrees cannot be used. The host can make `git version` work in a terminal, stop sharing, and share again from that terminal.",
      gitDirNotDirectory:
        "The shared folder's .git is not an ordinary folder (the folder is a git worktree or a submodule, for example), so worktrees cannot be used. The host can share the repository's main folder instead.",
      worktreesDirUnusable: '.smurg/worktrees in the shared folder is not an ordinary folder, so worktrees cannot be used. The host can move it out of the shared folder, stop sharing, and share again.',
      checkFailed: "smurg could not look at the shared folder's git repository just now. Try again in a moment.",
      starting: 'Worktrees are not ready yet.',
    };
    for (const reason of Object.keys(GIT_REASONS) as GitReason[]) {
      const { answer, unmount } = await setup();
      // The fallback travels with the reference: this build renders the reference, never the fallback.
      await answer(preflight({ blockers: [{ text: GIT_REASONS[reason], fallback: `fallback of ${reason}` }], commit: null }));
      const dialog = screen.getByRole('dialog', { name: 'Start 2 items' });
      const first = within(dialog).getAllByRole('listitem')[0];
      expect(first?.getAttribute('data-line'), reason).toBe('blocker');
      expect(first?.textContent?.trim(), reason).toBe(`Cannot start: ${said[reason]}`);
      expect(dialog.querySelector('[data-line="commit"]'), reason).toBeNull();
      expect((within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled, reason).toBe(true);
      unmount();
    }
  });

  it('a blocker this page cannot render (a host before 0.5.2 sends plan.start.noGit) shows the English sentence it came with', async () => {
    const { answer } = await setup();
    const fallback = 'Work items run in git worktrees, and this folder is not a git repository yet. The host can make it one: run `git init`, then commit once.';
    // A 0.5.1 host with a gitfile share also named no branch: that commit line would say something false, so none.
    await answer(preflight({ blockers: [{ text: { id: 'plan.start.noGit' }, fallback }], commit: { needed: false, branch: '', as: MEI, files: [], alsoInFolder: [] } }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('listitem')[0]?.textContent?.trim()).toBe(`Cannot start: ${fallback}`);
    expect(dialog.querySelector('[data-line="commit"]')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hand edits offer "Show the changes" (plan.changes) inside the dialog', async () => {
    const { conn, answer } = await setup();
    await answer(preflight({ handEdits: { spec: [{ by: AMY, at: new Date().setHours(14, 12, 0, 0) }], plan: [] } }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Edited by hand since the last Start: Amy (SPEC.md, 14:12).')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show the changes' }));
    expect(conn.lastRequest('plan.changes')?.payload).toEqual({ topicId: 'tp_1' });
    await act(async () => {
      conn.respond('plan.changes', { files: [{ target: 'spec', diff: '@@ -1 +1 @@\n-Cards only.\n+Cards and wallets.\n', truncated: false }] });
    });
    const diff = within(dialog).getByRole('group', { name: 'Changes of SPEC.md' });
    expect(diff.textContent).toContain('+Cards and wallets.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide the changes' }));
    expect(within(dialog).queryByRole('group', { name: 'Changes of SPEC.md' })).toBeNull();
  });

  it('a stale plan offers "Update plan first": the dialog closes and the agent is asked', async () => {
    const { conn, onClose, answer } = await setup();
    await answer(preflight({ stale: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Update plan first' }));
    expect(onClose).toHaveBeenCalled();
    expect(conn.lastRequest('plan.generate')?.payload).toEqual({ topicId: 'tp_1' });
  });

  it('when the files changed after the list was shown, nothing starts and the list is loaded again', async () => {
    const { conn, onClose, answer } = await setup();
    await answer(preflight());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(async () => {
      conn.fail('plan.start', new SmurgError('conflict', msg('plan.start.changed'), { reason: 'plan-changed' }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('The spec or the plan changed while this was open. Nothing was started. Look at the list again before you start.')).toBeTruthy();
    expect(conn.requestsOf('plan.preflight')).toHaveLength(2);
    await answer(preflight({ planRevision: 8, startsNow: ['cart-api'], waits: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(conn.lastRequest('plan.start')?.payload).toMatchObject({ planRevision: 8 });
  });

  it('any other refusal stays in the dialog with its reason', async () => {
    const { conn, onClose, answer } = await setup();
    await answer(preflight());
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(async () => {
      conn.fail('plan.start', new SmurgError('conflict', msg('plan.start.commit.busy')));
    });
    expect(screen.getByText(/^Nothing was started: The spec and the plan could not be committed: git is in the middle of another operation/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a failed check can be tried again; the host is led to the shared directories setting', async () => {
    const { conn, answer, openColumn, onClose } = await setup({ role: 'host' });
    await act(async () => {
      conn.fail('plan.preflight', new SmurgError('conflict', msg('topic.archived')));
    });
    expect(screen.getByText('Could not check the plan: This topic is archived. Restore it to continue.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await answer(preflight({ sharedDirs: ['node_modules'] }));
    expect(screen.getByText('Each item gets a fresh checkout. Shared into every checkout: node_modules.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Shared directories' }));
    expect(onClose).toHaveBeenCalled();
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'console', section: 'settings' } });
  });
});
