// What the 0.7.0 review found (W/review: safe, run), in the RELEASE composition with the stand-in `claude`
// (release-flow.support.ts), each case where the review showed smurg merging, deleting or hanging, now with what it
// does instead:
//
//   A   a restart of the host's smurg cuts the turn of a person's message to a done item's agent: the version it was
//       about is held for its carers (D6 row 6), nothing merges; "Continue" lets the agent finish, and that merges
//   A2  the same with a follow-up from the report: the item does not wait for an answer that cannot come any more
//   B   the agent changes a file after its check_report in the same turn: smurg asks it once to verify again first
//   B2  a restart cuts a turn after its check_report: the version is registered, not as checked in its turn, so the
//       agent is asked once to verify again before anything merges
//   D   an undo whose item's checkout holds a person's saved edit is refused until that work is dealt with (it was
//       deleted, unasked)
//   F7  a later turn of a merged item edits a file and is stopped: the item is held (the topic is not "ready" with
//       half of a change in the checkout); "Continue" makes it a version, which merges, and the topic is ready
//   X1  a follow-up turn of a merged item that changes nothing announces "Ready to check" once, not twice
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, type PlanInfo, type WorkItem } from '@smurg/protocol';
import type { FakeClaudeStep } from '../../src/testing/index.ts';
import { MEI, audited, inboxItem, refusal, startFlow, told, waitFor, type Flow } from './release-flow.support.ts';

const SLUG = 'checkout';
const SPEC_PATH = `specs/${SLUG}/SPEC.md`;
const PLAN_PATH = `specs/${SLUG}/PLAN.md`;
const reportPath = (id: string): string => `specs/${SLUG}/reports/${id}.md`;
const SPEC = ['# Checkout', '', '## Goal', 'Buying a book takes one page.', '', '## Decisions', '- Cards only.', '', '## Scope', 'Cart, receipt, page.', '', '## Out of scope', 'Invoices.', '', '## Behaviour', 'One page.', '', '## Open questions', 'None.', ''].join('\n');

interface PlanItemText {
  readonly id: string;
  readonly title: string;
  readonly touches: string;
  readonly dependsOn?: string;
}
const CART: PlanItemText = { id: 'cart-api', title: 'Cart API', touches: 'src/cart/**' };
const RECEIPT: PlanItemText = { id: 'receipt-email', title: 'Receipt email', touches: 'src/receipt/**' };
function planText(items: readonly PlanItemText[]): string {
  const body = items.flatMap((item, index) => [`### ${index + 1}. ${item.title}`, `- id: ${item.id}`, ...(item.dependsOn === undefined ? [] : [`- depends on: ${item.dependsOn}`]), '- size: m', `- touches: ${item.touches}`, '', `The ${item.title}.`, '']);
  return ['# Plan: Checkout', '', '<!-- smurg:plan v1 -->', '', ...body, '<!-- smurg:plan end -->', ''].join('\n');
}
function report(id: string, title: string, done = `The work of ${title}.`): string {
  return [`# Result report: ${title}`, '', `<!-- smurg:report v1 item=${id} -->`, '- outcome: complete', '', '## What was done', done, '', '## Why it was done this way', 'As the spec decided.', '', '## How it was verified', '- [x] `pnpm test`: 3 tests passed', '', '## What to watch out for', 'Nothing special.', ''].join('\n');
}
const PNPM_TEST: FakeClaudeStep = { tool: 'Bash', input: { command: 'pnpm test' }, result: '3 tests passed' };
const CHECK: FakeClaudeStep = { tool: 'mcp__smurg__check_report', input: {} };
const write = (path: string, content: string): FakeClaudeStep => ({ tool: 'Write', input: { file_path: path, content } });
const handIn = (id: string, title: string, done?: string): FakeClaudeStep[] => [PNPM_TEST, write(reportPath(id), report(id, title, done)), CHECK, { text: `${title} is done.` }];
/**
 * The turn `verify-again` starts: the agent runs its checks again and checks the same report (it changes nothing).
 * (0.7.0 verify: matched on the words both of its sentences have; after a restart it is told the restart is why)
 */
