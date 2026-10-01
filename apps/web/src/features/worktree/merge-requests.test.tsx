import { SmurgError, type MergeRequest, type Role, type WorktreeInfo } from '@smurg/protocol';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { T0, makeMergeRequest, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import type { MergeDiff } from './diff-model.ts';
import { MergeRequestsPanel } from './index.tsx';

const section = (path: string, body = '@@ -1 +1 @@\n-old\n+new\n'): string => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

const COMPLETE: MergeDiff = {
  diff: section('src/app.ts') + section('README.md'),
  truncated: false,
  files: [
    { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'README.md', status: 'modified', additions: 1, deletions: 1 },
  ],
};

/** The daemon cut the diff: b.txt's section may be incomplete and c.txt / d.png are missing. */
const TRUNCATED: MergeDiff = {
  diff: section('a.txt') + section('b.txt'),
  truncated: true,
  files: [
    { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 },
    { path: 'b.txt', status: 'modified', additions: 900, deletions: 20 },
    { path: 'c.txt', status: 'added', additions: 5, deletions: 0 },
    { path: 'd.png', status: 'added', additions: 0, deletions: 0, binary: true },
  ],
};

interface Setup {
  role: Role;
  userId?: string;
  displayName?: string;
  worktrees?: WorktreeInfo[];
  requests?: MergeRequest[];
}

function setup({ role, userId, displayName, worktrees = [makeWorktree()], requests = [makeMergeRequest()] }: Setup) {
  const conn = new FakeConnection();
  conn.handle('worktree.list', () => ({ worktrees }));
  conn.handle('worktree.merge.list', () => ({ requests }));
  const context = createTestWorkspace({ conn, admit: false });
  conn.admit(makeWelcome({ role, ...(userId ? { userId } : {}), ...(displayName ? { displayName } : {}) }));
  const result = render(
    <WorkspaceTestProviders context={context}>
      <MergeRequestsPanel />
    </WorkspaceTestProviders>,
  );
  return { ...result, ...context, conn };
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function openReview(conn: FakeConnection, diff: MergeDiff, button = '審核') {
  fireEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog');
  expect(conn.lastRequest('worktree.merge.diff')?.payload).toEqual({ requestId: 'mr_1' });
  await act(async () => {
    conn.respond('worktree.merge.diff', diff);
  });
  return dialog;
}

describe('MergeRequestsPanel: the host reviews the complete diff (SPEC R9)', () => {
  it('shows the complete file list with additions / deletions and each file’s diff, then merges after a confirmation', async () => {
    const { conn } = setup({ role: 'host' });
    expect(await screen.findByText('Amy 的合併請求')).toBeTruthy();
    const dialog = await openReview(conn, COMPLETE);

    const files = within(dialog).getByRole('navigation', { name: '變更的檔案' });
    expect(within(files).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('src/app.ts'),
      expect.stringContaining('README.md'),
    ]);
    expect(within(files).getAllByText('+1')).toHaveLength(2);
    expect(within(dialog).getByText('共新增 2 行、刪除 2 行')).toBeTruthy();
    // The first file is shown right away, from the whole diff (no extra request).
    expect(within(dialog).getByRole('region', { name: 'src/app.ts 的差異' }).textContent).toContain('+new');
    fireEvent.click(within(files).getByRole('button', { name: /README\.md/ }));
    expect(within(dialog).getByRole('region', { name: 'README.md 的差異' })).toBeTruthy();
    expect(conn.requestsOf('worktree.merge.fileDiff')).toHaveLength(0);

    const approve = within(dialog).getByRole('button', { name: '合併到主工作區' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(within(dialog).getByText(/確定要合併嗎/)).toBeTruthy();
    expect(conn.requestsOf('worktree.merge.approve')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '確認合併' }));
    expect(conn.lastRequest('worktree.merge.approve')?.payload).toEqual({ requestId: 'mr_1' });
    await act(async () => {
      conn.respond('worktree.merge.approve', { request: makeMergeRequest({ status: 'merged', decidedAt: T0 + 1 }) });
    });
    expect(await screen.findByText('已把 Amy 的修改合併到主工作區。')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('已合併')).toBeTruthy();
  });

  it('approve disabled until truncated files were opened (worktree.merge.fileDiff, one by one)', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, TRUNCATED);
    const approve = () => within(dialog).getByRole('button', { name: '合併到主工作區' }) as HTMLButtonElement;

    expect(within(dialog).getByText(/完整差異超過 1 MiB/)).toBeTruthy();
    expect(within(dialog).getByText('還有 3 個檔案需要個別開啟檢視，之後才能合併。')).toBeTruthy();
    expect(within(dialog).getAllByText('需要個別開啟')).toHaveLength(3);
    expect(approve().disabled).toBe(true);
    expect(approve().getAttribute('aria-describedby')).toBeTruthy();

    // b.txt: its section in the cut diff is not trusted — it is fetched on its own.
    fireEvent.click(within(dialog).getByRole('button', { name: /b\.txt/ }));
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'b.txt' });
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'b.txt', diff: section('b.txt', '@@ -1 +1 @@\n-x\n+the whole file\n'), truncated: false, binary: false });
    });
    expect(within(dialog).getByRole('region', { name: 'b.txt 的差異' }).textContent).toContain('+the whole file');
    expect(within(dialog).getByText('還有 2 個檔案需要個別開啟檢視，之後才能合併。')).toBeTruthy();
    expect(approve().disabled).toBe(true);

    // A failed fetch does not count as opened.
    fireEvent.click(within(dialog).getByRole('button', { name: '開啟下一個未檢視的檔案' }));
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'c.txt' });
    await act(async () => {
      conn.fail('worktree.merge.fileDiff', new SmurgError('internal', '產生 diff 失敗'));
    });
    expect(within(dialog).getByText('無法載入 c.txt 的差異：產生 diff 失敗')).toBeTruthy();
    expect(approve().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '重試' }));
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'c.txt', diff: section('c.txt', '@@ -0,0 +1 @@\n+new file\n'), truncated: false, binary: false });
    });
    expect(approve().disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: '開啟下一個未檢視的檔案' }));
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'd.png' });
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'd.png', diff: 'diff --git a/d.png b/d.png\nBinary files /dev/null and b/d.png differ\n', truncated: false, binary: true });
    });
    expect(within(dialog).getByText('二進位檔案，無法顯示文字差異。')).toBeTruthy();
    expect(within(dialog).getByText('所有需要個別開啟的檔案都已檢視。')).toBeTruthy();
    expect(within(dialog).getAllByText('已檢視')).toHaveLength(3);
    expect(approve().disabled).toBe(false);
    expect(conn.requestsOf('worktree.merge.fileDiff')).toHaveLength(4);
  });

  it('a file whose own diff is cut too is shown with a warning (and counts as opened)', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, { diff: '', truncated: true, files: [{ path: 'huge.sql', status: 'added', additions: 90_000, deletions: 0 }] });
    // The only file is selected (and so fetched) at once.
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'huge.sql' });
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'huge.sql', diff: section('huge.sql', '@@ -0,0 +1,3 @@\n+a\n+b\n+c\n'), truncated: true, binary: false });
    });
    expect(within(dialog).getByText('這個檔案的差異超過 1 MiB，只顯示前面的部分。')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '合併到主工作區' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('makes invisible characters visible in the diff (bidi controls cannot hide code from the review)', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, {
      diff: section('auth.ts', '@@ -1 +1 @@\n-ok\n+if (isAdmin) { ‮} ⁦// check later⁩ {\n'),
      truncated: false,
      files: [{ path: 'auth.ts', status: 'modified', additions: 1, deletions: 1 }],
    });
    expect(within(dialog).getByText(/含有看不見的字元/)).toBeTruthy();
    const diff = within(dialog).getByRole('region', { name: 'auth.ts 的差異' });
    expect(within(diff).getByTitle('看不見的字元 U+202E').textContent).toBe('⟨U+202E⟩');
    expect(within(diff).getByTitle('看不見的字元 U+2066')).toBeTruthy();
    expect(diff.textContent).not.toContain('‮');
  });

  it('on conflict lists the conflicting files and what the host can do next; the dialog stays open', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, COMPLETE);
    fireEvent.click(within(dialog).getByRole('button', { name: '合併到主工作區' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '確認合併' }));
    await act(async () => {
      conn.respond('worktree.merge.approve', { request: makeMergeRequest({ status: 'conflict', conflictFiles: ['src/app.ts', 'docs/設計.md'], decidedAt: T0 + 1 }) });
    });
    expect(await screen.findByText('合併時發生衝突，已中止合併，主工作區沒有改變。')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByText('docs/設計.md')).toBeTruthy();
    // SPEC-03: never the impossible advice to merge main into the worktree (guests cannot write any .git).
    expect(within(dialog).getByText(/接下來你可以：在自己的終端機裡手動合併並解決衝突/)).toBeTruthy();
    expect(dialog.textContent).not.toContain('整合主工作區');
    // The host may try again after adjusting the main workspace, or reject.
    expect(within(dialog).getByRole('button', { name: '重新嘗試合併' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '拒絕' })).toBeTruthy();
  });

  it('rejects with a reason (validated, one line) and shows a refused decision as an error', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, COMPLETE);
    fireEvent.click(within(dialog).getByRole('button', { name: '拒絕' }));
    const reason = within(dialog).getByLabelText('拒絕原因（選填，會告訴 Amy）');
    fireEvent.change(reason, { target: { value: '請先補測試\u0007' } });
    expect(within(dialog).getByText(/原因只能有一行/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '確認拒絕' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: '  請先補上測試  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確認拒絕' }));
    expect(conn.lastRequest('worktree.merge.reject')?.payload).toEqual({ requestId: 'mr_1', reason: '請先補上測試' });
    await act(async () => {
      conn.fail('worktree.merge.reject', new SmurgError('conflict', '這個請求已經被處理'));
    });
    expect(within(dialog).getByText('無法完成：這個請求已經被處理')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '確認拒絕' }));
    await act(async () => {
      conn.respond('worktree.merge.reject', { request: makeMergeRequest({ status: 'rejected', rejectReason: '請先補上測試', decidedAt: T0 + 1 }) });
    });
    expect(await screen.findByText('已拒絕 Amy 的合併請求，worktree 保持原狀。')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the diff load error with a retry', async () => {
    const { conn } = setup({ role: 'host' });
    fireEvent.click(await screen.findByRole('button', { name: '審核' }));
    await act(async () => {
      conn.fail('worktree.merge.diff', new SmurgError('conflict', '這個 worktree 與主工作區沒有共同的歷史，無法合併'));
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('無法載入差異：這個 worktree 與主工作區沒有共同的歷史，無法合併')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '合併到主工作區' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '重新載入' }));
    expect(conn.requestsOf('worktree.merge.diff')).toHaveLength(2);
  });
});

