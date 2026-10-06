// The files panel in Traditional Chinese: labels, lock badges (names joined the zh-TW way), the dialogs, and the
// order of the tree (the zh-TW collation puts Han before Latin; English does the opposite).
import { MAIN_ROOT } from '@smurg/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { T0, makeAgentLock, makeAgentSession, makeEntry } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { createManualScheduler, renderInWorkspace } from '../../testing/services.tsx';
import { FilesPanel } from './index.tsx';
import { checkNewName, entryBadges } from './tree-model.ts';

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

  it('the list of what the session beside the editor changed, and the read-only folder of a work item, are Traditional Chinese', async () => {
    const view = await renderFiles();
    const session = makeAgentSession({ id: 'sess_free', title: '購物車' });
    view.conn.handle('session.list', () => ({ sessions: [session], hasMore: false }));
    view.conn.handle('session.watch', () => ({ session, events: [], firstSeq: 0, nextSeq: 1, hasEarlier: false, hasMore: false, streaming: [], questions: [], permissions: [], suggestions: [], moreCards: [] }));
    await act(async () => {
      await view.stores.sessions.reload();
    });
    act(() => view.stores.columns.setCodeSession('sess_free'));
    for (let i = 0; i < 4; i++) await act(flush);
    const list = screen.getByRole('region', { name: '購物車 改過的檔案' });
    expect(within(list).getByText('這個 session 改過的檔案')).toBeTruthy();
    expect(within(list).getByText('這個 session 還沒有改過任何檔案。')).toBeTruthy();

    const badge = entryBadges(makeEntry('specs/checkout/SPEC.md'), { lock: null, now: T0, selfUserId: null, isHost: true, itemSlug: 'checkout' })[0];
    expect(badge?.label).toBe('在這裡是唯讀的：這是這個工作項目開始時依據的 spec 和計畫，以及 agent 自己的報告。請到主工作區編輯 spec 和計畫。');
    expect(checkNewName('a.md', 'specs/checkout', [], { isHost: true, itemSlug: 'checkout' })).toEqual({ ok: false, message: '這個資料夾在工作項目的 worktree 裡是唯讀的：裡面是這個項目開始時依據的 spec 和計畫。' });
  });
});
