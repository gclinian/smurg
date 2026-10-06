// The changed files of a result report (ChangedFiles.tsx) and the review inside a column (MergeReviewPanel).
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FakeConnection } from '../../testing/fake-connection.ts';
import { makeMergeRequest, makeWelcome, makeWorktree } from '../../testing/fixtures.ts';
import { WorkspaceTestProviders, createTestWorkspace } from '../../testing/services.tsx';
import type { MergeDiff } from './diff-model.ts';
import { ChangedFiles, MergeReviewPanel } from './index.tsx';

const section = (path: string): string => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

const DIFF: MergeDiff = {
  diff: section('src/pay.ts'),
  truncated: true,
  files: [
    { path: 'src/pay.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'src/queue.ts', status: 'added', additions: 28, deletions: 0 },
    { path: 'old.ts', status: 'deleted', additions: 0, deletions: 9 },
    { path: 'CLAUDE.md', status: 'modified', additions: 0, deletions: 0, hidden: true },
  ],
};

function setup(ui: React.ReactElement, role: 'host' | 'editor' = 'editor') {
  const conn = new FakeConnection();
  conn.handle('worktree.list', () => ({ worktrees: [makeWorktree()] }));
  conn.handle('worktree.merge.list', () => ({ requests: [makeMergeRequest()] }));
  const context = createTestWorkspace({ conn, admit: false });
  conn.admit(makeWelcome({ role }));
  const result = render(<WorkspaceTestProviders context={context}>{ui}</WorkspaceTestProviders>);
  return { ...result, conn };
}

describe('ChangedFiles: the Changes of a result report', () => {
  it('lists every file with its counts, who edited it by hand, and unfolds a diff on demand', async () => {
    const onOpenFile = vi.fn();
    const { conn } = setup(<ChangedFiles requestId="mr_1" byHand={[{ path: 'src/queue.ts', by: [{ displayName: 'Amy' }] }]} onOpenFile={onOpenFile} />);
    expect(screen.getByText('Loading the diff…')).toBeTruthy();
    await act(async () => {
      conn.respond('worktree.merge.diff', DIFF);
    });
    const list = screen.getByRole('list', { name: 'Changed files' });
    expect(within(list).getAllByRole('button', { expanded: false })).toHaveLength(4);
    expect(within(list).getByText('edited by hand: Amy')).toBeTruthy();
    expect(within(list).getByText('Host only')).toBeTruthy();
    expect(within(list).getByText('The whole diff is larger than 1 MiB: the remaining files load when you open them.')).toBeTruthy();

    // The cut diff's last section is never trusted (diff-model.ts fails closed): opening the file fetches it.
    fireEvent.click(within(list).getByRole('button', { name: /src\/queue\.ts/ }));
    expect(conn.lastRequest('worktree.merge.fileDiff')?.payload).toEqual({ requestId: 'mr_1', path: 'src/queue.ts' });
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'src/queue.ts', diff: section('src/queue.ts'), truncated: false, binary: false });
    });
    expect(within(list).getByRole('region', { name: 'Diff of src/queue.ts' })).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Open in editor' }));
    expect(onOpenFile).toHaveBeenCalledWith('src/queue.ts');
  });

  it('a deleted file has no "Open in editor"; a host-only file shows why its diff is withheld and asks for nothing', async () => {
    const { conn } = setup(<ChangedFiles requestId="mr_1" onOpenFile={() => {}} />);
    await act(async () => {
      conn.respond('worktree.merge.diff', DIFF);
    });
    fireEvent.click(screen.getByRole('button', { name: /old\.ts/ }));
    await act(async () => {
      conn.respond('worktree.merge.fileDiff', { path: 'old.ts', diff: section('old.ts'), truncated: false, binary: false });
    });
    expect(screen.queryByRole('button', { name: 'Open in editor' })).toBeNull();
    const before = conn.requestsOf('worktree.merge.fileDiff').length;
    fireEvent.click(screen.getByRole('button', { name: /CLAUDE\.md/ }));
    expect(screen.getByText('This file is on a path only the host may read. Its changes are not shown to you.')).toBeTruthy();
    expect(conn.requestsOf('worktree.merge.fileDiff')).toHaveLength(before);
  });

  it('says when the diff cannot be loaded and loads it again on request', async () => {
    const { conn } = setup(<ChangedFiles requestId="mr_gone" />);
    await act(async () => {
      conn.fail('worktree.merge.diff', new Error('gone'));
    });
    expect(screen.getByText(/^Could not load the diff/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(conn.requestsOf('worktree.merge.diff')).toHaveLength(2);
  });
});

describe('MergeReviewPanel: the review inside a Changes column', () => {
  const frame = ({ body, footer }: { body: React.ReactNode; footer: React.ReactNode | null }) => (
    <div>
      <div data-testid="body">{body}</div>
      <div data-testid="foot">{footer}</div>
    </div>
  );

  it('the host decides from the column: no dialog, no Close button', async () => {
    const { conn } = setup(<MergeReviewPanel requestId="mr_1" frame={frame} />, 'host');
    await act(async () => {
      conn.respond('worktree.merge.diff', { ...DIFF, truncated: false, files: DIFF.files.slice(0, 1) });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const foot = screen.getByTestId('foot');
    expect(within(foot).queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.click(within(foot).getByRole('button', { name: 'Reject' }));
    fireEvent.change(within(foot).getByLabelText(/Reason for rejecting/), { target: { value: 'not now' } });
    fireEvent.click(within(foot).getByRole('button', { name: 'Confirm rejection' }));
    expect(conn.lastRequest('worktree.merge.reject')?.payload).toEqual({ requestId: 'mr_1', reason: 'not now' });
  });

  it('a member who cannot decide reads the diff and gets no decision bar', async () => {
    const { conn } = setup(<MergeReviewPanel requestId="mr_1" frame={frame} />, 'editor');
    await act(async () => {
      conn.respond('worktree.merge.diff', { ...DIFF, truncated: false, files: DIFF.files.slice(0, 1) });
    });
    expect(within(screen.getByTestId('body')).getByRole('region', { name: 'Diff of src/pay.ts' })).toBeTruthy();
    expect(screen.getByTestId('foot').textContent).toBe('');
  });
});