const VERIFIED = { match: 'after your report was last checked', steps: [PNPM_TEST, CHECK, { text: 'Verified again.' }] };
const UNATTENDED = { settings: { permissionMode: 'auto' as const, merging: 'auto' as const } };
const FILES = { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const title = "Bookshop";\n' };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const planOf = async (flow: Flow, topicId: string): Promise<PlanInfo> => (await flow.leo.conn.request('plan.get', { topicId })).plan as PlanInfo;
const itemOf = async (flow: Flow, topicId: string, id: string): Promise<WorkItem> => (await planOf(flow, topicId)).items.find((candidate) => candidate.id === id) as WorkItem;
async function itemIs(flow: Flow, topicId: string, id: string, fits: (item: WorkItem) => boolean, what: string, timeoutMs = 60_000): Promise<WorkItem> {
  await waitFor(async () => fits(await itemOf(flow, topicId, id)), { timeoutMs, what });
  return itemOf(flow, topicId, id);
}
const inMain = async (flow: Flow, path: string): Promise<string> => Buffer.from((await flow.ian.conn.request('file.read', { file: { root: MAIN_ROOT, path } })).content).toString('utf8');
const merges = async (flow: Flow): Promise<number> => (await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'ok').length;

/** Mei creates the topic, Ian writes its spec and plan, Mei is responsible for every item and presses Start. */
async function started(flow: Flow, items: readonly PlanItemText[]): Promise<string> {
  const created = await flow.mei.conn.request('topic.create', { name: 'Checkout' });
  const topicId = created.topic.id;
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: SPEC_PATH }, content: bytes(SPEC) });
  await flow.ian.conn.request('file.write', { file: { root: MAIN_ROOT, path: PLAN_PATH }, content: bytes(planText(items)) });
  await waitFor(async () => (await planOf(flow, topicId))?.items.length === items.length, { what: 'the plan to parse' });
  for (const item of items) await flow.mei.conn.request('plan.assign', { topicId, itemId: item.id, userId: MEI });
  const { preflight } = await flow.mei.conn.request('plan.preflight', { topicId });
  await flow.mei.conn.request('plan.start', { topicId, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash });
  return topicId;
}

/** The item is done and its plan paused (so that it waits); then Mei writes to its agent and the turn is under way when `restart()` comes. */
async function cutByARestart(flow: Flow, topicId: string, send: (sessionId: string) => Promise<void>): Promise<string> {
  await itemIs(flow, topicId, 'cart-api', (item) => item.state === 'done', 'item 1\'s report');
  const sessionId = (await itemOf(flow, topicId, 'cart-api')).sessionId as string;
  await flow.mei.watch(sessionId);
  const started = (): number => flow.mei.events(sessionId).filter((event) => event.kind === 'turn.started').length;
  const before = started();
  await send(sessionId);
  await waitFor(() => started() > before, { timeoutMs: 30_000, what: 'the turn of Mei\'s message to start' });
  await flow.mei.conn.request('plan.resume', { topicId });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect((await itemOf(flow, topicId, 'cart-api')).merged).toBeUndefined();
  await flow.restart();
  return sessionId;
}