describe('MergeRequestsPanel: the requester', () => {
  it('status visible to requester: pending, then the host’s rejection with its reason, live', async () => {
    const { conn } = setup({ role: 'agent' });
    expect(await screen.findByText('等待主人審核')).toBeTruthy();
    expect(screen.getByText(/主人審核中/)).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'rejected', rejectReason: '請先補上測試', decidedAt: T0 + 5 }) }));
    expect(screen.getByText('已拒絕')).toBeTruthy();
    expect(screen.getByText('主人拒絕了這個請求，worktree 保持原狀。原因：請先補上測試')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ id: 'mr_1', status: 'conflict', conflictFiles: ['a.txt'] }) }));
    expect(screen.getByText(/主人會決定怎麼處理/)).toBeTruthy();
  });

  it('the requester is told when the host decides, wherever they are; others are not (WEB-11)', async () => {
    const { conn } = setup({ role: 'agent' });
    expect(await screen.findByText('等待主人審核')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'merged', decidedAt: T0 + 5 }) }));
    expect(await screen.findByText('主人已把你的合併請求合併到主工作區。')).toBeTruthy();
  });

  it('a rejection reaches the requester with its reason, as a notice (WEB-11)', async () => {
    const { conn } = setup({ role: 'agent' });
    expect(await screen.findByText('等待主人審核')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'rejected', rejectReason: '請先補上測試', decidedAt: T0 + 5 }) }));
    expect(await screen.findByText('主人拒絕了你的合併請求。')).toBeTruthy();
    expect(screen.getByText('原因：請先補上測試')).toBeTruthy();
  });

  it('another member hears nothing about a merge that is not theirs (WEB-11)', async () => {
    const { conn } = setup({ role: 'editor', userId: 'dev:bob', displayName: 'Bob' });
    expect(await screen.findByText('Amy 的合併請求')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'merged', decidedAt: T0 + 5 }) }));
    await flush();
    expect(screen.queryByText('主人已把你的合併請求合併到主工作區。')).toBeNull();
  });

  it('can open the diff read-only (no approve / reject)', async () => {
    const { conn } = setup({ role: 'agent' });
    const dialog = await openReview(conn, COMPLETE, '查看差異');
    expect(within(dialog).queryByRole('button', { name: '合併到主工作區' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '拒絕' })).toBeNull();
    expect(within(dialog).getByRole('region', { name: 'src/app.ts 的差異' })).toBeTruthy();
  });

  it('another 可使用 agent member may read the diff too (read-only); an editor may not open it', async () => {
    const other = setup({ role: 'agent', userId: 'dev:bob', displayName: 'Bob' });
    const dialog = await openReview(other.conn, COMPLETE, '查看差異');
    expect(within(dialog).queryByRole('button', { name: '合併到主工作區' })).toBeNull();
    other.unmount();
    setup({ role: 'editor', userId: 'dev:cat', displayName: 'Cat' });
    expect(await screen.findByText('Amy 的合併請求')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看差異' })).toBeNull();
  });

  it('requests a merge of their worktree with a message', async () => {
    const { conn } = setup({ role: 'agent', requests: [] });
    fireEvent.click(await screen.findByRole('button', { name: '請求合併' }));
    const dialog = screen.getByRole('dialog', { name: '請主人合併 smurg/amy/wt_1' });
    fireEvent.change(within(dialog).getByLabelText('說明（選填）'), { target: { value: '新增登入頁\n並補上測試' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '送出合併請求' }));
    expect(conn.lastRequest('worktree.merge.request')?.payload).toEqual({ worktreeId: 'wt_1', message: '新增登入頁\n並補上測試' });
    await act(async () => {
      conn.respond('worktree.merge.request', { request: makeMergeRequest({ message: '新增登入頁\n並補上測試' }) });
    });
    expect(await screen.findByText('已送出合併請求，等待主人審核。')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('等待主人審核')).toBeTruthy();
    expect(screen.getByText('已有等待審核的請求')).toBeTruthy();
  });

  it('shows the daemon’s refusal of a merge request', async () => {
    const { conn } = setup({ role: 'agent', requests: [] });
    fireEvent.click(await screen.findByRole('button', { name: '請求合併' }));
    fireEvent.click(screen.getByRole('button', { name: '送出合併請求' }));
    expect(conn.lastRequest('worktree.merge.request')?.payload).toEqual({ worktreeId: 'wt_1' });
    await act(async () => {
      conn.fail('worktree.merge.request', new SmurgError('host_only', '合併內容包含只有主人可以修改的檔案，請先移除：.claude/settings.json'));
    });
    expect(screen.getByText('無法送出合併請求：合併內容包含只有主人可以修改的檔案，請先移除：.claude/settings.json')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('another member sees the list but cannot open the diff or request a merge', async () => {
    setup({ role: 'editor', userId: 'dev:bob', displayName: 'Bob' });
    expect(await screen.findByText('Amy 的合併請求')).toBeTruthy();
    await flush();
    expect(screen.queryByRole('button', { name: '查看差異' })).toBeNull();
    expect(screen.queryByRole('button', { name: '審核' })).toBeNull();
    expect(screen.queryByRole('button', { name: '請求合併' })).toBeNull();
  });
});
