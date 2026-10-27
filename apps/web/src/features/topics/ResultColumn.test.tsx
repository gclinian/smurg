// A topic's Result (DESIGN 0.7.0 D13, D19): the summary, the checks (what failed and was not verified first), what the
// items changed, what to watch out for, the work items with the host's "Undo…", what was left out, and the end: "I've
// checked the result" for anyone who may discuss.
import type { PlanInfo, ReportInfo, Role, Topic } from '@smurg/protocol';
import { buildMergeRequest, buildPlan, buildReport, buildReportSummary, buildTopic, buildWorkItem } from '@smurg/protocol/testing';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderInColumn } from '../../testing/columns.tsx';
import { T0, makeHostState } from '../../testing/fixtures.ts';
import { topicDialogs } from './dialogs.ts';
import ResultColumn from './ResultColumn.tsx';
import { AMY, IAN, MEI, admitAs, settle, topicConnection } from './testing/support.tsx';

const READY: Topic = buildTopic({ name: 'Checkout redesign', phase: 'ready', spec: { exists: true }, plan: { ...buildTopic().plan, exists: true, valid: true, items: 3, started: 3, merged: 2, leftOut: 1 } });
const PLAN: PlanInfo = buildPlan({
  items: [
    buildWorkItem({
      id: 'cart-api',
      number: 1,
      title: 'Cart API',
      state: 'reviewed',
      attempt: 1,
      merging: 'auto',
      merged: { at: T0, by: 'smurg' },
      merge: { requestId: 'mr_1', status: 'merged', ready: false },
      report: buildReportSummary({ state: 'reviewed', review: { by: MEI, at: T0, version: 1 }, checks: { passed: 1, notVerified: 1 } }),
    }),
    buildWorkItem({
      id: 'receipt-email',
      number: 2,
      title: 'Receipt email',
      state: 'done',
      attempt: 1,
      merging: 'host',
      merged: { at: T0, by: IAN },
      merge: { requestId: 'mr_2', status: 'merged', ready: false },
      report: buildReportSummary({ checks: { passed: 1, notVerified: 0, failed: 1 } }),
    }),
    buildWorkItem({ id: 'checkout-page', number: 3, title: 'Checkout page', state: 'stopped', attempt: 1, merging: 'auto', leftOut: { by: MEI, at: T0 } }),
  ],
});
const REPORTS: Record<string, ReportInfo> = {
  'cart-api': buildReport({
    itemId: 'cart-api',
    checks: { passed: 1, notVerified: 1 },
    sections: { done: 'The cart endpoints.', why: 'As decided.', verified: [{ text: 'pnpm test cart', passed: true }, { text: 'Manual check', passed: false, note: 'No browser here.' }], watchOut: 'Stock is not checked yet.' },
    changes: { requestId: 'mr_1', files: 1, additions: 3, deletions: 0, byHand: [] },
  }),
  'receipt-email': buildReport({
    itemId: 'receipt-email',
    checks: { passed: 1, notVerified: 0, failed: 1 },
    sections: { done: 'The email.', why: 'As decided.', verified: [{ text: 'pnpm test mail', passed: true }, { text: 'Delivery', passed: false, failed: true, note: 'The SMTP mock timed out.' }], watchOut: '' },
    changes: { requestId: 'mr_2', files: 1, additions: 5, deletions: 1, byHand: [] },
  }),
};

