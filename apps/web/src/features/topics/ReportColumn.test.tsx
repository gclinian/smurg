// The result report column (DESIGN §5.4, §5.12 item 22): the sections under the catalogue's headings, the changes,
// the follow-up box, "I've reviewed this" by role, and what happens to the change afterwards.
import { SmurgError, type MergeRequest, type PlanInfo, type ReportInfo, type Role, type Topic, type WorktreeInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildMergeRequest, buildPlan, buildReport, buildReportSummary, buildSuggestion, buildTopic, buildWorkItem, buildWorktree } from '@smurg/protocol/testing';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInColumn } from '../../testing/columns.tsx';
import { clearAskDrafts } from './AskBox.tsx';
import { topicDialogs } from './dialogs.ts';
import ReportColumn from './ReportColumn.tsx';
import { AMY, IAN, MEI, admitAs, settle, topicConnection } from './testing/support.tsx';

const TOPIC: Topic = buildTopic({ phase: 'executing', discussionSessionId: 'sess_d', spec: { exists: true }, plan: { ...buildTopic().plan, exists: true, valid: true, items: 1, started: 1 } });
const WORKTREE: WorktreeInfo = buildWorktree({ id: 'wt_1', branch: 'smurg/checkout/cart-api', topicId: 'tp_1', itemId: 'cart-api' });
const draft = (overrides: Partial<MergeRequest> = {}): MergeRequest => {
  const { requestedBy: _none, ...rest } = buildMergeRequest({ id: 'mr_1', status: 'draft', topicId: 'tp_1', itemId: 'cart-api', ...overrides });
  return overrides.requestedBy === undefined ? rest : { ...rest, requestedBy: overrides.requestedBy };
};
const REPORT: ReportInfo = buildReport({
  reviewers: [IAN],
  checks: { passed: 1, notVerified: 1 },
  sections: {
    done: '- Added the cart endpoints.',
    why: 'One place computes the total.',
    verified: [
      { text: '`pnpm test cart`: 14 tests passed', passed: true },
      { text: 'Real delivery', passed: false, note: 'No mail server here.' },
    ],
    watchOut: 'Refunds do not send an email yet.',
    followUps: '- Add refunds.',
  },
  changes: { requestId: 'mr_1', files: 2, additions: 30, deletions: 4, byHand: [{ path: 'src/cart.ts', by: [AMY] }] },
});
const planWith = (overrides: Parameters<typeof buildWorkItem>[0] = {}): PlanInfo =>
  buildPlan({ items: [buildWorkItem({ state: 'done', sessionId: 'sess_i', worktreeId: 'wt_1', attempt: 1, responsible: { ...IAN, source: 'chosen' }, report: buildReportSummary({ reviewers: [IAN] }), merge: { requestId: 'mr_1', status: 'draft', ready: false }, ...overrides })] });

afterEach(() => clearAskDrafts());

async function setup(options: { role?: Role; report?: ReportInfo; plan?: PlanInfo; requests?: MergeRequest[]; topic?: Topic } = {}) {
  const topic = options.topic ?? TOPIC;
  const world = { role: options.role ?? ('host' as Role), topics: [topic], plans: { tp_1: options.plan ?? planWith() }, worktrees: [WORKTREE], requests: options.requests ?? [draft()] };
  const conn = topicConnection(world);
  conn.handle('report.get', () => ({ report: options.report ?? REPORT }));
  conn.handle('worktree.merge.diff', () => ({ diff: '', truncated: false, files: [{ path: 'src/cart.ts', status: 'modified', additions: 30, deletions: 4 }] }));
  const view = renderInColumn(<ReportColumn topicId="tp_1" itemId="cart-api" />, { target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, conn, admit: false });
  const openColumn = vi.fn();
  const openInCodeMode = vi.fn();
  view.session.commands.handle('openColumn', openColumn);
  view.session.commands.handle('openInCodeMode', openInCodeMode);
  admitAs(conn, world);
  await settle(4);
  return { ...view, conn, openColumn, openInCodeMode, dialog: () => topicDialogs(view.stores).getState() };
}

