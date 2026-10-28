// The check of bb6c323 (W/verify/last5/hold, C1-C3; fix6), in the RELEASE composition with the stand-in `claude`
// (release-flow.support.ts): a later turn of a MERGED item that does not finish, the setting turned to 'host' over an
// escalated hold, and a turn that never ends.
//
//   V16 the turn that answers Mei's message to a merged item (reviewed while it runs) is cut by a restart, ends on an
//       API error, loses its process, or Mei stops it; smurg merging, and the host merging each item. The item was not
//       held, the topic said ready (and complete, once reviewed), the session was ended 'merged', the continue D15 owes
//       never came, and the answer was lost with nobody told. Now: held for its carers (or, while smurg continues it by
//       itself, waited for), the topic is not ready, the check is refused and the session stays; the continue or
//       Continue goes on with the turn, its version merges, and the topic is ready and checked. After a Stop, Continue's
//       completed turn with nothing new settles the topic, and the check finishes the item. (A kill -9 of the daemon in
//       that turn: test/topics/scheduler.test.ts, "after a restart: what a hard death ... left out of step".)
//   V17 the host turns merging to 'host' over a merged item's escalated hold for a message a restart left undelivered:
//       the hold stays as it was (its time, its escalation, the host's row), said and audited once (it was stored anew:
//       the row left the host, and the line and the audit came twice)
//   (C3) while a merged item's agent is in a turn that does not end, "I've checked the result" is refused naming it
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type PlanInfo, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { MEI, audited, inboxItem, refusal, startFlow, waitFor, type Flow } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const REPORT_PATH = `specs/${SLUG}/reports/cart-api.md`;
const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Decisions', '- Cards only.', '', '## Scope', 'Cart, receipt, page.', '', '## Out of scope', 'Invoices.', '', '## Behaviour', 'One page.', '', '## Open questions', 'None.', ''].join('\n');
const PLAN = ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', '### 1. Cart API', '- id: cart-api', '- size: m', '- touches: src/cart/**', '', 'The Cart API.', '', '<!-- smurg:plan end -->', ''].join('\n');
function report(done: string): string {
  return ['# Result report: Cart API', '', '<!-- smurg:report v1 item=cart-api -->', '- outcome: complete', '', '## What was done', done, '', '## Why it was done this way', 'As the spec decided.', '', '## How it was verified', '- [x] `pnpm test`: 3 tests passed', '', '## What to watch out for', 'Nothing special.', ''].join('\n');
}
const write = (path: string, content: string): FakeClaudeStep => ({ tool: 'Write', input: { file_path: path, content } });
const handIn = (done: string): FakeClaudeStep[] => [{ tool: 'Bash', input: { command: 'pnpm test' }, result: '3 tests passed' }, write(REPORT_PATH, report(done)), { tool: 'mcp__smurg__check_report', input: {} }, { text: 'Cart API is done.' }];
const FIRST = { match: 'Start work item 1 ', steps: [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('The work of Cart API.')] };
const CENTS_TEXT = 'export const total = 100; // cents\n';
/** What the agent does when it goes on with Mei's message: the totals in cents, a new version. */
const ANSWER: FakeClaudeStep[] = [write('src/cart/total.ts', CENTS_TEXT), ...handIn('Totals in cents.')];
const OBJECTION = 'Wait, do not merge this: the totals must be in cents.';
const FILES = { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const title = "Bookshop";\n' };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const planOf = async (flow: Flow, topicId: string): Promise<PlanInfo> => (await flow.leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
const itemOf = async (flow: Flow, topicId: string): Promise<WorkItem> => (await planOf(flow, topicId)).items.find((candidate) => candidate.id === 'cart-api') as WorkItem;
async function itemIs(flow: Flow, topicId: string, fits: (item: WorkItem) => boolean, what: string, timeoutMs = 60_000): Promise<WorkItem> {
  await waitFor(async () => fits(await itemOf(flow, topicId)), { timeoutMs, what });
  return itemOf(flow, topicId);
}
const inMain = async (flow: Flow, path: string): Promise<string> => Buffer.from((await flow.ian.conn.request('file.read', { file: { root: MAIN_ROOT, path } })).content).toString('utf8');
const phaseOf = (flow: Flow, topicId: string): string | undefined => flow.d.ctx.services.topics.get(topicId)?.phase;
const statusOf = (flow: Flow, sessionId: string): string | undefined => flow.d.ctx.services.agents.get(sessionId)?.status;
const lineIds = async (flow: Flow, sessionId: string): Promise<string[]> => (await flow.ian.conn.request('session.watch', { sessionId })).events.flatMap((event) => (event.kind === 'line' ? [event.text.id] : []));

/** Mei creates the topic, Ian writes its spec and its one-item plan, Mei is responsible for the item and presses Start. */
async function started(flow: Flow): Promise<string> {
  const created = await flow.mei.conn.request('topic.create', { name: 'Checkout' });
  const topicId = created.topic.id;
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes(SPEC) });
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: PLAN_PATH }, content: bytes(PLAN) });
  await waitFor(async () => (await planOf(flow, topicId))?.items.length === 1, { what: 'the plan to parse' });
  await flow.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: MEI });
  const { preflight } = await flow.mei.conn.request('plan.preflight', { topicId });
  await flow.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
  return topicId;
}

