import { MAIN_ROOT, type ActivityEvent, type Role } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { HOST_USER, makeActivity, makeWorktree } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { ActivityPanel } from './index.tsx';


const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const AGENT = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude (Ian)' };
const AMY_AGENT = { kind: 'agent' as const, sessionId: 'sess_2', ownerUserId: 'dev:amy', displayName: 'Claude (Amy)' };
const BOB = { kind: 'user' as const, userId: 'dev:bob', displayName: 'Bob' };

function renderFeed(options: { role?: Role; events?: ActivityEvent[] } = {}) {
  const view = renderInWorkspace(<ActivityPanel />, { role: options.role ?? 'editor' });
  const dispatched: { openFile: CommandMap['openFile'][]; showPanel: CommandMap['showPanel'][] } = { openFile: [], showPanel: [] };
  view.session.commands.handle('openFile', (payload) => {
    dispatched.openFile.push(payload);
  });
  view.session.commands.handle('showPanel', (payload) => {
    dispatched.showPanel.push(payload);
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await act(flush);
  };
  const items = () => screen.queryAllByRole('listitem');
  return { ...view, dispatched, settle, items, answer: (events: ActivityEvent[]) => view.conn.respond('activity.list', { events }) };
}

describe('ActivityPanel: the live activity feed', () => {
  it('every change by an agent appears in the activity feed, naming the agent and whose it is — the web feed, live and newest first', async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'act_2', at: Date.now() - 60_000, actor: BOB, kind: 'human.edit', file: { root: MAIN_ROOT, path: 'README.md' }, text: msg('activity.humanEdit', { name: 'Bob', path: 'README.md' }), summary: 'the English fallback, not shown' }),
      makeActivity({ id: 'act_1', at: Date.now() - 150_000, actor: AGENT, kind: 'agent.edit', summary: 'a sentence from a newer host: shown as it came' }),
    ]);
    await view.settle();
    expect(view.items()).toHaveLength(2);

    // A new agent edit arrives live: on top, with the agent's name (which names its owner) and the file.
    act(() =>
      view.conn.emit('activity.event', {
        event: makeActivity({ id: 'act_3', at: Date.now(), actor: AMY_AGENT, kind: 'agent.edit', file: { root: MAIN_ROOT, path: 'src/util.ts' }, text: msg('activity.agentEdit', { agent: AMY_AGENT.displayName, path: 'src/util.ts', tool: 'Write' }), summary: 'the English fallback, not shown' }),
      }),
    );
    const [first, second, third] = view.items();
    expect(within(first!).getByText('Claude (Amy)')).toBeTruthy();
    expect(within(first!).getByText('Agent edit')).toBeTruthy();
    // The sentence is the host's message reference, rendered here in the viewer's language.
    expect(within(first!).getByText(`${AMY_AGENT.displayName} edited src/util.ts (Write)`)).toBeTruthy();
    expect(within(first!).getByRole('button', { name: 'Open src/util.ts' })).toBeTruthy();
    expect(within(second!).getByText('Bob')).toBeTruthy();
    expect(within(second!).getByText('Edit')).toBeTruthy();
    expect(within(second!).getByText('Bob edited README.md')).toBeTruthy();
    expect(within(third!).getByText('Claude (Ian)')).toBeTruthy();
    expect(within(third!).getByText('2 minutes ago')).toBeTruthy();
    // A reference this build does not know: the English sentence that came with it.
    expect(within(third!).getByText('a sentence from a newer host: shown as it came')).toBeTruthy();
  });

  it("an agent's change by a shell command is shown as that agent's with a small 'via a command' marker; 'Outside program' only when the daemon says so (D-13)", async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'act_x', at: Date.now() - 1_000, actor: { kind: 'system' }, kind: 'external.change', file: { root: MAIN_ROOT, path: 'build.log' }, summary: 'A program outside smurg changed build.log' }),
      makeActivity({ id: 'act_b', at: Date.now(), actor: AGENT, kind: 'agent.edit', file: { root: MAIN_ROOT, path: 'src/app.ts' }, summary: 'changed src/app.ts with a shell command', via: 'bash' }),
    ]);
    await view.settle();
    const [bash, external] = view.items();
    expect(within(bash!).getByText('Claude (Ian)')).toBeTruthy();
    expect(within(bash!).getByText('Agent edit')).toBeTruthy();
    const marker = within(bash!).getByTestId('activity-via-shell');
    expect(marker.textContent).toContain('via a command');
    expect(marker.getAttribute('title')).toBe(`This change came from a shell command (Bash) that ${AGENT.displayName} ran. The host's computer attributes it to that agent by the time the command ran.`);
    expect(within(bash!).queryByText('Outside program')).toBeNull();
    expect(within(external!).getByText('Outside program')).toBeTruthy();
    expect(within(external!).queryByTestId('activity-via-shell')).toBeNull();
    // The agents filter keeps it (it is the agent's change).
    fireEvent.change(screen.getByLabelText('Filter activity'), { target: { value: 'agents' } });
    expect(view.items()).toHaveLength(1);
    expect(within(view.items()[0]!).getByTestId('activity-via-shell')).toBeTruthy();
  });

  it('clicking a file opens it in the editor (openFile); a deleted file is not a link; a conflict leads to the conflict panel', async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'act_c', actor: AGENT, kind: 'conflict', file: { root: MAIN_ROOT, path: 'src/app.ts' }, summary: '1 change to src/app.ts overlaps text that is being edited' }),
      makeActivity({ id: 'act_d', actor: BOB, kind: 'file.delete', file: { root: MAIN_ROOT, path: 'old.md' }, summary: 'Deleted old.md' }),
      makeActivity({ id: 'act_w', actor: AGENT, kind: 'agent.edit', file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'lib/x.ts' }, summary: 'edited lib/x.ts' }),
    ]);
    view.conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_1', ownerName: 'Amy', branch: 'smurg/amy/wt_1' })] });
    view.conn.respond('worktree.merge.list', { requests: [] });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'Open src/app.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open lib/x.ts (worktree: Amy · smurg/amy/wt_1)' }));
    await view.settle();
    expect(view.dispatched.openFile).toEqual([
      { file: { root: MAIN_ROOT, path: 'src/app.ts' } },
      { file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'lib/x.ts' } },
    ]);
    expect(screen.queryByRole('button', { name: /old\.md/ })).toBeNull();
    expect(screen.getByText('old.md (deleted)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View conflicts' }));
    await view.settle();
    expect(view.dispatched.showPanel).toEqual([{ panel: 'conflicts' }]);
  });

  it('filters by agents, people and problems', async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'a1', actor: AGENT, kind: 'agent.edit', summary: 'a change by an agent' }),
      makeActivity({ id: 'a2', actor: BOB, kind: 'file.create', summary: 'Created the file a.md' }),
      makeActivity({ id: 'a3', actor: { kind: 'system' }, kind: 'external.change', summary: 'A program outside smurg changed b.md' }),
      makeActivity({ id: 'a4', actor: AGENT, kind: 'lock.denied', summary: 'wanted to change c.md, but Bob is editing it: blocked' }),
    ]);
    await view.settle();
    const select = screen.getByRole('combobox', { name: 'Filter activity' });
    fireEvent.change(select, { target: { value: 'agents' } });
    expect(view.items().map((item) => item.getAttribute('data-kind'))).toEqual(['agent.edit', 'lock.denied']);
    fireEvent.change(select, { target: { value: 'people' } });
    expect(view.items().map((item) => item.getAttribute('data-kind'))).toEqual(['file.create']);
    fireEvent.change(select, { target: { value: 'problems' } });
    expect(view.items().map((item) => item.getAttribute('data-kind'))).toEqual(['external.change', 'lock.denied']);
    expect(within(view.items()[0]!).getByText('Outside program')).toBeTruthy();
  });

  it('loads older pages with an exact `before` cursor', async () => {
    const view = renderFeed();
    const page = Array.from({ length: 100 }, (_, i) => makeActivity({ id: `p_${i}`, at: 2_000_000_000_000 - i * 1_000, summary: `entry ${i}` }));
    view.answer(page);
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier activity' }));
    await view.settle();
    expect(view.conn.lastRequest('activity.list')?.payload).toEqual({ limit: 100, before: 2_000_000_000_000 - 99 * 1_000 });
    view.answer([makeActivity({ id: 'older', at: 1_000, summary: 'an earlier entry' })]);
    await view.settle();
    expect(screen.getByText('an earlier entry')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load earlier activity' })).toBeNull();
  });

  it('shows notifications sent to me (the notify_member tool) until dismissed; their file opens', async () => {
    const view = renderFeed();
    view.answer([]);
    await view.settle();
    expect(screen.getByText('No activity yet')).toBeTruthy();
    act(() =>
      view.conn.emit('activity.notify', {
        notification: { id: 'n_1', at: Date.now(), from: AGENT, text: 'The login page is done, please check the <b>styles</b>', file: { root: MAIN_ROOT, path: 'src/login.tsx' } },
      }),
    );
    const region = screen.getByRole('region', { name: 'Notifications for you' });
    expect(within(region).getByText(`${AGENT.displayName} notified you`)).toBeTruthy();
    // Text, never HTML.
    expect(within(region).getByText('The login page is done, please check the <b>styles</b>')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Open file' }));
    await view.settle();
    expect(view.dispatched.openFile).toEqual([{ file: { root: MAIN_ROOT, path: 'src/login.tsx' } }]);
    fireEvent.click(within(region).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('region', { name: 'Notifications for you' })).toBeNull();
  });

  it('a notice the host\'s smurg wrote itself is rendered from its message reference and named "smurg", never "Outside program"', async () => {
    const view = renderFeed();
    view.answer([]);
    await view.settle();
    act(() =>
      view.conn.emit('activity.notify', {
        notification: {
          id: 'n_sys',
          at: Date.now(),
          from: { kind: 'system' },
          msg: msg('notify.claudeVersionTooOld', { version: '2.0.1', minVersion: '2.1.0' }),
          fallback: 'the English fallback, not shown',
        },
      }),
    );
    const region = screen.getByRole('region', { name: 'Notifications for you' });
    expect(within(region).getByText('smurg notified you')).toBeTruthy();
    expect(within(region).getByText(/^Note: Claude Code 2\.0\.1 is older than 2\.1\.0, the oldest version smurg is verified with\./)).toBeTruthy();
    // A message this build does not know: the fallback that came with it.
    act(() =>
      view.conn.emit('activity.notify', {
        notification: { id: 'n_new', at: Date.now(), from: { kind: 'system' }, msg: { id: 'notify.fromANewerHost' }, fallback: 'A notice from a newer host.' },
      }),
    );
    expect(within(region).getByText('A notice from a newer host.')).toBeTruthy();
  });

  it('a failed load explains itself and retries', async () => {
    const view = renderFeed();
    view.conn.fail('activity.list', new Error('boom'));
    await view.settle();
    expect(screen.getByText(/^Could not load the activity: /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    view.answer([makeActivity({ summary: 'back again' })]);
    await view.settle();
    expect(screen.getByText('back again')).toBeTruthy();
  });
});