describe('0.7.0 review: a restart never lets an item merge as if nobody had asked (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('A a person\'s message to a done item\'s agent cut by a restart: the version is held for its carers; "Continue" lets the agent finish, and that merges', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('cart-api', 'Cart API')] },
        // Mei's message: the agent starts changing the file and is still at it when smurg host stops.
        { match: 'must be in cents', once: true, steps: [write('src/cart/total.ts', 'export const total = 100; // cents, half done\n'), { sleep: 60_000 }, { text: 'never' }] },
        { match: 'Continue the work item', steps: [write('src/cart/total.ts', 'export const total = 100; // cents\n'), ...handIn('cart-api', 'Cart API', 'Totals in cents.')] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await started(flow, [CART]);
    await flow.mei.conn.request('plan.pause', { topicId });
    await cutByARestart(flow, topicId, async (sessionId) => {
      await flow.mei.conn.request('session.message.send', { sessionId, text: 'Wait, do not merge this: the totals must be in cents.' });
    });
    const held = await itemIs(flow, topicId, 'cart-api', (item) => item.autoMerge?.state === 'held', 'the version to be held');
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped', hostOnly: false });
    expect(held.merged).toBeUndefined();
    await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api', 'Mei\'s decision');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await merges(flow)).toBe(0);

    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await itemIs(flow, topicId, 'cart-api', (item) => item.merged?.by === 'smurg', 'smurg to merge what the agent finished');
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 100; // cents\n');
    expect(await merges(flow)).toBe(1);
  });

  it('A2 a follow-up from the report cut by a restart: no wait for an answer that cannot come; the version is held for its carers', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'must be in cents', steps: [write('src/cart/total.ts', 'export const total = 100; // cents, half done\n'), { sleep: 60_000 }, { text: 'never' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await started(flow, [CART]);
    await flow.mei.conn.request('plan.pause', { topicId });
    await cutByARestart(flow, topicId, async () => {
      await flow.mei.conn.request('report.followUp', { topicId, itemId: 'cart-api', text: 'Wait, do not merge this: the totals must be in cents.' });
    });
    // (a follow-up says "changes asked by Mei" from the moment it is sent: that is what the carers decide about)
    const held = await itemIs(flow, topicId, 'cart-api', (item) => item.autoMerge?.state === 'held', 'the version to be held');
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'asked', asked: { userId: MEI } });
    await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api', 'Mei\'s decision');
    // The follow-up is among the report's questions, without an answer, and nothing waits for one.
    const { report: info } = await flow.mei.conn.request('report.get', { topicId, itemId: 'cart-api' });
    expect(info?.questions.map((question) => [question.text, question.answer === undefined])).toEqual([['Wait, do not merge this: the totals must be in cents.', true]]);
    expect(await merges(flow)).toBe(0);
  });

  it('B2 a restart cuts a turn after its check_report: registered as not checked in its turn, the agent is asked once to verify again, and only that turn lets it merge', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        {
          match: 'Start work item 1 ',
          once: true,
          steps: [write('src/cart/total.ts', 'export const total = 1;\n'), PNPM_TEST, write(reportPath('cart-api'), report('cart-api', 'Cart API')), CHECK, write('src/app.ts', '// the agent went on after its report\n'), { sleep: 60_000 }, { text: 'never' }],
        },
        VERIFIED,
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await started(flow, [CART]);
    const running = await itemIs(flow, topicId, 'cart-api', (item) => item.state === 'running' && item.worktreeId !== undefined, 'item 1 to run');
    const worktree = { kind: 'worktree' as const, worktreeId: running.worktreeId as string };
    await waitFor(async () => {
      const read = await flow.ian.conn.request('file.read', { file: { root: worktree, path: 'src/app.ts' } }).catch(() => null);
      return read !== null && Buffer.from(read.content).toString('utf8').includes('went on');
    }, { timeoutMs: 30_000, what: 'the agent to write after its check' });
    await flow.restart();
    await itemIs(flow, topicId, 'cart-api', (item) => item.merged?.by === 'smurg', 'the merge after the agent verified again');
    const sessionId = running.sessionId as string;
    // (0.7.0 verify: smurg cannot tell after the restart what the cut turn changed after its check, and says so; it said
    // "You changed files", which was false of a turn that had changed nothing after it)
    expect((await told(flow, sessionId)).filter((text) => text.includes('smurg was restarted while you worked, and cannot tell what you changed after your report was last checked'))).toHaveLength(1);
    // The merge came after that turn: the version merged was checked in the turn that confirmed it.
    const verify = (await audited(flow, 'worktree.merge.auto')).filter((entry) => entry.outcome === 'ok');
    expect(verify).toHaveLength(1);
    expect(await inMain(flow, 'src/app.ts')).toBe('// the agent went on after its report\n');
  });
});