/** Started; version 1 merged (by smurg, or by the host's Merge…); its agent's process parked. */
async function merged(flow: Flow, merging: 'auto' | 'host'): Promise<{ topicId: string; sessionId: string }> {
  const topicId = await started(flow);
  const done = await itemIs(flow, topicId, (item) => item.state === 'done' && item.merge !== undefined, 'item 1\'s report');
  if (merging === 'host') await flow.ian.conn.request('worktree.merge.approve', { requestId: done.merge?.requestId as string });
  await itemIs(flow, topicId, (item) => item.merged !== undefined && (merging === 'auto' ? item.merged.by === 'smurg' : item.merged.by !== 'smurg'), 'version 1 to merge');
  await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
  const sessionId = done.sessionId as string;
  await waitFor(() => flow.d.ctx.services.agents.facts(sessionId)?.hasProcess === false, { timeoutMs: 30_000, what: 'the merged item\'s process to be parked' });
  return { topicId, sessionId };
}

/** Mei writes to the merged item's agent; while its turn runs she reviews version 1 (on bb6c323 the review then ended the session). */
async function messageAndReview(flow: Flow, topicId: string, sessionId: string): Promise<void> {
  await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
  await waitFor(() => statusOf(flow, sessionId) === 'running', { timeoutMs: 20_000, what: 'the turn of Mei\'s message' });
  await flow.mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 1 });
}

/** Nothing of it settles: the topic is not ready, the check is refused, and its session stays. */
async function notSettled(flow: Flow, topicId: string, sessionId: string): Promise<void> {
  // (the module's sweep asks again every few seconds whether the item is finished)
  await sleep(1_500);
  expect(phaseOf(flow, topicId)).toBe('executing');
  expect(await refusal(flow.mei.conn.request('topic.check', { topicId }))).toMatchObject({ code: 'conflict', reason: 'not-ready' });
  expect(statusOf(flow, sessionId)).not.toBe('ended');
  expect(flow.d.ctx.services.agents.get(sessionId)?.endReason).toBeUndefined();
}

/** Held for its carers ("its last turn did not finish"): Mei's decision, whose answer is Continue. */
async function heldForCarers(flow: Flow, topicId: string): Promise<void> {
  const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'the merged item to be held for its carers', 30_000);
  expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped' });
  expect(held.autoMerge?.undelivered).toBeUndefined();
  await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'Mei\'s decision');
}

