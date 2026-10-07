// The release composition, what becomes of ONE work item after its first merge (DESIGN §4.5 "After the merge",
// "Failure and retry", "After a restart"): the real topics, conversation, inbox, worktree and agent-runtime modules on
// a real git repository, with the stand-in `claude` (release-flow.support.ts). Ian is the host, Mei has agent access,
// Leo is a Viewer. Every step is asserted from what they RECEIVE and from the files and git.
//
// What only this composition proves: that finishing an item (its session ends, its worktree is deleted) never takes
// work with it that the main workspace does not have, with the real worktree module answering what a worktree holds.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanInfo } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { MEI, audited, inboxItem, inboxWithout, permissionAt, refusal, startFlow, statusIs, statuses, told, turnsFinished, waitFor, type Flow, type Person } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const REPORT_PATH = `specs/${SLUG}/reports/cart-api.md`;
const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Open questions', 'None.', ''].join('\n');
const PLAN = ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', '### 1. Cart API', '- id: cart-api', '', 'The cart.', '', '<!-- smurg:plan end -->', ''].join('\n');

function report(done: string): string {
  return ['# Result report: Cart API', '', '<!-- smurg:report v1 item=cart-api -->', '- outcome: complete', '', '## What was done', done, '', '## Why it was done this way', 'As the spec decided.', '', '## How it was verified', '- [x] `pnpm test`: 3 tests passed', '', '## What to watch out for', 'Nothing special.', ''].join('\n');
}

const handIn = (done: string): FakeClaudeStep[] => [{ tool: 'Write', input: { file_path: REPORT_PATH, content: report(done) } }, { tool: 'mcp__smurg__check_report', input: {} }, { text: 'Done.' }];

const lastPlan = (member: Person, topicId: string): PlanInfo | undefined => member.got('plan.updated').filter((update) => update.plan.topicId === topicId).at(-1)?.plan;
async function planIs(member: Person, topicId: string, fits: (plan: PlanInfo) => boolean, what: string): Promise<PlanInfo> {
  await waitFor(() => { const plan = lastPlan(member, topicId); return plan !== undefined && fits(plan); }, { timeoutMs: 30_000, what: `${what}, as ${member.name} is told` });
  return lastPlan(member, topicId) as PlanInfo;
}
const cart = (plan: PlanInfo | undefined) => plan?.items.find((item) => item.id === 'cart-api');
const inMain = (flow: Flow, path: string): Promise<string | null> => readFile(join(flow.root, path), 'utf8').catch(() => null);

/** A topic with the one-item plan, started by Mei, who is responsible for the item. Returns when its first report is in. */
async function startedItem(flow: Flow): Promise<{ topicId: string; sessionId: string; worktreeId: string; draft: string }> {
  const { mei, leo } = flow;
  const created = await mei.conn.request('topic.create', { name: 'Checkout', firstMessage: 'We want the checkout on one page.' });
  const topicId = created.topic.id;
  await leo.watch(created.session.id);
  await turnsFinished(leo, created.session.id, 1);
  await statusIs(leo, created.session.id, 'idle');
  await mei.conn.request('plan.generate', { topicId });
  await planIs(leo, topicId, (plan) => plan.items.length === 1, 'the plan');
  await turnsFinished(leo, created.session.id, 2);
  await mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: MEI });
  const { preflight } = await mei.conn.request('plan.preflight', { topicId });
  expect(preflight).toMatchObject({ startsNow: ['cart-api'], blockers: [] });
  await mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
  const done = await planIs(leo, topicId, (plan) => cart(plan)?.state === 'done' && cart(plan)?.merge?.status === 'draft', 'the first report with its draft');
  const item = cart(done);
  await leo.watch(item?.sessionId as string);
  return { topicId, sessionId: item?.sessionId as string, worktreeId: item?.worktreeId as string, draft: item?.merge?.requestId as string };
}

