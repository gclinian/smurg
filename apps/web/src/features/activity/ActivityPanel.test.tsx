import { MAIN_ROOT, type ActivityEvent, type Role } from '@smurg/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CommandMap } from '../../lib/commands.ts';
import { HOST_USER, makeActivity, makeWorktree } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { ActivityPanel } from './index.tsx';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const AGENT = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: HOST_USER, displayName: 'Claude（Ian）' };
const AMY_AGENT = { kind: 'agent' as const, sessionId: 'sess_2', ownerUserId: 'dev:amy', displayName: 'Claude（Amy）' };
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
  it('每一次 agent 的修改都出現在活動動態中，標示是哪個 agent、屬於誰 — the web feed, live and newest first', async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'act_2', at: Date.now() - 60_000, actor: BOB, kind: 'human.edit', file: { root: MAIN_ROOT, path: 'README.md' }, summary: 'Bob 編輯了 README.md' }),
      makeActivity({ id: 'act_1', at: Date.now() - 150_000, actor: AGENT, kind: 'agent.edit', summary: 'Claude（Ian） 修改了 src/app.ts（Edit）' }),
    ]);
    await view.settle();
    expect(view.items()).toHaveLength(2);

    // A new agent edit arrives live: on top, with the agent's name (which names its owner) and the file.
    act(() =>
      view.conn.emit('activity.event', {
        event: makeActivity({ id: 'act_3', at: Date.now(), actor: AMY_AGENT, kind: 'agent.edit', file: { root: MAIN_ROOT, path: 'src/util.ts' }, summary: 'Claude（Amy） 修改了 src/util.ts（Write）' }),
      }),
    );
    const [first, second, third] = view.items();
    expect(within(first!).getByText('Claude（Amy）')).toBeTruthy();
    expect(within(first!).getByText('agent 修改')).toBeTruthy();
    expect(within(first!).getByText('Claude（Amy） 修改了 src/util.ts（Write）')).toBeTruthy();
    expect(within(first!).getByRole('button', { name: '開啟 src/util.ts' })).toBeTruthy();
    expect(within(second!).getByText('Bob')).toBeTruthy();
    expect(within(second!).getByText('編輯')).toBeTruthy();
    expect(within(third!).getByText('Claude（Ian）')).toBeTruthy();
    expect(within(third!).getByText('2 分鐘前')).toBeTruthy();
  });

  it("an agent's change by a shell command is shown as that agent's with a small 「透過指令」 marker; 「外部程式」 only when the daemon says so (D-13)", async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'act_x', at: Date.now() - 1_000, actor: { kind: 'system' }, kind: 'external.change', file: { root: MAIN_ROOT, path: 'build.log' }, summary: '外部程式修改了 build.log' }),
      makeActivity({ id: 'act_b', at: Date.now(), actor: AGENT, kind: 'agent.edit', file: { root: MAIN_ROOT, path: 'src/app.ts' }, summary: 'Claude（Ian）透過 shell 指令修改了 src/app.ts', via: 'bash' }),
    ]);
    await view.settle();
    const [bash, external] = view.items();
    expect(within(bash!).getByText('Claude（Ian）')).toBeTruthy();
    expect(within(bash!).getByText('agent 修改')).toBeTruthy();
    const marker = within(bash!).getByTestId('activity-via-shell');
    expect(marker.textContent).toContain('透過指令');
    expect(marker.getAttribute('title')).toBe('這個修改來自 Claude（Ian） 執行的 shell 指令（Bash），由主人電腦依指令執行的時間判斷是它改的。');
    expect(within(bash!).queryByText('外部程式')).toBeNull();
    expect(within(external!).getByText('外部程式')).toBeTruthy();
    expect(within(external!).queryByTestId('activity-via-shell')).toBeNull();
    // The agents filter keeps it (it is the agent's change).
    fireEvent.change(screen.getByLabelText('篩選活動'), { target: { value: 'agents' } });
    expect(view.items()).toHaveLength(1);
    expect(within(view.items()[0]!).getByTestId('activity-via-shell')).toBeTruthy();
  });

  it('clicking a file opens it in the editor (openFile); a deleted file is not a link; a conflict leads to the conflict panel', async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'act_c', actor: AGENT, kind: 'conflict', file: { root: MAIN_ROOT, path: 'src/app.ts' }, summary: 'src/app.ts 有 1 處衝突' }),
      makeActivity({ id: 'act_d', actor: BOB, kind: 'file.delete', file: { root: MAIN_ROOT, path: 'old.md' }, summary: 'Bob 刪除了 old.md' }),
      makeActivity({ id: 'act_w', actor: AGENT, kind: 'agent.edit', file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'lib/x.ts' }, summary: 'Claude（Ian） 修改了 lib/x.ts' }),
    ]);
    view.conn.respond('worktree.list', { worktrees: [makeWorktree({ id: 'wt_1', ownerName: 'Amy', branch: 'smurg/amy/wt_1' })] });
    view.conn.respond('worktree.merge.list', { requests: [] });
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: '開啟 src/app.ts' }));
    fireEvent.click(screen.getByRole('button', { name: '開啟 lib/x.ts（worktree：Amy · smurg/amy/wt_1）' }));
    await view.settle();
    expect(view.dispatched.openFile).toEqual([
      { file: { root: MAIN_ROOT, path: 'src/app.ts' } },
      { file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'lib/x.ts' } },
    ]);
    expect(screen.queryByRole('button', { name: /old\.md/ })).toBeNull();
    expect(screen.getByText('old.md（已刪除）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看衝突' }));
    await view.settle();
    expect(view.dispatched.showPanel).toEqual([{ panel: 'conflicts' }]);
  });

  it('filters by agents, people and problems', async () => {
    const view = renderFeed();
    view.answer([
      makeActivity({ id: 'a1', actor: AGENT, kind: 'agent.edit', summary: 'agent 的修改' }),
      makeActivity({ id: 'a2', actor: BOB, kind: 'file.create', summary: 'Bob 新增了 a.md' }),
      makeActivity({ id: 'a3', actor: { kind: 'system' }, kind: 'external.change', summary: '外部程式修改了 b.md' }),
      makeActivity({ id: 'a4', actor: AGENT, kind: 'lock.denied', summary: 'Claude（Ian） 想修改 c.md，但 Bob 正在編輯，已被擋下' }),
    ]);
    await view.settle();
    const select = screen.getByRole('combobox', { name: '篩選活動' });
    fireEvent.change(select, { target: { value: 'agents' } });
    expect(view.items().map((item) => item.getAttribute('data-kind'))).toEqual(['agent.edit', 'lock.denied']);
    fireEvent.change(select, { target: { value: 'people' } });
    expect(view.items().map((item) => item.getAttribute('data-kind'))).toEqual(['file.create']);
    fireEvent.change(select, { target: { value: 'problems' } });
    expect(view.items().map((item) => item.getAttribute('data-kind'))).toEqual(['external.change', 'lock.denied']);
    expect(within(view.items()[0]!).getByText('外部程式')).toBeTruthy();
  });

  it('loads older pages with an exact `before` cursor', async () => {
    const view = renderFeed();
    const page = Array.from({ length: 100 }, (_, i) => makeActivity({ id: `p_${i}`, at: 2_000_000_000_000 - i * 1_000, summary: `第 ${i} 筆` }));
    view.answer(page);
    await view.settle();
    fireEvent.click(screen.getByRole('button', { name: '載入更早的活動' }));
    await view.settle();
    expect(view.conn.lastRequest('activity.list')?.payload).toEqual({ limit: 100, before: 2_000_000_000_000 - 99 * 1_000 });
    view.answer([makeActivity({ id: 'older', at: 1_000, summary: '更早的一筆' })]);
    await view.settle();
    expect(screen.getByText('更早的一筆')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '載入更早的活動' })).toBeNull();
  });

  it('shows notifications sent to me (「通知某位組員」) until dismissed; their file opens', async () => {
    const view = renderFeed();
    view.answer([]);
    await view.settle();
    expect(screen.getByText('還沒有任何活動')).toBeTruthy();
    act(() =>
      view.conn.emit('activity.notify', {
        notification: { id: 'n_1', at: Date.now(), from: AGENT, text: '我改好了登入頁，請幫忙看一下 <b>樣式</b>', file: { root: MAIN_ROOT, path: 'src/login.tsx' } },
      }),
    );
    const region = screen.getByRole('region', { name: '給你的通知' });
    expect(within(region).getByText('Claude（Ian） 通知你')).toBeTruthy();
    // Text, never HTML.
    expect(within(region).getByText('我改好了登入頁，請幫忙看一下 <b>樣式</b>')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: '開啟檔案' }));
    await view.settle();
    expect(view.dispatched.openFile).toEqual([{ file: { root: MAIN_ROOT, path: 'src/login.tsx' } }]);
    fireEvent.click(within(region).getByRole('button', { name: '知道了' }));
    expect(screen.queryByRole('region', { name: '給你的通知' })).toBeNull();
  });

  it('a failed load explains itself and retries', async () => {
    const view = renderFeed();
    view.conn.fail('activity.list', new Error('boom'));
    await view.settle();
    expect(screen.getByText(/^無法載入活動：/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    view.answer([makeActivity({ summary: '回來了' })]);
    await view.settle();
    expect(screen.getByText('回來了')).toBeTruthy();
  });
});