/** What Mei asked for becomes version 2 and merges (by smurg, or by the host's Merge… of it); the topic is ready, and checked. */
async function answerMerges(flow: Flow, topicId: string, merging: 'auto' | 'host'): Promise<void> {
  const two = await itemIs(flow, topicId, (item) => item.report?.version === 2, 'the version of Mei\'s message', 60_000);
  if (merging === 'host') {
    expect(two.merge?.status).toBe('draft');
    await flow.ian.conn.request('worktree.merge.approve', { requestId: two.merge?.requestId as string });
  }
  await waitFor(async () => (await inMain(flow, 'src/cart/total.ts').catch(() => '')) === CENTS_TEXT, { timeoutMs: 60_000, what: 'the merge of what Mei asked for' });
  await waitFor(() => phaseOf(flow, topicId) === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
  await flow.mei.conn.request('topic.check', { topicId });
  expect(phaseOf(flow, topicId)).toBe('complete');
}

const STORIES = {
  restart: [{ sleep: 60_000 }, ...ANSWER],
  error: [{ thinking: true as const, ms: 1_500 }, { text: 'API Error: overloaded', apiError: 'overloaded' }, { result: { subtype: 'success', is_error: true, terminal_reason: 'api_error' } }],
  exit: [{ thinking: true as const, ms: 1_500 }, { exit: 3, stderr: 'boom' }],
} satisfies Record<string, FakeClaudeStep[]>;

describe('0.7.0 fix6: a later turn of a merged item that does not finish keeps it open (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  for (const merging of ['auto', 'host'] as const) {
    const who = merging === 'auto' ? 'smurg merges' : 'the host merges each item';

    it(`V16 ${who}: a restart cuts the turn that answers Mei's message to a merged item, reviewed meanwhile: held for its carers, the topic not ready, the session kept; Continue goes on, and its version merges`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: STORIES.restart }, { match: 'Continue the work item', steps: ANSWER }, { steps: [{ text: 'ok' }] }] });
      const { topicId, sessionId } = await merged(flow, merging);
      await messageAndReview(flow, topicId, sessionId);
      await flow.restart();
      await heldForCarers(flow, topicId);
      await notSettled(flow, topicId, sessionId);
      await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
      await answerMerges(flow, topicId, merging);
    });

    for (const story of ['error', 'exit'] as const) {
      it(`V16 ${who}: the turn that answers Mei's message to a merged item, reviewed meanwhile, ${story === 'error' ? 'ends on an API error' : 'loses its process'}: the topic not ready and the session kept while smurg's continue is to come; a minute later it comes, and its version merges`, async () => {
        const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
        await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: STORIES[story] }, { match: 'Continue the work item', steps: ANSWER }, { steps: [{ text: 'ok' }] }] });
        const { topicId, sessionId } = await merged(flow, merging);
        await messageAndReview(flow, topicId, sessionId);
        await waitFor(() => statusOf(flow, sessionId) !== 'running', { timeoutMs: 30_000, what: 'the turn to break' });
        await notSettled(flow, topicId, sessionId);
        // (smurg continues it by itself: nobody is asked meanwhile; smurg's item shows that it waits for its agent)
        const waiting = await itemOf(flow, topicId);
        if (merging === 'auto') expect(waiting.autoMerge).toMatchObject({ state: 'waiting', reason: 'busy' });
        else expect(waiting.autoMerge).toBeUndefined();
        expect((await flow.mei.inbox()).some((entry) => entry.kind === 'decision')).toBe(false);
        flow.advance(61_000);
        await waitFor(async () => (await lineIds(flow, sessionId)).includes(story === 'error' ? 'conversation.continued.error' : 'conversation.continued.crash'), { timeoutMs: 30_000, what: 'smurg\'s continue' });
        await answerMerges(flow, topicId, merging);
      });
    }

    it(`V16 ${who}: Mei stops the turn that answers her message to a merged item, a turn that does not end by itself: the check names the item while it runs; then held for its carers, the session kept; Continue's turn changes nothing, and the topic is ready, checked, and the item finished`, async () => {
      const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging }, agents: { parkAfterMs: 1_000 } });
      await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: [{ wait: 'interrupt' }, ...ANSWER] }, { match: 'Continue the work item', steps: [{ text: 'The totals stay as they are.' }] }, { steps: [{ text: 'ok' }] }] });
      const { topicId, sessionId } = await merged(flow, merging);
      await messageAndReview(flow, topicId, sessionId);
      // C3: a turn that does not end is shown nowhere else; the check's refusal names the item whose agent is at work.
      await sleep(1_500);
      expect(await refusal(flow.mei.conn.request('topic.check', { topicId }))).toMatchObject({ code: 'conflict', reason: 'not-ready', message: 'This topic is not ready to check yet: the agent of work item 1 is still at work.' });
      await flow.mei.conn.request('session.interrupt', { sessionId });
      await heldForCarers(flow, topicId);
      await notSettled(flow, topicId, sessionId);
      await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
      await itemIs(flow, topicId, (item) => item.autoMerge === undefined, 'the hold to end after Continue\'s turn');
      expect((await itemOf(flow, topicId)).report?.version).toBe(1);
      // Reviewed, and nothing of it in progress any more: the topic is complete, and the item is finished.
      await waitFor(() => phaseOf(flow, topicId) === 'complete', { timeoutMs: 30_000, what: 'the topic to be complete' });
      await waitFor(() => statusOf(flow, sessionId) === 'ended', { timeoutMs: 30_000, what: 'the item to finish' });
      expect(flow.d.ctx.services.agents.get(sessionId)?.endReason).toBe('merged');
      expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 1;\n');
    });
  }

  it('V17 the host turns merging to \'host\' over a merged item\'s escalated hold for a message a restart left undelivered: the hold, its time, its escalation and the host\'s row stay, said and audited once; Continue delivers the message, and the host merges its version', async () => {
    const flow = await startFlow({ files: FILES, settings: { permissionMode: 'auto', merging: 'auto', escalateAfterMs: 60_000 }, agents: { parkAfterMs: 1_000 } });
    await flow.claude.setScenario({ turns: [FIRST, { match: 'must be in cents', steps: ANSWER }, { steps: [{ text: 'ok' }] }] });
    const { topicId, sessionId } = await merged(flow, 'auto');
    await flow.mei.conn.request('session.message.send', { sessionId, text: OBJECTION });
    await flow.restart();
    const held = await itemIs(flow, topicId, (item) => item.autoMerge?.state === 'held', 'the merged item to be held for the message', 30_000);
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true, escalated: false });
    flow.advance(61_000);
    await itemIs(flow, topicId, (item) => item.autoMerge?.escalated === true, 'the hold to reach the host and the members with agent access', 30_000);
    await inboxItem(flow.ian, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting, 'the host\'s row');
    const since = (await itemOf(flow, topicId)).autoMerge?.since;
    await flow.ian.conn.request('admin.settings.set', { merging: 'host' });
    await itemIs(flow, topicId, (item) => item.merging === 'host', 'the item to be the host\'s to merge', 10_000);
    // (a pass of the merge queue runs on the change, and the sweep after it)
    await sleep(2_000);
    const after = await itemOf(flow, topicId);
    expect(after.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', undelivered: true, escalated: true, since });
    expect((await flow.ian.inbox()).some((entry) => entry.kind === 'decision' && entry.itemId === 'cart-api' && entry.waiting)).toBe(true);
    expect((await planOf(flow, topicId)).waitingFor.map((entry) => entry.user.userId).sort()).toEqual([flow.ian.userId, MEI].sort());
    expect((await audited(flow, 'worktree.merge.held')).length).toBe(1);
    expect((await lineIds(flow, sessionId)).filter((id) => id === 'conversation.heldLater')).toHaveLength(1);
    expect(phaseOf(flow, topicId)).toBe('executing');
    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await answerMerges(flow, topicId, 'host');
  });
});
