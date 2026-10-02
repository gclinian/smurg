// The files panel in Traditional Chinese: labels, lock badges (names joined the zh-TW way), the dialogs, and the
// order of the tree (the zh-TW collation puts Han before Latin; English does the opposite).
import { MAIN_ROOT } from '@smurg/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { T0, makeAgentLock, makeEntry } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { createManualScheduler, renderInWorkspace } from '../../testing/services.tsx';
import { FilesPanel } from './index.tsx';

useTestLocale('zh-TW');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function renderFiles() {
  const view = renderInWorkspace(<FilesPanel />, { role: 'editor', scheduler: createManualScheduler(T0) });
  const entries = [makeEntry('b.txt'), makeEntry('檔案10.md'), makeEntry('檔案2.md'), makeEntry('src', 'dir')];
  view.conn.handle('file.tree', ({ path }) => ({ entries: path === '' ? entries : [], truncated: false }));
  view.conn.handle('lock.list', () => ({ locks: [] }));
  for (let i = 0; i < 4; i++) await act(flush);
  return view;
}

describe('the files panel in zh-TW', () => {
  it('shows the tree, its badges and its dialogs in Traditional Chinese', async () => {
    const view = await renderFiles();
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(screen.getByRole('tree', { name: '主工作區 的檔案樹' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新增檔案' })).toBeTruthy();
    // Folders first, then the zh-TW collation: Han before Latin, digits compared as numbers.
    expect(screen.getAllByRole('treeitem').map((node) => node.getAttribute('data-row-path'))).toEqual(['src', '檔案2.md', '檔案10.md', 'b.txt']);

    act(() => view.conn.emit('lock.state', { file: { root: MAIN_ROOT, path: 'b.txt' }, lock: makeAgentLock('b.txt') }));
    const row = screen.getByRole('treeitem', { name: /b\.txt/ });
    expect(row.getAttribute('aria-description')).toBe('Claude (Ian) 正在修改這個檔案，暫時無法編輯');
    expect(within(row).getByText('Claude (Ian) 修改中')).toBeTruthy();
    act(() =>
      view.conn.emit('lock.state', {
        file: { root: MAIN_ROOT, path: 'b.txt' },
        lock: {
          kind: 'human',
          file: { root: MAIN_ROOT, path: 'b.txt' },
          holders: [
            { userId: 'dev:amy', displayName: 'Amy', lastActivityAt: T0 },
            { userId: 'dev:bob', displayName: 'Bob', lastActivityAt: T0 },
          ],
          acquiredAt: T0,
        },
      }),
    );
    expect(within(screen.getByRole('treeitem', { name: /b\.txt/ })).getByText('你、Bob 編輯中')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('treeitem', { name: /檔案2\.md/ }), { key: 'F2' });
    const rename = screen.getByRole('dialog', { name: '重新命名「檔案2.md」' });
    fireEvent.change(within(rename).getByLabelText('新名稱'), { target: { value: 'a/b' } });
    expect(within(rename).getByText('名稱不能包含「/」')).toBeTruthy();
    fireEvent.click(within(rename).getByRole('button', { name: '取消' }));

    fireEvent.keyDown(screen.getByRole('treeitem', { name: /檔案2\.md/ }), { key: 'Delete' });
    expect(screen.getByRole('alertdialog', { name: '要刪除「檔案2.md」嗎？' })).toBeTruthy();
  });
});