async function setup(options: { role?: Role; topic?: Topic; plan?: PlanInfo; direct?: boolean } = {}) {
  const topic = options.topic ?? READY;
  const world = {
    role: options.role ?? ('agent' as Role),
    topics: [topic],
    plans: { [topic.id]: options.plan ?? PLAN },
    requests: [buildMergeRequest({ id: 'mr_1', status: 'merged', topicId: topic.id, itemId: 'cart-api' }), buildMergeRequest({ id: 'mr_2', status: 'merged', topicId: topic.id, itemId: 'receipt-email' })],
    ...(options.direct === true ? { host: makeHostState({ work: { history: 'direct', reason: { text: { id: 'worktree.unavailable.gitNotFound', params: { minVersion: '2.42.0' } }, fallback: 'no git' } } }) } : {}),
  };
  const conn = topicConnection(world);
  conn.handle('report.get', (payload) => ({ report: REPORTS[payload.itemId] as ReportInfo }));
  conn.handle('worktree.merge.diff', () => ({ diff: '', truncated: false, files: [{ path: 'src/cart.ts', status: 'modified', additions: 3, deletions: 0 }] }));
  const view = renderInColumn(<ResultColumn topicId={topic.id} />, { target: { kind: 'result', topicId: topic.id }, conn, admit: false });
  admitAs(conn, world);
  await settle(5);
  return { ...view, conn, dialog: () => topicDialogs(view.stores).getState() };
}

const headings = (): string[] => screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');

describe('the Result column', () => {
  it('the parts in order: the summary, what failed, what was not verified, what passed, the changes, what to watch out for, the items, what was left out', async () => {
    const { conn } = await setup();
    expect(conn.requestsOf('report.get').map((request) => request.payload.itemId).sort()).toEqual(['cart-api', 'receipt-email']);
    expect(screen.getByText('2 of 3 merged · 2 passed · 1 failed · 1 not verified · 1 left out')).toBeTruthy();
    expect(headings()).toEqual(['Failed', 'Not verified', 'Passed', 'What the items changed', 'What to watch out for', 'Work items', 'Left out and undone']);
    const failed = screen.getByRole('region', { name: 'Failed' });
    expect(within(failed).getByText('2 · Receipt email')).toBeTruthy();
    expect(within(failed).getByText('The SMTP mock timed out.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Not verified' })).getByText('Manual check')).toBeTruthy();
    expect(screen.getByText("Each item's change against the main workspace it was merged into. A line an item replaced shows as removed, also when a person had written it.")).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'What to watch out for' })).getByText('Stock is not checked yet.')).toBeTruthy();
    const items = screen.getByRole('region', { name: 'Work items' });
    expect(within(items).getByText('Merged · reviewed')).toBeTruthy();
    expect(within(items).getByText(/^Reviewed by Mei, /)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Left out and undone' })).getByText('Left out')).toBeTruthy();
    // A member: the check, no undo of their own (the host's).
    expect(within(items).getByText('Only the host can undo a merge: ask the host.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo…' })).toBeNull();
    expect(screen.getByText(/^Press it when you have looked at the result\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "I've checked the result" }));
    expect(conn.lastRequest('topic.check')?.payload).toEqual({ topicId: 'tp_1' });
  });

  it('the host undoes an item or the whole topic', async () => {
    const { dialog } = await setup({ role: 'host' });
    const row = document.querySelector('.result-item[data-item="cart-api"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Undo…' }));
    expect(dialog()).toEqual({ kind: 'undo', topicId: 'tp_1', itemIds: ['cart-api'] });
    fireEvent.click(screen.getByRole('button', { name: 'Undo the whole topic…' }));
    expect(dialog()).toEqual({ kind: 'undo', topicId: 'tp_1', itemIds: null });
  });

  it('a Viewer reads it all and has no "I\'ve checked the result"; once checked, the foot says who checked it', async () => {
    await setup({ role: 'viewer' });
    expect(screen.getByRole('region', { name: 'Work items' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've checked the result" })).toBeNull();
    const checked = await setup({ topic: { ...READY, phase: 'complete', checked: { by: AMY, at: T0 } } });
    expect(within(checked.container).getByText(/^Checked by Amy at .+\. To change something, ask in the discussion/)).toBeTruthy();
    expect(within(checked.container).queryByRole('button', { name: "I've checked the result" })).toBeNull();
  });

  it('items that ran directly in the shared folder: their changes cannot be shown', async () => {
    await setup({ direct: true });
    expect(screen.getByText('These items ran directly in the shared folder: smurg keeps no history of them and cannot show or undo their changes. Their reports say what they changed.')).toBeTruthy();
  });
});