describe('the release composition: a work item whose first change the host merged before anyone reviewed it', { timeout: 240_000 }, () => {
  it('a follow-up after that merge makes a second version with a draft of its own: "I\'ve reviewed this" removes nothing of it, and merging that draft finishes the item', async () => {
    const flow = await startFlow({ files: { 'README.md': '# Bookshop\n' } });
    await flow.claude.setScenario({
      turns: [
        { match: 'one page', once: true, steps: [{ tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } }, { text: 'The first draft of the spec is ready.' }] },
        { match: 'Then call check_plan', steps: [{ tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'One item.' }] },
        { match: 'Start work item 1 ', steps: [{ tool: 'Write', input: { file_path: 'src/cart/total.ts', content: 'export const total = 1;\n' } }, ...handIn('The total.')] },
        { match: 'empty carts', steps: [{ tool: 'Write', input: { file_path: 'src/cart/empty.ts', content: 'export const empty = true;\n' } }, ...handIn('The total, and empty carts.')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { ian, mei, leo } = flow;
    const { topicId, sessionId, worktreeId, draft } = await startedItem(flow);

    // ---- the host approves the draft directly, before anyone reviewed: allowed; what depends on the item may start
    expect((await ian.conn.request('worktree.merge.approve', { requestId: draft })).request).toMatchObject({ id: draft, status: 'merged' });
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 1;\n');
    await planIs(leo, topicId, (plan) => cart(plan)?.merge?.status === 'merged', 'the merge of the first draft');
    expect(statuses(leo, sessionId).at(-1)).not.toBe('ended');

    // ---- Mei asks for more from the report: the agent changes more code and hands in version 2, with a NEW draft
    await mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Please also handle empty carts.' });
    const second = await planIs(leo, topicId, (plan) => cart(plan)?.report?.version === 2 && cart(plan)?.merge?.status === 'draft', 'version 2 with its draft');
    const draft2 = cart(second)?.merge?.requestId as string;
    expect(draft2).not.toBe(draft);
    expect(cart(second)).toMatchObject({ report: { version: 2, state: 'to-review' }, merge: { requestId: draft2, status: 'draft', ready: false } });
    const worktreeRoot = flow.d.ctx.roots.get({ kind: 'worktree', worktreeId })?.realPath as string;
    expect(await readFile(join(worktreeRoot, 'src/cart/empty.ts'), 'utf8')).toBe('export const empty = true;\n');
    expect(await inMain(flow, 'src/cart/empty.ts')).toBeNull();

    // ---- "I've reviewed this" on version 2. Its work is not in the main workspace: nothing of it may go.
    expect((await mei.conn.request('report.review', { topicId, itemId: 'cart-api', version: 2 })).report).toMatchObject({ state: 'reviewed', review: { version: 2 } });
    // The reviewed draft is in the host's inbox by itself (this is also where the test waits for the daemon to settle).
    expect(await inboxItem(ian, (item) => item.kind === 'merge' && item.key === `merge:${draft2}`, 'the second change to merge')).toMatchObject({ ready: true, topicId, itemId: 'cart-api' });
    expect(cart(await planIs(leo, topicId, (plan) => cart(plan)?.merge?.ready === true, 'the reviewed draft'))).toMatchObject({ state: 'reviewed', worktreeId, merge: { requestId: draft2, status: 'draft', ready: true } });
    expect(statuses(leo, sessionId).at(-1)).not.toBe('ended');
    expect((await leo.conn.request('session.list', { topicId })).sessions.find((session) => session.id === sessionId)?.status).not.toBe('ended');
    expect((await leo.conn.request('worktree.list', {})).worktrees.map((worktree) => worktree.id)).toEqual([worktreeId]);
    expect(leo.got('worktree.removed')).toEqual([]);
    expect(await readFile(join(worktreeRoot, 'src/cart/empty.ts'), 'utf8')).toBe('export const empty = true;\n');
    expect((await ian.conn.request('worktree.merge.list', {})).requests.find((request) => request.id === draft2)).toMatchObject({ status: 'draft', reviewed: true });
    // The item is not finished, so its session still answers a follow-up.
    expect(await refusal(mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Thanks.' }))).toBeNull();
    await turnsFinished(leo, sessionId, 3);

    // ---- the host merges the second draft: now the main workspace has all of it and the item is finished
    expect((await ian.conn.request('worktree.merge.approve', { requestId: draft2 })).request).toMatchObject({ id: draft2, status: 'merged' });
    expect(await inMain(flow, 'src/cart/empty.ts')).toBe('export const empty = true;\n');
    expect(await inMain(flow, REPORT_PATH)).toBe(report('The total, and empty carts.'));
    await inboxWithout(ian, (item) => item.kind === 'merge', 'the merged change');
    await statusIs(leo, sessionId, 'ended');
    expect((await leo.conn.request('session.list', { topicId })).sessions.find((session) => session.id === sessionId)).toMatchObject({ status: 'ended', endReason: 'merged' });
    await waitFor(() => leo.got('worktree.removed').some((update) => update.worktreeId === worktreeId), { timeoutMs: 30_000, what: "the finished item's worktree to go" });
    expect(cart(await planIs(leo, topicId, (plan) => cart(plan)?.worktreeId === undefined, 'the finished item'))).toMatchObject({ state: 'reviewed', merge: { requestId: draft2, status: 'merged' } });
    expect(await refusal(mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'One more thing' }))).toMatchObject({ code: 'conflict', reason: 'closed' });
  });
});

describe('the release composition: a work item whose process died before the host restarted smurg', { timeout: 240_000 }, () => {
  it('is still failed after the restart, stays so when its idle session is renamed along with the topic, and "Try again" continues the same session', async () => {
    const flow = await startFlow({ files: { 'README.md': '# Bookshop\n' } });
    const turns = (onContinue: FakeClaudeStep[]) => ({
      turns: [
        { match: 'one page', once: true, steps: [{ tool: 'Write', input: { file_path: SPEC_PATH, content: SPEC } }, { text: 'The first draft of the spec is ready.' }] },
        { match: 'Then call check_plan', steps: [{ tool: 'Write', input: { file_path: PLAN_PATH, content: PLAN } }, { tool: 'mcp__smurg__check_plan', input: {} }, { text: 'One item.' }] },
        // The item wants to run a command and waits for a person; its process is killed while it waits.
        { match: 'Start work item 1 ', steps: [{ tool: 'Bash', input: { command: 'pnpm build' } }, { text: 'never said' }] },
        { match: 'Continue the work item', steps: onContinue },
        { steps: [{ text: 'ok' }] },
      ],
    });
    await flow.claude.setScenario(turns(handIn('The total.')));
    const created = await flow.mei.conn.request('topic.create', { name: 'Checkout', firstMessage: 'We want the checkout on one page.' });
    const topicId = created.topic.id;
    await flow.leo.watch(created.session.id);
    await turnsFinished(flow.leo, created.session.id, 1);
    await statusIs(flow.leo, created.session.id, 'idle');
    await flow.mei.conn.request('plan.generate', { topicId });
    await planIs(flow.leo, topicId, (plan) => plan.items.length === 1, 'the plan');
    await turnsFinished(flow.leo, created.session.id, 2);
    await flow.mei.conn.request('plan.assign', { topicId, itemId: 'cart-api', userId: MEI });
    const { preflight } = await flow.mei.conn.request('plan.preflight', { topicId });
    const started = (await flow.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash })).plan;
    const sessionId = cart(started)?.sessionId as string;
    await flow.leo.watch(sessionId);
    await permissionAt(flow.leo, (request) => request.sessionId === sessionId && request.status === 'open', 'the command of the work item');

    // ---- the process dies; nobody presses "Try again" before the host restarts smurg
    expect(await flow.killProcessOf(sessionId)).toBe(1);
    await statusIs(flow.leo, sessionId, 'failed');
    await planIs(flow.leo, topicId, (plan) => cart(plan)?.state === 'failed', 'the failed item');
    await inboxItem(flow.mei, (item) => item.kind === 'attention' && item.subject === 'item-failed', 'the failed item');
    await flow.restart();
    const { mei, leo } = flow;

    // ---- afterwards the session is merely idle (nothing restarts by itself); the item still says what happened
    expect((await leo.conn.request('session.list', { topicId })).sessions.find((session) => session.id === sessionId)).toMatchObject({ status: 'idle' });
    expect(cart((await leo.conn.request('plan.get', { topicId })).plan ?? undefined)).toMatchObject({ state: 'failed', sessionId, attempt: 1 });
    const failedItem = await inboxItem(mei, (item) => item.kind === 'attention' && item.subject === 'item-failed', 'the failed item, after the restart');
    expect(failedItem).toMatchObject({ waiting: true, topicId, itemId: 'cart-api', sessionId });
    // Renaming the topic relabels the item's session: an update of a session that works on nothing.
    await mei.conn.request('topic.rename', { topicId, name: 'Checkout redesign' });
    await waitFor(async () => (await leo.conn.request('session.list', { topicId })).sessions.some((session) => session.id === sessionId && session.kind === 'agent' && session.topicName === 'Checkout redesign'), { what: 'the renamed session' });
    expect(cart((await leo.conn.request('plan.get', { topicId })).plan ?? undefined)).toMatchObject({ state: 'failed' });
    expect((await mei.inbox()).some((item) => item.key === failedItem.key)).toBe(true);

    // ---- "Try again", pressed in the session's own column (`session.retry`; for a work item it is the plan's
    // `plan.item.retry`): accepted, the same session and attempt, and the agent is told to go on
    await leo.watch(sessionId);
    expect(await refusal(leo.conn.request('session.retry', { sessionId }))).toMatchObject({ code: 'forbidden' });
    expect((await mei.conn.request('session.retry', { sessionId })).session).toMatchObject({ id: sessionId, purpose: 'item', itemId: 'cart-api' });
    expect(cart(await planIs(leo, topicId, (plan) => cart(plan)?.state !== 'failed', 'the item going on'))).toMatchObject({ sessionId, attempt: 1 });
    await planIs(leo, topicId, (plan) => cart(plan)?.state === 'done', 'the item done');
    expect((await told(flow, sessionId)).at(-1)?.replace(/^\[smurg [a-z0-9]{4}\]\n/, '')).toBe('Continue the work item where you stopped. Finish with the result report.');
    await inboxWithout(mei, (item) => item.key === failedItem.key, 'the item that went on');
    expect((await audited(flow, 'plan.item.retry')).map((entry) => entry.detail)).toMatchObject([{ topicId, itemId: 'cart-api', was: 'failed', attempt: 1 }]);
    // The process was started by the message, not by a "retry" of a session that had not failed.
    expect(await audited(flow, 'session.retry')).toEqual([]);
  });
});
