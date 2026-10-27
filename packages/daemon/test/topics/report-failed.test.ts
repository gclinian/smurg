// DESIGN 0.7.0 D5 through the topics module: a result report that lists a failed check (`- [!] …: failed: …`) and says
// `complete` is refused by the agent's own check_report and by the end of its turn (`fix-report`, at the outcome
// line); the fixed one (`partial`) is registered with its failed check counted, on the wire as in the store. The REAL
// topics module; agents and worktrees are the fakes the test drives (support.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { reportInfoSchema, topicReportPath } from '@smurg/protocol';
import { checkReport, itemOf, reportText, setupTopics, smurgSent, startPlan, topicWithPlan, waitFor, writeReport, type TopicsTest } from './support.ts';

let test: TopicsTest;
afterEach(async () => {
  await test?.cleanup();
});

/** The report of `itemId` with one check that passed and one that failed. */
function withFailedCheck(itemId: string, outcome: 'complete' | 'partial'): string {
  return reportText(itemId, { outcome: 'complete' })
    .replace('- outcome: complete', `- outcome: ${outcome}`)
    .replace('- [x] `pnpm test`: all tests passed', '- [x] `pnpm test`: all tests passed\n- [!] `pnpm lint`: failed: 2 errors in src/cart.ts');
}

describe('0.7.0 D5: a report with a failed check', () => {
  it('cannot say complete: check_report and the end of the turn ask for a fix at the outcome line; the partial one is registered with the failed check', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, [{ id: 'a', title: 'Cart API' }]);
    await startPlan(test, topic.id);
    const item = itemOf(test.plan(topic.id), 'a');
    const sessionId = item.sessionId as string;
    const worktreeId = item.worktreeId as string;
    const sentence = 'A report with a failed check is not complete: set the outcome line to partial, or make the check pass and mark it "- [x]".';

    // complete + a failed check: the agent's own check says no, at the outcome line.
    await writeReport(test, topic.slug, 'a', worktreeId, withFailedCheck('a', 'complete'));
    expect(await checkReport(test, sessionId)).toEqual({ ok: false, errors: [{ line: 4, message: sentence }] });
    test.fakes.agents.edit(sessionId, { root: { kind: 'worktree', worktreeId }, path: topicReportPath(topic.slug, 'a') });
    test.fakes.agents.finishTurn(sessionId);
    const fixes = (): string[] => smurgSent(test, sessionId).filter((message) => message.purpose === 'fix-report').map((message) => message.text);
    await waitFor(() => fixes().length === 1, { what: 'fix-report' });
    expect(fixes()[0]).toBe(`smurg cannot use "specs/checkout/reports/a.md". Line 4: ${sentence} Fix exactly that and call check_report again.`);
    expect(test.t.ctx.services.reports.get(topic.id, 'a')).toBeNull();

    // The agent fixes it: partial, the failed check stays.
    await writeReport(test, topic.slug, 'a', worktreeId, withFailedCheck('a', 'partial'));
    expect(await checkReport(test, sessionId)).toEqual({ ok: true });
    test.fakes.agents.edit(sessionId, { root: { kind: 'worktree', worktreeId }, path: topicReportPath(topic.slug, 'a') });
    test.fakes.agents.finishTurn(sessionId);
    await waitFor(() => test.t.ctx.services.reports.get(topic.id, 'a') !== null, { what: 'the fixed report to be registered' });
    const report = test.t.ctx.services.reports.get(topic.id, 'a');
    expect(report).toMatchObject({ outcome: 'partial', checks: { passed: 1, notVerified: 0, failed: 1 } });
    expect(report?.sections.verified).toEqual([
      { text: '`pnpm test`: all tests passed', passed: true },
      { text: '`pnpm lint`', passed: false, failed: true, note: '2 errors in src/cart.ts' },
    ]);
    expect(reportInfoSchema.safeParse(report).success).toBe(true);
    // The plan's summary of the item carries the count too.
    expect(itemOf(test.plan(topic.id), 'a').report).toMatchObject({ outcome: 'partial', checks: { passed: 1, notVerified: 0, failed: 1 } });
    expect(fixes()).toHaveLength(1);
  });

  it('a report without a failed check is stored as 0.6.0 stored it (no `failed` count)', async () => {
    test = await setupTopics();
    const { topic } = await topicWithPlan(test, [{ id: 'a' }]);
    await startPlan(test, topic.id);
    const item = itemOf(test.plan(topic.id), 'a');
    await writeReport(test, topic.slug, 'a', item.worktreeId as string, reportText('a'));
    expect(await checkReport(test, item.sessionId as string)).toEqual({ ok: true });
    test.fakes.agents.edit(item.sessionId as string, { root: { kind: 'worktree', worktreeId: item.worktreeId as string }, path: topicReportPath(topic.slug, 'a') });
    test.fakes.agents.finishTurn(item.sessionId as string);
    await waitFor(() => test.t.ctx.services.reports.get(topic.id, 'a') !== null, { what: 'the report' });
    const report = test.t.ctx.services.reports.get(topic.id, 'a');
    expect(report?.checks).toEqual({ passed: 1, notVerified: 0 });
    expect(report?.sections.verified.every((check) => !('failed' in check))).toBe(true);
  });
});
