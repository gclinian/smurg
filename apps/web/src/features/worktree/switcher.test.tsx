import { SmurgError, type Role, type WorktreeInfo } from '@smurg/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { HOST_USER, T0, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { WorktreeSwitcher } from './index.tsx';
import { formatDateTime } from '../../lib/format.ts';

function setup(role: Role, worktrees: WorktreeInfo[], userId?: string) {
  const conn = new FakeConnection();
  conn.handle('worktree.list', () => ({ worktrees }));
  conn.handle('worktree.merge.list', () => ({ requests: [] }));
  conn.handle('file.tree', () => ({ entries: [], truncated: false }));
  const context = createTestWorkspace({ conn, admit: false });
  conn.admit(makeWelcome({ role, ...(userId ? { userId } : {}) }));
  const result = render(
    <WorkspaceTestProviders context={context}>
      <WorktreeSwitcher />
    </WorkspaceTestProviders>,
  );
  return { ...result, ...context, conn };
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const AMY = makeWorktree({ id: 'wt_amy', branch: 'smurg/amy/wt_amy', sessionId: 'sess_2', sharedDirs: ['data', 'checkpoints'] });
const IAN = makeWorktree({ id: 'wt_ian', ownerUserId: HOST_USER, ownerName: 'Ian', branch: 'smurg/ian/wt_ian', kept: true });

describe('WorktreeSwitcher: main workspace or any worktree, with owner and branch', () => {
  it('renders nothing while there is no worktree', async () => {
    const { container } = setup('editor', []);
    await settle();
    expect(container.querySelector('select')).toBeNull();
  });

  it('lists the main workspace and every worktree with its owner and branch, and switches the file tree', async () => {
    const { stores, conn } = setup('runner', [AMY, IAN]);
    await settle();
    const select = screen.getByLabelText('檢視的工作區') as HTMLSelectElement;
    // Whose worktree and for what (WEB-18: not the branch id, which the details below show); without a known session,
    // when it was created.
    const created = formatDateTime(T0);
    expect([...select.options].map((option) => option.textContent)).toEqual(['主工作區', `我的 worktree（${created} 建立）`, `Ian的 worktree（${created} 建立）`]);
    expect(select.value).toBe('main');

    fireEvent.change(select, { target: { value: 'wt:wt_ian' } });
    expect(stores.files.getState().activeRoot).toEqual({ kind: 'worktree', worktreeId: 'wt_ian' });
    expect(conn.lastRequest('file.tree')?.payload).toMatchObject({ root: { kind: 'worktree', worktreeId: 'wt_ian' }, path: '' });
    const details = screen.getByRole('group', { name: '目前檢視的 worktree' });
    expect(within(details).getByText('擁有者：Ian')).toBeTruthy();
    expect(within(details).getByText('分支：smurg/ian/wt_ian')).toBeTruthy();
    expect(within(details).getByText('已保留（目前沒有 session）')).toBeTruthy();
    // Not the runner's worktree: no merge request, no removal.
    expect(within(details).queryByRole('button')).toBeNull();

    fireEvent.change(select, { target: { value: 'main' } });
    expect(stores.files.getState().activeRoot).toEqual({ kind: 'main' });
  });

  it('the owner sees the shared read-only folders and can ask for a merge from here', async () => {
    const { conn } = setup('runner', [AMY]);
    await settle();
    fireEvent.change(screen.getByLabelText('檢視的工作區'), { target: { value: 'wt:wt_amy' } });
    const details = screen.getByRole('group', { name: '目前檢視的 worktree' });
    expect(within(details).getByText('唯讀的共享資料夾：data、checkpoints')).toBeTruthy();
    expect(within(details).getByText('有 session 正在使用')).toBeTruthy();
    fireEvent.click(within(details).getByRole('button', { name: '請主人合併' }));
    const dialog = screen.getByRole('dialog', { name: '請主人合併 smurg/amy/wt_amy' });
    fireEvent.click(within(dialog).getByRole('button', { name: '送出合併請求' }));
    expect(conn.lastRequest('worktree.merge.request')?.payload).toEqual({ worktreeId: 'wt_amy' });
  });

  it('the host can remove a worktree after a confirmation; a refusal is shown', async () => {
    const { conn } = setup('host', [AMY]);
    await settle();
    fireEvent.change(screen.getByLabelText('檢視的工作區'), { target: { value: 'wt:wt_amy' } });
    fireEvent.click(screen.getByRole('button', { name: '移除這個 worktree' }));
    const dialog = screen.getByRole('alertdialog', { name: '移除 Amy 的 worktree？' });
    expect(within(dialog).getByText(/還沒合併回主工作區的修改會一起消失/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '移除 worktree' }));
    expect(conn.lastRequest('worktree.remove')?.payload).toEqual({ worktreeId: 'wt_amy' });
    await act(async () => {
      conn.fail('worktree.remove', new SmurgError('conflict', '這個 worktree 還有 session 在使用'));
    });
    expect(within(dialog).getByText('無法移除 worktree：這個 worktree 還有 session 在使用')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '移除 worktree' }));
    await act(async () => {
      conn.respond('worktree.remove', {});
    });
    expect(await screen.findByText('已移除 worktree。')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The daemon then announces the removal: the tree falls back to the main workspace.
    act(() => conn.emit('worktree.removed', { worktreeId: 'wt_amy' }));
    await settle();
    expect(screen.queryByLabelText('檢視的工作區')).toBeNull();
  });

  it('keeps the select truthful when the shown worktree disappears from the list', async () => {
    const { conn, stores } = setup('editor', [AMY, IAN]);
    await settle();
    act(() => stores.files.setActiveRoot({ kind: 'worktree', worktreeId: 'wt_gone' }));
    const select = screen.getByLabelText('檢視的工作區') as HTMLSelectElement;
    expect(select.value).toBe('wt:wt_gone');
    expect(select.selectedOptions[0]?.textContent).toBe('已移除的 worktree');
    expect(conn.requestsOf('worktree.list')).toHaveLength(1);
  });
});
