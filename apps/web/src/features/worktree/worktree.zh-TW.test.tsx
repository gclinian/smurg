// The worktree feature in Traditional Chinese: the merge requests list, the review dialog and the root switcher show
// the zh-TW table, counted keys keep their numbers, and a refusal of the host is rendered from its message reference.
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { makeMergeRequest, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { useTestLocale } from '../../testing/locale.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import { t as tTopics } from '../topics/strings.ts';
import type { MergeDiff } from './diff-model.ts';
import { MergeRequestsSection, WorktreeSwitcher } from './index.tsx';

useTestLocale('zh-TW');

const section = (path: string): string => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

const DIFF: MergeDiff = {
  diff: section('src/app.ts') + section('README.md'),
  truncated: false,
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'README.md', status: 'modified', additions: 1, deletions: 1 },
  ],
};

function setup(panel: 'requests' | 'switcher') {
  const conn = new FakeConnection();
  conn.handle('worktree.list', () => ({ worktrees: [makeWorktree({ sharedDirs: ['data', 'checkpoints'] })] }));
  conn.handle('worktree.merge.list', () => ({ requests: [makeMergeRequest()] }));
  conn.handle('file.tree', () => ({ entries: [], truncated: false }));
  const context = createTestWorkspace({ conn, admit: false });
  conn.admit(makeWelcome({ role: 'host' }));
  render(<WorkspaceTestProviders context={context}>{panel === 'requests' ? <MergeRequestsSection /> : <WorktreeSwitcher />}</WorkspaceTestProviders>);
  return { ...context, conn };
}

describe('the worktree feature in zh-TW', () => {
  it('lists a merge request and reviews its diff in Traditional Chinese', async () => {
    const { conn } = setup('requests');
    expect(document.documentElement.lang).toBe('zh-Hant-TW');
    expect(await screen.findByText('Amy 的合併請求')).toBeTruthy();
    expect(screen.getByText('等待主人審核')).toBeTruthy();
    expect(screen.getByText('等待審核（1）')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '審核' }));
    const dialog = await screen.findByRole('dialog', { name: '審核 Amy 的合併請求' });
    await act(async () => {
      conn.respond('worktree.merge.diff', DIFF);
    });
    expect(within(dialog).getByRole('navigation', { name: '變更的檔案' })).toBeTruthy();
    expect(within(dialog).getByText('共新增 2 行、刪除 2 行')).toBeTruthy();
    expect(within(dialog).getByText(/· 2 個檔案$/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'src/app.ts 的差異' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '合併到主工作區' }));
    expect(within(dialog).getByText(/（2 個檔案）合併到主工作區.*確定要合併嗎？/)).toBeTruthy();
  });

  it('renders what the host refused from its message reference, in the language of the viewer', async () => {
    const { conn } = setup('requests');
    fireEvent.click(await screen.findByRole('button', { name: '審核' }));
    await act(async () => {
      conn.fail('worktree.merge.diff', new SmurgError('conflict', msg('merge.unrelatedHistories')));
    });
    expect(within(screen.getByRole('dialog')).getByText('無法載入差異：這個 worktree 與主工作區沒有共同的歷史，無法合併')).toBeTruthy();
  });

  it('a work item\'s conflict names the way through its agent with the label the plan and the report use', async () => {
    const conn = new FakeConnection();
    conn.handle('worktree.list', () => ({ worktrees: [makeWorktree()] }));
    conn.handle('worktree.merge.list', () => ({ requests: [makeMergeRequest({ status: 'conflict', conflictFiles: ['src/app.ts'], topicId: 'tp_1', itemId: 'cart-api' })] }));
    const context = createTestWorkspace({ conn, admit: false });
    conn.admit(makeWelcome({ role: 'host' }));
    render(
      <WorkspaceTestProviders context={context}>
        <MergeRequestsSection />
      </WorkspaceTestProviders>,
    );
    const sentence = await screen.findByText(/^這是工作項目的變更，所以它的 agent 可以解決衝突/);
    expect(sentence.textContent).toContain(`「${tTopics('item.resolve')}」`);
  });

  it('the root switcher joins the shared folders the zh-TW way', async () => {
    setup('switcher');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const select = screen.getByLabelText('檢視的工作區') as HTMLSelectElement;
    expect(select.options[0]?.textContent).toBe('主工作區');
    fireEvent.change(select, { target: { value: 'wt:wt_1' } });
    const details = screen.getByRole('group', { name: '目前檢視的 worktree' });
    expect(within(details).getByText('唯讀的共享資料夾：data、checkpoints')).toBeTruthy();
    expect(within(details).getByRole('button', { name: '移除這個 worktree' })).toBeTruthy();
  });
});