describe('the report column: what the agent wrote', () => {
  it('asks for the report once the lists are there and shows it under the catalogue’s headings', async () => {
    const { conn, column, openColumn } = await setup();
    expect(conn.lastRequest('report.get')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    // The outcome stands beside the title, in the column's header.
    expect(within(column.header).getByText('Complete')).toBeTruthy();
    for (const heading of ['What was done', 'Why it was done this way', 'How it was verified', 'What to watch out for', 'Changes', 'Follow-ups the agent suggests']) {
      expect(screen.getByRole('heading', { level: 3, name: new RegExp(`^${heading}`) })).toBeTruthy();
    }
    expect(screen.getByText('Added the cart endpoints.')).toBeTruthy();
    expect(screen.getByText('1 passed · 1 not verified')).toBeTruthy();
    expect(screen.getByText('smurg/checkout/cart-api')).toBeTruthy();
    const checks = screen.getByText('Real delivery').closest('li') as HTMLElement;
    expect(checks.getAttribute('data-passed')).toBe('false');
    expect(within(checks).getByText('Not verified:')).toBeTruthy();
    expect(within(checks).getByText('No mail server here.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Changes/ }).textContent).toContain('2 files · +30 −4');
    fireEvent.click(screen.getByRole('button', { name: 'Open the session' }));
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 'sess_i' }, side: true });
  });

  it('the changes come from the report’s merge request, say who edited by hand, and open in code mode on the worktree', async () => {
    const { conn, openInCodeMode } = await setup();
    expect(conn.lastRequest('worktree.merge.diff')?.payload).toEqual({ requestId: 'mr_1' });
    const files = screen.getByRole('list', { name: 'Changed files' });
    expect(within(files).getByText('edited by hand: Amy')).toBeTruthy();
    conn.handle('worktree.merge.fileDiff', () => ({ path: 'src/cart.ts', diff: 'diff --git a/src/cart.ts b/src/cart.ts\n@@ -1 +1 @@\n-a\n+b\n', truncated: false, binary: false }));
    fireEvent.click(within(files).getByRole('button', { name: /src\/cart\.ts/ }));
    await settle();
    fireEvent.click(within(files).getByRole('button', { name: 'Open in editor' }));
    expect(openInCodeMode).toHaveBeenCalledWith({ root: { kind: 'worktree', worktreeId: 'wt_1' }, file: 'src/cart.ts', sessionId: 'sess_i' });
  });

  it('a newer version arrives by itself: the report on screen is the newest', async () => {
    const { conn } = await setup();
    const next: ReportInfo = { ...REPORT, version: 2, outcome: 'partial', sections: { ...REPORT.sections, done: 'Half of it.' } };
    conn.handle('report.get', () => ({ report: next }));
    act(() => conn.emit('report.updated', { topicId: 'tp_1', itemId: 'cart-api', report: buildReportSummary({ version: 2, outcome: 'partial', reviewers: [IAN] }) }));
    await settle();
    expect(screen.getByText('Half of it.')).toBeTruthy();
    expect(screen.getByText(/Written by Claude, .* \(version 2\)/)).toBeTruthy();
  });

  it('a report without changes says why; an unreadable one says where', async () => {
    const { changes: _changes, ...bare } = REPORT;
    const none = await setup({ report: { ...bare, noChanges: 'host-only-paths' } });
    expect(screen.getByText('The changes are not shown: they touch files only the host may change. The host looks at the worktree directly.')).toBeTruthy();
    none.unmount();
    await setup({ report: { ...REPORT, state: 'invalid', error: { line: 7, text: msg('plan.error.noBlock'), fallback: 'x' } } });
    expect(screen.getByText('smurg cannot read this report (line 7).')).toBeTruthy();
    expect(screen.getByText('This report cannot be reviewed until the agent fixes it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've reviewed this" })).toBeNull();
  });

  it('shows what was asked from here with the agent’s answers', async () => {
    const at = new Date().setHours(14, 10, 0, 0);
    await setup({ report: { ...REPORT, questions: [{ id: 'f_1', from: IAN, text: 'What about out-of-stock books?', at, answer: { text: 'They are listed as "ships later".', at: at + 60_000 } }, { id: 'f_2', from: AMY, text: 'And refunds?', at: at + 120_000 }] } });
    const thread = screen.getByRole('heading', { name: 'Asked about this result' }).closest('section') as HTMLElement;
    expect(within(thread).getByText('What about out-of-stock books?')).toBeTruthy();
    expect(within(thread).getByText('They are listed as "ships later".')).toBeTruthy();
    expect(within(thread).getByText('Claude has not answered yet.')).toBeTruthy();
  });
});

describe('the report column: asking and telling', () => {
  it('a member with agent access sends a message to the item’s session', async () => {
    const { conn } = await setup({ role: 'agent' });
    const box = screen.getByRole('textbox', { name: 'Ask about this result, or tell Claude what to change' });
    fireEvent.change(box, { target: { value: 'Please also cover refunds.' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(conn.lastRequest('report.followUp')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', text: 'Please also cover refunds.' });
    await act(async () => {
      conn.respond('report.followUp', { messageId: 'm_9' });
    });
    expect(await screen.findByText("Sent to this item's session.")).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('an editor’s text is a suggestion; a viewer has no box', async () => {
    const editor = await setup({ role: 'editor' });
    const box = screen.getByRole('textbox', { name: 'Suggest a question or a change' });
    fireEvent.change(box, { target: { value: 'Mention the queue.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    await act(async () => {
      editor.conn.respond('report.followUp', { suggestion: buildSuggestion({ origin: 'follow-up' }) });
    });
    expect(await screen.findByText('Sent as a suggestion to Ian and Mei.')).toBeTruthy();
    editor.unmount();
    await setup({ role: 'viewer' });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says that changes were asked until the next version', async () => {
    await setup({ plan: planWith({ changesAsked: { by: MEI, at: new Date().setHours(14, 20, 0, 0) } }) });
    expect(screen.getByText('Mei asked for changes at 14:20. Claude writes a new version of this report when it is done.')).toBeTruthy();
  });

  it('does not say so any more once the report was reviewed after that follow-up', async () => {
    const asked = new Date().setHours(14, 20, 0, 0);
    await setup({ plan: planWith({ changesAsked: { by: MEI, at: asked } }), report: { ...REPORT, state: 'reviewed', review: { by: MEI, at: asked + 60_000, version: 1 } } });
    expect(screen.queryByText(/asked for changes/)).toBeNull();
  });
});

describe('the report column: "I\'ve reviewed this"', () => {
  it('the responsible person confirms the version on screen', async () => {
    const { conn } = await setup({ role: 'host' });
    expect(screen.getByText('Waiting for your review')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "I've reviewed this" }));
    expect(conn.lastRequest('report.review')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', version: 1 });
    await act(async () => {
      conn.respond('report.review', { report: buildReportSummary({ state: 'reviewed', reviewers: [IAN], review: { by: IAN, at: new Date().setHours(14, 31, 0, 0), version: 1 } }) });
    });
    expect(await screen.findByText('Marked as reviewed.')).toBeTruthy();
    expect(screen.getByText('Reviewed by Ian, 14:31')).toBeTruthy();
    expect(screen.getByText('Reviewed by Ian at 14:31. The change is ready for you to merge.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've reviewed this" })).toBeNull();
  });

  it('others read who reviews; a member with agent access may request the merge while nobody reviewed', async () => {
    const { conn } = await setup({ role: 'agent' });
    expect(screen.getByText('Waiting for Ian')).toBeTruthy();
    expect(screen.getByText('Ian is responsible for this item and reviews this report. Everyone can read it and ask follow-ups.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've reviewed this" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request merge' }));
    expect(conn.lastRequest('worktree.merge.request')?.payload).toEqual({ worktreeId: 'wt_1' });
    await act(async () => {
      conn.respond('worktree.merge.request', { request: draft({ status: 'pending', requestedBy: MEI }) });
    });
    expect(await screen.findByText('Merge requested. It waits for the host.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request merge' })).toBeNull();
  });

  it('with nobody assigned anyone but a viewer may review', async () => {
    const everyone = { reviewers: [IAN, MEI, AMY] };
    const editor = await setup({ role: 'editor', report: { ...REPORT, ...everyone }, plan: planWith({ responsible: null, report: buildReportSummary(everyone) }) });
    expect(screen.getByRole('button', { name: "I've reviewed this" })).toBeTruthy();
    editor.unmount();
    await setup({ role: 'viewer', report: { ...REPORT, ...everyone }, plan: planWith({ responsible: null, report: buildReportSummary(everyone) }) });
    expect(screen.getByText('Nobody is assigned to this item: anyone but a viewer can review it. Everyone can read it and ask follow-ups.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've reviewed this" })).toBeNull();
  });

  it('once escalated a member with agent access reviews instead of the responsible person', async () => {
    const { conn } = await setup({ role: 'agent', report: { ...REPORT, escalatedAt: 5 } });
    fireEvent.click(screen.getByRole('button', { name: 'Review instead of Ian' }));
    expect(conn.lastRequest('report.review')?.payload).toMatchObject({ version: 1 });
  });

  it('unfinished work asks once before it is marked', async () => {
    const { conn } = await setup({ report: { ...REPORT, outcome: 'partial' } });
    fireEvent.click(screen.getByRole('button', { name: "I've reviewed this" }));
    expect(conn.requestsOf('report.review')).toHaveLength(0);
    expect(screen.getByText('This report says the work is partial. Mark unfinished work as reviewed?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: "I've reviewed this" }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as reviewed' }));
    expect(conn.lastRequest('report.review')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', version: 1, acknowledgeUnfinished: true });
  });

  it('a version the agent replaced meanwhile is not marked: the new one is fetched and the person told', async () => {
    const { conn } = await setup();
    const before = conn.requestsOf('report.get').length;
    fireEvent.click(screen.getByRole('button', { name: "I've reviewed this" }));
    await act(async () => {
      conn.fail('report.review', new SmurgError('conflict', msg('topic.archived'), { reason: 'report-changed' }));
    });
    expect(screen.getByText('Claude wrote a newer version of this report. Read it, then confirm again.')).toBeTruthy();
    expect(conn.requestsOf('report.get')).toHaveLength(before + 1);
  });

  it('a report changed after its review asks for the review again', async () => {
    await setup({ report: { ...REPORT, state: 'changed-after-review', version: 2, review: { by: IAN, at: 5, version: 1 } } });
    expect(screen.getByText('Changed after the review · Waiting for your review')).toBeTruthy();
    expect(screen.getByText('Claude changed this report after it was reviewed. Read it again, then confirm.')).toBeTruthy();
  });
});

describe('the report column: after the review', () => {
  const reviewed: ReportInfo = { ...REPORT, state: 'reviewed', review: { by: IAN, at: new Date().setHours(14, 31, 0, 0), version: 1 } };

  it('the host gets "Merge…": the complete diff review of that request', async () => {
    const { dialog } = await setup({ report: reviewed, plan: planWith({ state: 'reviewed', merge: { requestId: 'mr_1', status: 'draft', ready: true } }), requests: [draft({ reviewed: true })] });
    fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
    expect(dialog()).toEqual({ kind: 'merge', requestId: 'mr_1' });
  });

  it('everyone else reads that the change is in the host’s inbox', async () => {
    await setup({ role: 'agent', report: reviewed, plan: planWith({ state: 'reviewed', merge: { requestId: 'mr_1', status: 'draft', ready: true } }), requests: [draft({ reviewed: true })] });
    expect(screen.getByText("Reviewed by Ian at 14:31. The change is in the host's inbox, ready to merge.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Merge…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request merge' })).toBeNull();
  });

  it('a merge conflict offers "Ask the agent to resolve"', async () => {
    const { conn } = await setup({ role: 'agent', report: reviewed, plan: planWith({ state: 'reviewed', merge: { requestId: 'mr_1', status: 'conflict', ready: true } }), requests: [draft({ status: 'conflict', reviewed: true, conflictFiles: ['src/cart.ts'] })] });
    expect(screen.getByText('Reviewed by Ian at 14:31. The merge stopped on a conflict.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to resolve' }));
    expect(conn.lastRequest('plan.item.resolve')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
  });

  it('merged and reviewed: the item is finished, and the box points to the discussion', async () => {
    const { openColumn } = await setup({
      role: 'agent',
      report: reviewed,
      plan: planWith({ state: 'reviewed', merge: { requestId: 'mr_1', status: 'merged', ready: false } }),
      requests: [draft({ status: 'merged', reviewed: true, requestedBy: IAN, decidedAt: new Date().setHours(14, 40, 0, 0) })],
    });
    expect(screen.getByText('Reviewed by Ian at 14:31. Merged into the main workspace at 14:40.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('This item is merged and its session has ended. Ask in the discussion.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open the discussion' }));
    expect(openColumn).toHaveBeenCalledWith({ target: { kind: 'session', sessionId: 'sess_d' }, side: true });
  });

  it('an archived topic is read-only', async () => {
    await setup({ topic: { ...TOPIC, archived: true } });
    expect(screen.getByText('This topic is archived. Restore it to continue.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: "I've reviewed this" })).toBeNull();
  });
});

describe('the report column: loading', () => {
  it('says when the report cannot be loaded and tries again on request', async () => {
    const world = { role: 'host' as Role, topics: [TOPIC] };
    const conn = topicConnection(world);
    renderInColumn(<ReportColumn topicId="tp_1" itemId="cart-api" />, { target: { kind: 'report', topicId: 'tp_1', itemId: 'cart-api' }, conn, admit: false });
    expect(conn.requestsOf('report.get')).toHaveLength(0);
    admitAs(conn, world);
    await settle();
    await act(async () => {
      for (const request of conn.pendingOf('report.get')) request.reject(new SmurgError('not_found', msg('topic.notFound')));
    });
    expect(screen.getByText('The report could not be loaded: That topic was not found.')).toBeTruthy();
    const before = conn.requestsOf('report.get').length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(conn.requestsOf('report.get')).toHaveLength(before + 1);
  });
});