describe('0.7.0 review: what is merged was checked after the last change (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('B a change after check_report in the same turn: smurg asks the agent once to verify again, and merges only after that turn', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        {
          match: 'Start work item 1 ',
          steps: [write('src/cart/total.ts', 'export const total = 1;\n'), PNPM_TEST, write(reportPath('cart-api'), report('cart-api', 'Cart API')), CHECK, write('src/cart/total.ts', 'export const total = 2; // after the checks\n'), { text: 'Cart API is done.' }],
        },
        VERIFIED,
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await started(flow, [CART]);
    const merged = await itemIs(flow, topicId, 'cart-api', (item) => item.merged?.by === 'smurg', 'the merge after the agent verified again');
    expect((await told(flow, merged.sessionId as string)).filter((text) => text.includes('You changed files after your report was last checked'))).toHaveLength(1);
    expect(await inMain(flow, 'src/cart/total.ts')).toBe('export const total = 2; // after the checks\n');
  });
});

describe('0.7.0 review: an undo deletes nobody\'s work (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('D a person\'s saved edit in the undone item\'s checkout: the undo is not available until that work is dealt with, and the edit stays', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({ turns: [{ match: 'Start work item 1 ', steps: [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('cart-api', 'Cart API')] }, { steps: [{ text: 'ok' }] }] });
    const topicId = await started(flow, [CART]);
    const merged = await itemIs(flow, topicId, 'cart-api', (item) => item.merged?.by === 'smurg', 'smurg to merge item 1');
    const worktree = { kind: 'worktree' as const, worktreeId: merged.worktreeId as string };
    await flow.mei.conn.request('file.write', { file: { root: worktree, path: 'src/cart/NOTES.md' }, content: bytes('Mei: notes on the rounding rules.\n') });
    let preview: { ok: boolean; token: string; blockers: { unavailable: unknown } } | null = null;
    await waitFor(async () => {
      preview = (await flow.ian.conn.request('topic.undo.preview', { topicId, itemIds: ['cart-api'] })).preview;
      return preview.blockers.unavailable !== null;
    }, { timeoutMs: 20_000, what: 'the preview to see the saved edit' });
    expect(preview).toMatchObject({ ok: false, blockers: { unavailable: { text: { id: 'undo.unavailable.unmerged', params: { items: ['1 · Cart API'] } } } } });
    expect(await refusal(flow.ian.conn.request('topic.undo', { topicId, itemIds: ['cart-api'], token: (preview as unknown as { token: string }).token }))).toMatchObject({ code: 'conflict', reason: 'not-ok' });
    const read = await flow.mei.conn.request('file.read', { file: { root: worktree, path: 'src/cart/NOTES.md' } });
    expect(Buffer.from(read.content).toString('utf8')).toBe('Mei: notes on the rounding rules.\n');
    expect((await itemOf(flow, topicId, 'cart-api')).undone).toBeUndefined();
  });
});

