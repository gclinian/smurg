// The result report column (DESIGN §5.4, §5.12 item 22): the sections under the catalogue's headings, the changes,
// the follow-up box, "I've reviewed this" by role, and what happens to the change afterwards.
import { SmurgError, type MergeRequest, type PlanInfo, type ReportInfo, type Role, type SessionInfo, type Topic, type WorktreeInfo } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { buildAgentSession, buildMergeRequest, buildPlan, buildReport, buildReportSummary, buildSuggestion, buildTopic, buildWorkItem, buildWorktree } from '@smurg/protocol/testing';
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

async function setup(options: { role?: Role; report?: ReportInfo; plan?: PlanInfo; requests?: MergeRequest[]; topic?: Topic; sessions?: SessionInfo[] } = {}) {
  const topic = options.topic ?? TOPIC;
  const world = { role: options.role ?? ('host' as Role), topics: [topic], plans: { tp_1: options.plan ?? planWith() }, worktrees: [WORKTREE], requests: options.requests ?? [draft()], sessions: options.sessions ?? [] };
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

  it('0.7.0 D5: a check that failed says "Failed" before its text and what happened, and the counts name it', async () => {
    const failed: ReportInfo = {
      ...REPORT,
      outcome: 'partial',
      checks: { passed: 1, notVerified: 1, failed: 1 },
      sections: { ...REPORT.sections, verified: [...REPORT.sections.verified, { text: '`pnpm lint`', passed: false, failed: true, note: '2 errors in src/cart.ts' }] },
    };
    await setup({ report: failed });
    expect(screen.getByText('1 passed · 1 failed · 1 not verified')).toBeTruthy();
    const row = screen.getByText('pnpm lint').closest('li') as HTMLElement;
    expect(row.getAttribute('data-passed')).toBe('false');
    expect(row.getAttribute('data-failed')).toBe('true');
    expect(within(row).getByText('Failed')).toBeTruthy();
    expect(within(row).queryByText('Not verified:')).toBeNull();
    expect(within(row).getByText('2 errors in src/cart.ts')).toBeTruthy();
    // The check that was not verified is still that, not a failure.
    const notVerified = screen.getByText('Real delivery').closest('li') as HTMLElement;
    expect(notVerified.getAttribute('data-failed')).toBeNull();
    expect(within(notVerified).getByText('Not verified:')).toBeTruthy();
    // A report without a failed check keeps 0.6.0's line (no "0 failed").
    expect(screen.queryByText('1 passed · 1 not verified')).toBeNull();
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
    // An item that ran directly in the shared folder (no git program, DESIGN 0.6.0 D15).
    const direct = await setup({ report: { ...bare, noChanges: 'no-history' } });
    expect(screen.getByText('Without git, smurg keeps no history: this item changed the shared folder directly, and there is no diff to show. Its conversation and the activity feed show what its agent did.')).toBeTruthy();
    direct.unmount();
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
    expect(screen.getByText('Nobody is assigned to this item: anyone but a viewer can review it. Everyone can read it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've reviewed this" })).toBeNull();
  });

  it('a viewer\'s foot does not promise follow-ups: there is no box to ask in', async () => {
    await setup({ role: 'viewer' });
    expect(screen.getByText('Ian is responsible for this item and reviews this report. Everyone can read it.')).toBeTruthy();
    expect(screen.queryByText(/ask follow-ups/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
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

  it('a merge that stopped on a conflict BEFORE anyone reviewed the report says so and offers "Ask the agent to resolve" (review R6-01)', async () => {
    const conflict = { plan: planWith({ merge: { requestId: 'mr_1', status: 'conflict', ready: false } }), requests: [draft({ status: 'conflict', conflictFiles: ['src/cart.ts'] })] };
    // The reviewer, with agent access: the review, the conflict and the way through the agent in one foot.
    const mei = await setup({ role: 'agent', report: { ...REPORT, reviewers: [MEI] }, ...conflict });
    expect(document.querySelector('.col-foot__text')?.textContent).toBe('The merge stopped on a conflict. Press it when you have read the report and understand the change. It leaves your inbox, and the plan counts the item as reviewed.');
    expect(screen.getByRole('button', { name: "I've reviewed this" })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask the agent to resolve' }));
    expect(mei.conn.lastRequest('plan.item.resolve')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    mei.unmount();
    // The host, who is not the reviewer here: who reviews, the conflict, the agent's way and the dialog of the request.
    const host = await setup({ role: 'host', report: { ...REPORT, reviewers: [MEI] }, ...conflict });
    expect(document.querySelector('.col-foot__text')?.textContent).toMatch(/^The merge stopped on a conflict\. /);
    expect(screen.getByRole('button', { name: 'Ask the agent to resolve' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
    expect(host.dialog()).toEqual({ kind: 'merge', requestId: 'mr_1' });
    host.unmount();
    // A viewer reads it and has no button.
    await setup({ role: 'viewer', report: { ...REPORT, reviewers: [MEI] }, ...conflict });
    expect(document.querySelector('.col-foot__text')?.textContent).toMatch(/^The merge stopped on a conflict\. /);
    expect(screen.queryByRole('button', { name: 'Ask the agent to resolve' })).toBeNull();
  });

  it('a report that became invalid after its review still gives the host the request that waits in the inbox', async () => {
    const invalid: ReportInfo = { ...reviewed, state: 'invalid', error: { line: 7, text: msg('plan.error.noBlock'), fallback: 'x' } };
    const { dialog, unmount } = await setup({ report: invalid, plan: planWith({ state: 'reviewed', merge: { requestId: 'mr_1', status: 'draft', ready: true } }), requests: [draft({ reviewed: true })] });
    expect(document.querySelector('.col-foot__text')?.textContent).toBe('This report cannot be reviewed until the agent fixes it.');
    fireEvent.click(screen.getByRole('button', { name: 'Merge…' }));
    expect(dialog()).toEqual({ kind: 'merge', requestId: 'mr_1' });
    unmount();
    // Nobody else gets a button, and a merged change needs none.
    await setup({ role: 'agent', report: invalid, plan: planWith({ state: 'reviewed', merge: { requestId: 'mr_1', status: 'draft', ready: true } }), requests: [draft({ reviewed: true })] });
    expect(screen.queryByRole('button', { name: 'Merge…' })).toBeNull();
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

  it('merged and reviewed while its session is still there: the report does not say that the session has ended, and it can be asked', async () => {
    // The item's worktree holds changes no merge carried (a newer draft, a follow-up's work): smurg keeps the item's
    // session and worktree, and answers a follow-up (the daemon's rule of review R2-04).
    const session = buildAgentSession({ id: 'sess_i', purpose: 'item', topicId: 'tp_1', topicName: 'Checkout', itemId: 'cart-api', item: { number: 1, title: 'Cart API' }, status: 'idle' });
    const { conn } = await setup({
      role: 'agent',
      report: reviewed,
      plan: planWith({ state: 'reviewed', merge: { requestId: 'mr_1', status: 'merged', ready: false } }),
      requests: [draft({ status: 'merged', reviewed: true, requestedBy: IAN, decidedAt: new Date().setHours(14, 40, 0, 0) })],
      sessions: [session],
    });
    expect(screen.getByText('Reviewed by Ian at 14:31. Merged into the main workspace at 14:40.')).toBeTruthy();
    expect(screen.queryByText('This item is merged and its session has ended. Ask in the discussion.')).toBeNull();
    const box = screen.getByRole('textbox', { name: 'Ask about this result, or tell Claude what to change' });
    fireEvent.change(box, { target: { value: 'Does the newer draft keep the rounding?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(conn.lastRequest('report.followUp')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', text: 'Does the newer draft keep the rounding?' });
    // The rest is merged too: smurg ends the session, and now the report says so.
    act(() => conn.emit('session.state', { session: { ...session, status: 'ended' } }));
    expect(screen.getByText('This item is merged and its session has ended. Ask in the discussion.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
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

describe('the report column: an item smurg merges by itself (protocol 6, DESIGN 0.7.0 D12, D19)', () => {
  const T = 1_780_000_000_000;
  const hold = (reason: string, extra: Record<string, unknown> = {}) =>
    ({
      state: 'held',
      reason,
      since: T,
      tries: 0,
      hostOnly: ['policy', 'local-changes', 'in-the-way', 'staged', 'branch', 'git-busy', 'history-changed', 'merge-failed', 'by-hand', 'undo-interrupted'].includes(reason),
      escalated: false,
      ...extra,
    }) as NonNullable<Parameters<typeof buildWorkItem>[0]>['autoMerge'];
  const autoPlan = (overrides: Parameters<typeof buildWorkItem>[0] = {}): PlanInfo =>
    buildPlan({
      items: [
        buildWorkItem({ state: 'done', sessionId: 'sess_i', worktreeId: 'wt_1', attempt: 1, merging: 'auto', responsible: { ...MEI, source: 'chosen' }, report: buildReportSummary({ reviewers: [MEI] }), merge: { requestId: 'mr_1', status: 'draft', ready: false }, ...overrides }),
        buildWorkItem({ id: 'checkout-page', number: 2, title: 'Checkout page', state: 'waiting', armed: true, dependsOn: ['cart-api'], waitsFor: ['cart-api'] }),
      ],
    });
  const foot = (): HTMLElement => document.querySelector('.report-foot') as HTMLElement;

  // (lead decision 4 of the 0.7.0 verify: the home page's picture shows these words; the foot's second sentence ends
  // with its full stop)
  it('merged by smurg, then reviewed: the state says who reviewed, the foot who reviewed and that smurg merged it before', async () => {
    const reviewed = { ...REPORT, reviewers: [MEI], state: 'reviewed' as const, review: { by: AMY, at: T + 120_000, version: 1 } };
    await setup({ role: 'agent', report: reviewed, plan: autoPlan({ state: 'reviewed', merged: { at: T, by: 'smurg' }, merge: { requestId: 'mr_1', status: 'merged', ready: false }, report: buildReportSummary({ state: 'reviewed', reviewers: [MEI], review: { by: AMY, at: T + 120_000, version: 1 } }) }), requests: [draft({ status: 'merged', auto: true, decidedAt: T })] });
    expect(screen.getByText(/^Reviewed by Amy, .+\d\d:\d\d$/)).toBeTruthy();
    expect(within(foot()).getByText(/^Reviewed by Amy at .*\d\d:\d\d\. Merged by smurg at .*\d\d:\d\d\.$/)).toBeTruthy();
  });

  it('merged by smurg: the state and the lead say so, and "I\'ve reviewed this" is a mark', async () => {
    const { conn } = await setup({ role: 'agent', report: { ...REPORT, reviewers: [MEI] }, plan: autoPlan({ merged: { at: T, by: 'smurg' }, merge: { requestId: 'mr_1', status: 'merged', ready: false } }), requests: [draft({ status: 'merged', auto: true, decidedAt: T })] });
    expect(screen.getByText(/^Merged by smurg at /)).toBeTruthy();
    expect(within(foot()).getByText(/^smurg merged this change into the main workspace at .+: its report says complete, at least one check passed and none failed\. Mark it reviewed when you have read it; that changes nothing in the folder\.$/)).toBeTruthy();
    expect(within(foot()).queryByRole('button', { name: 'Merge…' })).toBeNull();
    fireEvent.click(within(foot()).getByRole('button', { name: "I've reviewed this" }));
    expect(conn.lastRequest('report.review')?.payload).toMatchObject({ topicId: 'tp_1', itemId: 'cart-api', version: 1 });
  });

  it('held for a report that is not complete: why, who decides, what waits; the follow-up, Request merge, Leave it out for agent access', async () => {
    const { dialog } = await setup({ role: 'agent', plan: autoPlan({ autoMerge: hold('partial'), report: buildReportSummary({ outcome: 'partial', reviewers: [MEI] }) }), report: { ...REPORT, outcome: 'partial' } });
    // (0.7.0 review: Mei is the one who decides, and reads it as "You decide", not her own name)
    expect(within(foot()).getByText('Not merged: not complete (partial). You decide. Items 2 wait for it.')).toBeTruthy();
    fireEvent.click(within(foot()).getByRole('button', { name: 'Ask the agent to fix it' }));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    expect(within(foot()).getByRole('button', { name: 'Request merge' })).toBeTruthy();
    expect(within(foot()).queryByRole('button', { name: 'Merge…' })).toBeNull();
    expect(within(foot()).queryByRole('button', { name: 'Merge it as it is' })).toBeNull();
    fireEvent.click(within(foot()).getByRole('button', { name: 'Leave it out…' }));
    expect(dialog()).toEqual({ kind: 'leaveOut', topicId: 'tp_1', itemId: 'cart-api' });
  });

  it('the host gets "Merge…" for a report hold; an editor only reads why and who decides', async () => {
    await setup({ role: 'host', plan: autoPlan({ autoMerge: hold('check-failed') }) });
    expect(within(foot()).getByText('Not merged: a check failed. Mei decides. Items 2 wait for it.')).toBeTruthy();
    expect(within(foot()).getByRole('button', { name: 'Merge…' })).toBeTruthy();
    const editor = await setup({ role: 'editor', plan: autoPlan({ autoMerge: hold('check-failed') }) });
    const editorFoot = editor.container.querySelector('.report-foot') as HTMLElement;
    expect(within(editorFoot).queryByRole('button', { name: 'Leave it out…' })).toBeNull();
    expect(within(editorFoot).queryByRole('button', { name: 'Merge…' })).toBeNull();
  });

  it('a later message or a stopped turn: "Merge it as it is" for the version on screen, and Continue', async () => {
    const { conn } = await setup({ role: 'agent', plan: autoPlan({ autoMerge: hold('stopped') }) });
    expect(within(foot()).getByText('Not merged: its last turn did not finish. You decide. Items 2 wait for it.')).toBeTruthy();
    fireEvent.click(within(foot()).getByRole('button', { name: 'Merge it as it is' }));
    expect(conn.lastRequest('plan.item.release')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', version: 1 });
    fireEvent.click(within(foot()).getByRole('button', { name: 'Continue' }));
    expect(conn.lastRequest('plan.item.continue')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
  });

  it('0.7.0 review: a merged item whose later turn did not finish: Continue, but nothing to merge "as it is" and nothing to leave out', async () => {
    await setup({ role: 'agent', plan: autoPlan({ autoMerge: hold('stopped'), merged: { at: T, by: 'smurg' }, merge: { requestId: 'mr_1', status: 'merged', ready: false } }), requests: [draft({ status: 'merged', auto: true, decidedAt: T })] });
    expect(within(foot()).getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(within(foot()).queryByRole('button', { name: 'Merge it as it is' })).toBeNull();
    expect(within(foot()).queryByRole('button', { name: 'Leave it out…' })).toBeNull();
  });

  it('0.7.0 review: files only the host may merge and no draft (the snapshot was refused): the host can still request the merge', async () => {
    await setup({ role: 'host', plan: autoPlan({ autoMerge: hold('policy', { paths: ['.vscode/settings.json'] }), merge: undefined }), requests: [] });
    expect(within(foot()).getByText(/Files only the host may merge: \.vscode\/settings\.json\.$/)).toBeTruthy();
    expect(within(foot()).getByRole('button', { name: 'Request merge' })).toBeTruthy();
  });

  // 0.7.0 verify (W/verify/ux, run): a merged item held for what its worktree holds said "Not merged"; a new version of
  // an item merged before could not be merged "as it is"; after the host's own "Request merge" the foot never offered the
  // merge (the refused snapshot has no request of its own) and offered the request again.
  it('0.7.0 verify: a merged item whose worktree holds a later change: "Merged; a later change is not merged", Continue, nothing to merge as it is or leave out', async () => {
    const { conn } = await setup({ role: 'agent', plan: autoPlan({ autoMerge: hold('edited'), merged: { at: T, by: 'smurg' }, merge: { requestId: 'mr_1', status: 'merged', ready: false } }), requests: [draft({ status: 'merged', auto: true, decidedAt: T })] });
    expect(within(foot()).getByText('Merged; a later change is not merged: its worktree holds changes that were never merged. You decide.')).toBeTruthy();
    fireEvent.click(within(foot()).getByRole('button', { name: 'Continue' }));
    expect(conn.lastRequest('plan.item.continue')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    expect(within(foot()).queryByRole('button', { name: 'Merge it as it is' })).toBeNull();
    expect(within(foot()).queryByRole('button', { name: 'Leave it out…' })).toBeNull();
  });

  it('0.7.0 verify: a new version of an item merged before, held because its report was not checked again: "Merge it as it is" for it', async () => {
    const { conn } = await setup({ role: 'agent', plan: autoPlan({ autoMerge: hold('stale-report'), merged: { at: T, by: 'smurg' }, merge: { requestId: 'mr_2', status: 'draft', ready: false }, report: buildReportSummary({ version: 2, reviewers: [MEI] }) }), report: { ...REPORT, version: 2, changes: { ...(REPORT.changes as NonNullable<ReportInfo['changes']>), requestId: 'mr_2' } }, requests: [draft({ status: 'merged', auto: true, decidedAt: T }), draft({ id: 'mr_2' })] });
    expect(within(foot()).getByText(/^Merged; a later change is not merged: its report was not checked again after its last change\. You decide\.$/)).toBeTruthy();
    fireEvent.click(within(foot()).getByRole('button', { name: 'Merge it as it is' }));
    expect(conn.lastRequest('plan.item.release')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', version: 2 });
    expect(within(foot()).queryByRole('button', { name: 'Leave it out…' })).toBeNull();
  });

  it('0.7.0 verify: files only the host may merge, after the host\'s own "Request merge": the foot offers that request\'s merge, and no second request', async () => {
    const requested = draft({ id: 'mr_9', status: 'pending', worktreeId: 'wt_1', requestedBy: IAN });
    await setup({ role: 'host', plan: autoPlan({ autoMerge: hold('policy', { paths: ['.vscode/settings.json'] }), merge: undefined }), report: { ...REPORT, changes: undefined, noChanges: 'host-only-paths' }, requests: [requested] });
    expect(within(foot()).getByRole('button', { name: 'Merge…' })).toBeTruthy();
    expect(within(foot()).queryByRole('button', { name: 'Request merge' })).toBeNull();
  });

  it('a conflict with a person\'s change names it; the agent may be asked to resolve', async () => {
    const { conn } = await setup({ role: 'agent', plan: autoPlan({ autoMerge: hold('conflict', { people: [{ path: 'src/cart.ts', by: [AMY], outside: false }, { path: 'README.md', by: [], outside: true }] }) }) });
    expect(within(foot()).getByText(/^Not merged: it conflicts with Amy's change of src\/cart\.ts\. You decide\. Items 2 wait for it\. src\/cart\.ts: the other side is Amy's change\. Whose lines stay is a person's decision\. README\.md: the other side was changed outside smurg\. Whose lines stay is a person's decision\.$/)).toBeTruthy();
    fireEvent.click(within(foot()).getByRole('button', { name: 'Ask the agent to resolve' }));
    expect(conn.lastRequest('plan.item.resolve')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
  });

  it('files only the host may merge: the host asks the agent to take them out; a member is not offered it', async () => {
    const { conn } = await setup({ role: 'host', plan: autoPlan({ autoMerge: hold('policy', { paths: ['.github/workflows/ci.yml'] }) }) });
    // (0.7.0 review: the foot names the files, the report hides its diff; the host's own request passes the policy)
    expect(within(foot()).getByText('Not merged: it changes files only the host may merge. You decide. Items 2 wait for it. Files only the host may merge: .github/workflows/ci.yml.')).toBeTruthy();
    fireEvent.click(within(foot()).getByRole('button', { name: 'Ask the agent to take them out' }));
    expect(conn.lastRequest('plan.item.removePaths')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api' });
    expect(within(foot()).getByRole('button', { name: 'Request merge' })).toBeTruthy();
    const member = await setup({ role: 'agent', plan: autoPlan({ autoMerge: hold('policy', { paths: ['.github/workflows/ci.yml'] }) }) });
    expect(within(member.container.querySelector('.report-foot') as HTMLElement).queryByRole('button', { name: 'Ask the agent to take them out' })).toBeNull();
  });

  it('a hold that ends by itself says what to do in the main workspace, for the host', async () => {
    await setup({ role: 'host', plan: autoPlan({ autoMerge: hold('branch', { branch: { expected: 'main', current: 'experiment' } }) }) });
    expect(within(foot()).getByText(/The main workspace is on experiment\. Switch back to main, where this topic started; smurg merges the item by itself then\.$/)).toBeTruthy();
    expect(within(foot()).queryByRole('button', { name: 'Leave it out…' })).toBeNull();
    expect(within(foot()).queryByRole('button', { name: 'Merge…' })).toBeNull();
  });

  it('an item that ran directly in the folder and is held: the host accepts it as it is', async () => {
    const plan = buildPlan({ items: [buildWorkItem({ state: 'done', sessionId: 'sess_i', attempt: 1, responsible: { ...MEI, source: 'chosen' }, report: buildReportSummary({ outcome: 'blocked', reviewers: [MEI] }), autoMerge: hold('blocked') })] });
    const { conn } = await setup({ role: 'host', plan, requests: [] });
    fireEvent.click(within(foot()).getByRole('button', { name: 'Accept as it is' }));
    expect(conn.lastRequest('plan.item.accept')?.payload).toEqual({ topicId: 'tp_1', itemId: 'cart-api', version: 1 });
    expect(within(foot()).queryByRole('button', { name: 'Merge it as it is' })).toBeNull();
  });

  it('undone: who took it back, and when', async () => {
    await setup({ role: 'host', plan: autoPlan({ state: 'not-started', undone: { by: IAN, at: T } }) });
    expect(screen.getByText(/^Undone by Ian at .+: its change was taken back out of the main workspace\.$/)).toBeTruthy();
  });
});
