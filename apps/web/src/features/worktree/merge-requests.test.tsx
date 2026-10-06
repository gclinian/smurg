import { SmurgError, type MergeRequest, type Role, type WorktreeInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { T0, makeMergeRequest, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import type { MergeDiff } from './diff-model.ts';
import { MergeRequestsSection } from './index.tsx';
import MergeNotices from './MergeNotices.tsx';

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
      <MergeRequestsSection />
      <MergeNotices />
    </WorkspaceTestProviders>,
  );
  return { ...result, ...context, conn };
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function openReview(conn: FakeConnection, diff: MergeDiff, button = 'Review') {
  fireEvent.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog');
  expect(conn.lastRequest('worktree.merge.diff')?.payload).toEqual({ requestId: 'mr_1' });
  await act(async () => {
    conn.respond('worktree.merge.diff', diff);
  });
  return dialog;
}

describe('merge requests: the host reviews the complete diff (SPEC R9)', () => {
  it('shows the complete file list with additions / deletions and each file’s diff, then merges after a confirmation', async () => {
    const { conn } = setup({ role: 'host' });
    expect(await screen.findByText('Merge request from Amy')).toBeTruthy();
    const dialog = await openReview(conn, COMPLETE);

    const files = within(dialog).getByRole('navigation', { name: 'Changed files' });
    expect(within(files).getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('src/app.ts'),
      expect.stringContaining('README.md'),
    ]);
    expect(within(files).getAllByText('+1')).toHaveLength(2);
    expect(within(dialog).getByText('2 lines added, 2 lines deleted in total')).toBeTruthy();
    // The first file is shown right away, from the whole diff (no extra request).
    expect(within(dialog).getByRole('region', { name: 'Diff of src/app.ts' }).textContent).toContain('+new');
    fireEvent.click(within(files).getByRole('button', { name: /README\.md/ }));
    expect(within(dialog).getByRole('region', { name: 'Diff of README.md' })).toBeTruthy();
    expect(conn.requestsOf('worktree.merge.fileDiff')).toHaveLength(0);

    const approve = within(dialog).getByRole('button', { name: 'Merge into the main workspace' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(within(dialog).getByText(/Commit .* \(2 files\) will be merged into the main workspace.* Merge it\?/)).toBeTruthy();
    expect(conn.requestsOf('worktree.merge.approve')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm merge' }));
    expect(conn.lastRequest('worktree.merge.approve')?.payload).toEqual({ requestId: 'mr_1' });
    await act(async () => {
      conn.respond('worktree.merge.approve', { request: makeMergeRequest({ status: 'merged', decidedAt: T0 + 1 }) });
    });
    expect(await screen.findByText('The changes from Amy were merged into the main workspace.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Merged')).toBeTruthy();
  });

  it('approve disabled until truncated files were opened (worktree.merge.fileDiff, one by one)', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, TRUNCATED);
    const approve = () => within(dialog).getByRole('button', { name: 'Merge into the main workspace' }) as HTMLButtonElement;

    expect(within(dialog).getByText(/The full diff is larger than 1 MiB/)).toBeTruthy();
    expect(within(dialog).getByText('3 files still have to be opened before you can merge.')).toBeTruthy();
    expect(within(dialog).getAllByText('Open separately')).toHaveLength(3);
    expect(approve().disabled).toBe(true);
    expect(approve().getAttribute('aria-describedby')).toBeTruthy();

    // b.txt: its section in the cut diff is not trusted — it is fetched on its own.
    fireEvent.click(within(dialog).getByRole('button', { name: /b\.txt/ }));
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'b.txt' });
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'b.txt', diff: section('b.txt', '@@ -1 +1 @@\n-x\n+the whole file\n'), truncated: false, binary: false });
    });
    expect(within(dialog).getByRole('region', { name: 'Diff of b.txt' }).textContent).toContain('+the whole file');
    expect(within(dialog).getByText('2 files still have to be opened before you can merge.')).toBeTruthy();
    expect(approve().disabled).toBe(true);

    // A failed fetch does not count as opened.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the next unviewed file' }));
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'c.txt' });
    await act(async () => {
      conn.fail('worktree.merge.fileDiff', new SmurgError('not_found', msg('merge.pathNotInDiff')));
    });
    expect(within(dialog).getByText("Could not load the diff of c.txt: This file is not among the merge request's changes.")).toBeTruthy();
    expect(approve().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'c.txt', diff: section('c.txt', '@@ -0,0 +1 @@\n+new file\n'), truncated: false, binary: false });
    });
    expect(approve().disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the next unviewed file' }));
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'd.png' });
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'd.png', diff: 'diff --git a/d.png b/d.png\nBinary files /dev/null and b/d.png differ\n', truncated: false, binary: true });
    });
    expect(within(dialog).getByText('Binary file; there is no text diff to show.')).toBeTruthy();
    expect(within(dialog).getByText('Every file that had to be opened separately has been viewed.')).toBeTruthy();
    expect(within(dialog).getAllByText('Viewed')).toHaveLength(3);
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
    expect(within(dialog).getByText('The diff of this file is larger than 1 MiB; only the first part is shown.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Merge into the main workspace' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('makes invisible characters visible in the diff (bidi controls cannot hide code from the review)', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, {
      diff: section('auth.ts', '@@ -1 +1 @@\n-ok\n+if (isAdmin) { ‮} ⁦// check later⁩ {\n'),
      truncated: false,
      files: [{ path: 'auth.ts', status: 'modified', additions: 1, deletions: 1 }],
    });
    expect(within(dialog).getByText(/contains invisible characters/)).toBeTruthy();
    const diff = within(dialog).getByRole('region', { name: 'Diff of auth.ts' });
    expect(within(diff).getByTitle('Invisible character U+202E').textContent).toBe('⟨U+202E⟩');
    expect(within(diff).getByTitle('Invisible character U+2066')).toBeTruthy();
    expect(diff.textContent).not.toContain('‮');
  });

  it('on conflict lists the conflicting files and what the host can do next; the dialog stays open', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, COMPLETE);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge into the main workspace' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm merge' }));
    await act(async () => {
      conn.respond('worktree.merge.approve', { request: makeMergeRequest({ status: 'conflict', conflictFiles: ['src/app.ts', 'docs/設計.md'], decidedAt: T0 + 1 }) });
    });
    expect(await screen.findByText('The merge ran into conflicts and was aborted. The main workspace is unchanged.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByText('docs/設計.md')).toBeTruthy();
    // Never the impossible advice to merge main into the worktree (guests cannot write any .git).
    expect(within(dialog).getByText(/What you can do next: merge by hand in your own terminal and resolve the conflicts/)).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/into the worktree|into your worktree/);
    // The host may try again after adjusting the main workspace, or reject.
    expect(within(dialog).getByRole('button', { name: 'Try the merge again' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('rejects with a reason (validated, one line) and shows a refused decision as an error', async () => {
    const { conn } = setup({ role: 'host' });
    const dialog = await openReview(conn, COMPLETE);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    const reason = within(dialog).getByLabelText('Reason for rejecting (optional; Amy will see it)');
    fireEvent.change(reason, { target: { value: '請先補測試\u0007' } });
    expect(within(dialog).getByText(/The reason must be one line/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason, { target: { value: '  請先補上測試  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm rejection' }));
    expect(conn.lastRequest('worktree.merge.reject')?.payload).toEqual({ requestId: 'mr_1', reason: '請先補上測試' });
    await act(async () => {
      conn.fail('worktree.merge.reject', new SmurgError('conflict', msg('merge.notPending')));
    });
    expect(within(dialog).getByText('Could not finish: This merge request was already handled.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm rejection' }));
    await act(async () => {
      conn.respond('worktree.merge.reject', { request: makeMergeRequest({ status: 'rejected', rejectReason: '請先補上測試', decidedAt: T0 + 1 }) });
    });
    expect(await screen.findByText('The merge request from Amy was rejected. The worktree is unchanged.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the diff load error with a retry', async () => {
    const { conn } = setup({ role: 'host' });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await act(async () => {
      conn.fail('worktree.merge.diff', new SmurgError('conflict', msg('merge.unrelatedHistories')));
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Could not load the diff: This worktree shares no history with the main workspace, so it cannot be merged.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Merge into the main workspace' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    expect(conn.requestsOf('worktree.merge.diff')).toHaveLength(2);
  });
});

describe('merge requests: the requester', () => {
  it('status visible to requester: pending, then the host’s rejection with its reason, live', async () => {
    const { conn } = setup({ role: 'agent' });
    expect(await screen.findByText('Waiting for the host')).toBeTruthy();
    expect(screen.getByText(/The host is reviewing it/)).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'rejected', rejectReason: '請先補上測試', decidedAt: T0 + 5 }) }));
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByText('The host rejected this request; the worktree is unchanged. Reason: 請先補上測試')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ id: 'mr_1', status: 'conflict', conflictFiles: ['a.txt'] }) }));
    expect(screen.getByText(/The host decides what happens next/)).toBeTruthy();
  });

  it('the requester is told when the host decides, wherever they are; others are not', async () => {
    const { conn } = setup({ role: 'agent' });
    expect(await screen.findByText('Waiting for the host')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'merged', decidedAt: T0 + 5 }) }));
    expect(await screen.findByText('The host merged your merge request into the main workspace.')).toBeTruthy();
  });

  it('a rejection reaches the requester with its reason, as a notice', async () => {
    const { conn } = setup({ role: 'agent' });
    expect(await screen.findByText('Waiting for the host')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'rejected', rejectReason: '請先補上測試', decidedAt: T0 + 5 }) }));
    expect(await screen.findByText('The host rejected your merge request.')).toBeTruthy();
    expect(screen.getByText('Reason: 請先補上測試')).toBeTruthy();
  });

  it('another member hears nothing about a merge that is not theirs', async () => {
    const { conn } = setup({ role: 'editor', userId: 'dev:bob', displayName: 'Bob' });
    expect(await screen.findByText('Merge request from Amy')).toBeTruthy();
    act(() => conn.emit('worktree.merge.updated', { request: makeMergeRequest({ status: 'merged', decidedAt: T0 + 5 }) }));
    await flush();
    expect(screen.queryByText('The host merged your merge request into the main workspace.')).toBeNull();
  });

  it('can open the diff read-only (no approve / reject)', async () => {
    const { conn } = setup({ role: 'agent' });
    const dialog = await openReview(conn, COMPLETE, 'View diff');
    expect(within(dialog).queryByRole('button', { name: 'Merge into the main workspace' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(within(dialog).getByRole('region', { name: 'Diff of src/app.ts' })).toBeTruthy();
  });

  it('every member may read the diff (read-only): another member with agent access, and an editor', async () => {
    const other = setup({ role: 'agent', userId: 'dev:bob', displayName: 'Bob' });
    const dialog = await openReview(other.conn, COMPLETE, 'View diff');
    expect(within(dialog).queryByRole('button', { name: 'Merge into the main workspace' })).toBeNull();
    other.unmount();
    const editor = setup({ role: 'editor', userId: 'dev:cat', displayName: 'Cat' });
    expect(await screen.findByText('Merge request from Amy')).toBeTruthy();
    const view = await openReview(editor.conn, COMPLETE, 'View diff');
    expect(within(view).queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('requests a merge of their worktree with a message', async () => {
    const { conn } = setup({ role: 'agent', requests: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Request merge' }));
    const dialog = screen.getByRole('dialog', { name: 'Ask the host to merge smurg/amy/wt_1' });
    fireEvent.change(within(dialog).getByLabelText('Message (optional)'), { target: { value: '新增登入頁\n並補上測試' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send merge request' }));
    expect(conn.lastRequest('worktree.merge.request')?.payload).toEqual({ worktreeId: 'wt_1', message: '新增登入頁\n並補上測試' });
    await act(async () => {
      conn.respond('worktree.merge.request', { request: makeMergeRequest({ message: '新增登入頁\n並補上測試' }) });
    });
    expect(await screen.findByText('Merge request sent. Waiting for the host to review it.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('Waiting for the host')).toBeTruthy();
    expect(screen.getByText('A request is waiting for review')).toBeTruthy();
  });

  it('shows the daemon’s refusal of a merge request', async () => {
    const { conn } = setup({ role: 'agent', requests: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Request merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send merge request' }));
    expect(conn.lastRequest('worktree.merge.request')?.payload).toEqual({ worktreeId: 'wt_1' });
    await act(async () => {
      conn.fail('worktree.merge.request', new SmurgError('host_only', msg('merge.containsHostOnly', { paths: ['.claude/settings.json'] })));
    });
    expect(screen.getByText('Could not send the merge request: The merge contains files only the host can change. Remove them first: .claude/settings.json')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('another member sees the list and may read the diff, but cannot decide or request a merge', async () => {
    setup({ role: 'editor', userId: 'dev:bob', displayName: 'Bob' });
    expect(await screen.findByText('Merge request from Amy')).toBeTruthy();
    await flush();
    expect(screen.getByRole('button', { name: 'View diff' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request merge' })).toBeNull();
  });
});

describe('merge requests: the draft behind a result report', () => {
  const draft = (overrides: Partial<MergeRequest> = {}): MergeRequest => {
    const { requestedBy: _nobody, ...rest } = makeMergeRequest({ status: 'draft', topicId: 'tp_1', itemId: 'cart-api', ...overrides });
    return rest;
  };

  it('a draft nobody reviewed is listed apart; a reviewed one waits for the host like a request', async () => {
    setup({ role: 'host', requests: [draft({ id: 'mr_a' }), draft({ id: 'mr_b', worktreeId: 'wt_2', reviewed: true })] });
    const waiting = await screen.findByRole('region', { name: 'Waiting for review (1)' });
    expect(within(waiting).getByText('Reviewed, ready to merge')).toBeTruthy();
    expect(within(waiting).getByText('Changes of a work item')).toBeTruthy();
    const drafts = screen.getByRole('region', { name: 'Work items nobody reviewed yet' });
    expect(within(drafts).getByText('Not requested yet')).toBeTruthy();
  });

  it('the host may merge a draft directly: the review names the branch, not a requester', async () => {
    const { conn } = setup({ role: 'host', requests: [draft()] });
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Changes on smurg/amy/wt_1' });
    await act(async () => {
      conn.respond('worktree.merge.diff', COMPLETE);
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge into the main workspace' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm merge' }));
    expect(conn.lastRequest('worktree.merge.approve')?.payload).toEqual({ requestId: 'mr_1' });
    await act(async () => {
      conn.respond('worktree.merge.approve', { request: makeMergeRequest({ status: 'merged', decidedAt: T0 + 9 }) });
    });
    expect(await screen.findByText('The changes were merged into the main workspace.')).toBeTruthy();
  });

  it('a file on a host-private path is listed, and its diff is withheld from anyone but the host', async () => {
    const { conn } = setup({ role: 'editor', userId: 'dev:cat', displayName: 'Cat' });
    fireEvent.click(await screen.findByRole('button', { name: 'View diff' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      conn.respond('worktree.merge.diff', { diff: '', truncated: false, files: [{ path: 'CLAUDE.md', status: 'modified', additions: 0, deletions: 0, hidden: true }] });
    });
    expect(within(dialog).getByText('This file is on a path only the host may read. Its changes are not shown to you.')).toBeTruthy();
  });
});