describe('0.7.0 review: a merged item\'s later turn (release composition, stand-in claude)', { timeout: 300_000 }, () => {
  it('F7 a later turn edits a file and is stopped: the item is held, the topic is not ready; "Continue" makes the change a version, it merges, and the topic is ready', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Add a discount', once: true, steps: [write('src/cart/discount.ts', 'export const discount = 1;\n'), { sleep: 60_000 }, { text: 'never' }] },
        { match: 'Continue the work item', steps: [PNPM_TEST, CHECK, { text: 'The discount is done.' }] },
        VERIFIED,
        { steps: [{ text: 'ok' }] },
      ],
    });
    const topicId = await started(flow, [CART]);
    const merged = await itemIs(flow, topicId, 'cart-api', (item) => item.merged?.by === 'smurg', 'smurg to merge item 1');
    await waitFor(async () => flow.d.ctx.services.topics.get(topicId)?.phase === 'ready', { timeoutMs: 30_000, what: 'ready to check' });
    const sessionId = merged.sessionId as string;
    await flow.mei.watch(sessionId);
    await flow.mei.conn.request('session.message.send', { sessionId, text: 'Add a discount.' });
    await waitFor(() => flow.mei.events(sessionId).some((event) => event.kind === 'tool.finished'), { timeoutMs: 30_000, what: 'the later turn to write' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await flow.mei.conn.request('session.interrupt', { sessionId });
    const held = await itemIs(flow, topicId, 'cart-api', (item) => item.autoMerge?.state === 'held', 'the merged item to be held');
    expect(held.autoMerge).toMatchObject({ state: 'held', reason: 'stopped' });
    expect(flow.d.ctx.services.topics.get(topicId)?.phase).toBe('executing');
    await inboxItem(flow.mei, (entry) => entry.kind === 'decision' && entry.itemId === 'cart-api', 'Mei\'s decision');
    // "Merge it as it is" has no version to merge: the change is in the checkout only.
    expect(await refusal(flow.mei.conn.request('plan.item.release', { topicId, itemId: 'cart-api', version: 1 }))).toMatchObject({ code: 'conflict', reason: 'not-held' });

    await flow.mei.conn.request('plan.item.continue', { topicId, itemId: 'cart-api' });
    await waitFor(async () => (await inMain(flow, 'src/cart/discount.ts').catch(() => '')) === 'export const discount = 1;\n', { timeoutMs: 60_000, what: 'the discount to merge' });
    await waitFor(async () => flow.d.ctx.services.topics.get(topicId)?.phase === 'ready', { timeoutMs: 30_000, what: 'ready to check again' });
  });

  it('X1 a follow-up turn of a merged item that changes nothing: "Ready to check" is announced once for each time the topic becomes ready', async () => {
    const flow = await startFlow({ files: FILES, ...UNATTENDED });
    await flow.claude.setScenario({
      turns: [
        { match: 'Start work item 1 ', steps: [write('src/cart/total.ts', 'export const total = 1;\n'), ...handIn('cart-api', 'Cart API')] },
        { match: 'Start work item 2 ', steps: [write('src/receipt/send.ts', 'export const send = 1;\n'), ...handIn('receipt-email', 'Receipt email')] },
        { match: 'Why', steps: [{ sleep: 300 }, { text: 'Because the spec says so.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const phases: string[] = [];
    const listen = flow.d.ctx.bus.on('topic.changed', (event) => {
      if (event.topic.phase !== event.previous?.phase) phases.push(event.topic.phase);
    });
    try {
      const topicId = await started(flow, [CART, RECEIPT]);
      await waitFor(async () => flow.d.ctx.services.topics.get(topicId)?.phase === 'ready', { timeoutMs: 60_000, what: 'ready to check' });
      const sessionId = (await itemOf(flow, topicId, 'cart-api')).sessionId as string;
      for (let round = 0; round < 3; round += 1) {
        const before = phases.length;
        await flow.ian.conn.request('session.message.send', { sessionId, text: `Why is the total an integer? (${round})` });
        await waitFor(() => phases.length > before && phases.at(-1) === 'ready', { timeoutMs: 30_000, what: `ready again (${round})` });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const readies = phases.filter((phase) => phase === 'ready').length;
      // Once at the end of the plan, then once after each of the three follow-ups: never twice in a row.
      expect(readies).toBe(4);
      expect(phases.slice(phases.indexOf('ready'))).toEqual(['ready', 'executing', 'ready', 'executing', 'ready', 'executing', 'ready']);
    } finally {
      listen.dispose();
    }
  });
});
