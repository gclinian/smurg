import { SmurgError, type Role, type WorktreeInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
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
    const { stores, conn } = setup('agent', [AMY, IAN]);
    await settle();
    const select = screen.getByLabelText('Viewing') as HTMLSelectElement;
    // Whose worktree and for what (not the branch id, which the details below show); without a known session,
    // when it was created.
    const created = formatDateTime(T0);
    expect([...select.options].map((option) => option.textContent)).toEqual(['Main workspace', `My worktree (created ${created})`, `Ian's worktree (created ${created})`]);
    expect(select.value).toBe('main');

    fireEvent.change(select, { target: { value: 'wt:wt_ian' } });
    expect(stores.files.getState().activeRoot).toEqual({ kind: 'worktree', worktreeId: 'wt_ian' });
    expect(conn.lastRequest('file.tree')?.payload).toMatchObject({ root: { kind: 'worktree', worktreeId: 'wt_ian' }, path: '' });
    const details = screen.getByRole('group', { name: 'Worktree in view' });
    expect(within(details).getByText('Owner: Ian')).toBeTruthy();
    expect(within(details).getByText('Branch: smurg/ian/wt_ian')).toBeTruthy();
    expect(within(details).getByText('Kept (no session at the moment)')).toBeTruthy();
    // Not this member's worktree: no merge request, no removal.
    expect(within(details).queryByRole('button')).toBeNull();

    fireEvent.change(select, { target: { value: 'main' } });
    expect(stores.files.getState().activeRoot).toEqual({ kind: 'main' });
  });

  it('the owner sees the shared read-only folders and can ask for a merge from here', async () => {
    const { conn } = setup('agent', [AMY]);
    await settle();
    fireEvent.change(screen.getByLabelText('Viewing'), { target: { value: 'wt:wt_amy' } });
    const details = screen.getByRole('group', { name: 'Worktree in view' });
    expect(within(details).getByText('Read-only shared folders: data, checkpoints')).toBeTruthy();
    expect(within(details).getByText('A session is using it')).toBeTruthy();
    fireEvent.click(within(details).getByRole('button', { name: 'Ask the host to merge' }));
    const dialog = screen.getByRole('dialog', { name: 'Ask the host to merge smurg/amy/wt_amy' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send merge request' }));
    expect(conn.lastRequest('worktree.merge.request')?.payload).toEqual({ worktreeId: 'wt_amy' });
  });

  it('the host can remove a worktree after a confirmation; a refusal is shown', async () => {
    const { conn } = setup('host', [AMY]);
    await settle();
    fireEvent.change(screen.getByLabelText('Viewing'), { target: { value: 'wt:wt_amy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove this worktree' }));
    const dialog = screen.getByRole('alertdialog', { name: "Remove Amy's worktree?" });
    expect(within(dialog).getByText(/together with any changes not yet merged into the main workspace/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove worktree' }));
    expect(conn.lastRequest('worktree.remove')?.payload).toEqual({ worktreeId: 'wt_amy' });
    await act(async () => {
      conn.fail('worktree.remove', new SmurgError('conflict', msg('worktree.inUse')));
    });
    expect(within(dialog).getByText('Could not remove the worktree: A session is using this worktree. End the session first.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove worktree' }));
    await act(async () => {
      conn.respond('worktree.remove', {});
    });
    expect(await screen.findByText('Worktree removed.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The daemon then announces the removal: the tree falls back to the main workspace.
    act(() => conn.emit('worktree.removed', { worktreeId: 'wt_amy' }));
    await settle();
    expect(screen.queryByLabelText('Viewing')).toBeNull();
  });

  it('keeps the select truthful when the shown worktree disappears from the list', async () => {
    const { conn, stores } = setup('editor', [AMY, IAN]);
    await settle();
    act(() => stores.files.setActiveRoot({ kind: 'worktree', worktreeId: 'wt_gone' }));
    const select = screen.getByLabelText('Viewing') as HTMLSelectElement;
    expect(select.value).toBe('wt:wt_gone');
    expect(select.selectedOptions[0]?.textContent).toBe('Removed worktree');
    expect(conn.requestsOf('worktree.list')).toHaveLength(1);
  });
});
